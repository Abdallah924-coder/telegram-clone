const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling']
});

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
const AVATARS_DIR = process.env.AVATARS_DIR || path.join(__dirname, 'public', 'avatars');
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
    }
    return { users: [], messages: [], groups: [], statuses: [] };
}

let persistentUsers = {};
let messages = [];
let groups = [];
let statuses = [];
let socketUsers = {};

function ensureUserDefaults(user) {
    user.bio = user.bio || '';
    user.online = !!user.online;
    user.blockedUsers = Array.isArray(user.blockedUsers) ? user.blockedUsers : [];
    user.hiddenChats = user.hiddenChats && typeof user.hiddenChats === 'object' ? user.hiddenChats : {};
    user.ephemeralSettings = user.ephemeralSettings && typeof user.ephemeralSettings === 'object' ? user.ephemeralSettings : {};
    return user;
}

function isExpired(iso) {
    return !!iso && new Date(iso).getTime() <= Date.now();
}

function saveData() {
    const data = {
        users: Object.values(persistentUsers).map(ensureUserDefaults),
        messages,
        groups,
        statuses
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function conversationKeyForMessage(msg, userPseudo) {
    if (msg.type === 'private') {
        const other = msg.from === userPseudo ? msg.to : msg.from;
        return `private:${other}`;
    }
    return `group:${msg.groupId}`;
}

function messageVisibleForUser(msg, userPseudo) {
    if (isExpired(msg.expiresAt)) return false;
    if (
        msg.type === 'private' &&
        !(msg.from === userPseudo || msg.to === userPseudo)
    ) return false;
    if (
        msg.type === 'group' &&
        !groups.find(g => g.id === msg.groupId)?.members.includes(userPseudo)
    ) return false;

    const user = persistentUsers[userPseudo];
    const hiddenChats = user?.hiddenChats || {};
    const cutoff = hiddenChats[conversationKeyForMessage(msg, userPseudo)];
    if (cutoff && new Date(msg.date).getTime() <= new Date(cutoff).getTime()) return false;

    return true;
}

function activeStatusesForViewer(viewerPseudo) {
    return statuses
        .filter(status => !isExpired(status.expiresAt))
        .map(status => safeStatus(status, viewerPseudo));
}

function cleanupExpiredMessages(notify = false) {
    const expired = messages.filter(msg => isExpired(msg.expiresAt));
    if (!expired.length) return;
    messages = messages.filter(msg => !isExpired(msg.expiresAt));
    saveData();

    if (notify) {
        expired.forEach(msg => {
            _broadcastToMessageParticipants(msg, 'message-expired', { messageId: msg.id });
        });
    }
}

function cleanupExpiredStatuses(notify = false) {
    const hadExpired = statuses.some(status => isExpired(status.expiresAt));
    if (!hadExpired) return;
    statuses = statuses.filter(status => !isExpired(status.expiresAt));
    saveData();
    if (notify) broadcastStatuses();
}

function safeUser(user) {
    return {
        pseudo: user.pseudo,
        avatar: user.avatar,
        bio: user.bio || '',
        online: user.online || false,
        lastSeen: user.lastSeen,
        createdAt: user.createdAt
    };
}

function selfUserPayload(user) {
    return {
        ...safeUser(user),
        blockedUsers: user.blockedUsers || [],
        hiddenChats: user.hiddenChats || {},
        ephemeralSettings: user.ephemeralSettings || {}
    };
}

function safeStatus(status, viewerPseudo) {
    return {
        id: status.id,
        userPseudo: status.userPseudo,
        userAvatar: persistentUsers[status.userPseudo]?.avatar || '',
        text: status.text || '',
        mediaUrl: status.mediaUrl || null,
        fileType: status.fileType || null,
        fileName: status.fileName || null,
        createdAt: status.createdAt,
        expiresAt: status.expiresAt,
        viewed: !!viewerPseudo && status.viewedBy?.includes(viewerPseudo),
        viewedByCount: status.viewedBy?.length || 0
    };
}

function _getSocketId(pseudo) {
    return Object.keys(socketUsers).find(sid => socketUsers[sid] === pseudo);
}

function _broadcastToMessageParticipants(msg, event, data) {
    const recipients = new Set();
    if (msg.type === 'private') {
        recipients.add(msg.from);
        recipients.add(msg.to);
    } else {
        const group = groups.find(g => g.id === msg.groupId);
        if (group) group.members.forEach(member => recipients.add(member));
    }
    recipients.forEach(pseudo => {
        const sid = _getSocketId(pseudo);
        if (sid) io.to(sid).emit(event, data);
    });
}

function broadcastUsers() {
    io.emit('users-list', Object.values(persistentUsers).map(safeUser));
}

function broadcastStatuses() {
    Object.entries(socketUsers).forEach(([sid, pseudo]) => {
        io.to(sid).emit('statuses-updated', activeStatusesForViewer(pseudo));
    });
}

function appStats() {
    cleanupExpiredMessages();
    cleanupExpiredStatuses();
    return {
        users: Object.keys(persistentUsers).length,
        onlineUsers: Object.values(persistentUsers).filter(user => user.online).length,
        groups: groups.length,
        messages: messages.length,
        activeStatuses: statuses.length
    };
}

function finalizeAuth(socket, user, callback) {
    cleanupExpiredMessages();
    cleanupExpiredStatuses();

    socketUsers[socket.id] = user.pseudo;
    socket.pseudo = user.pseudo;

    const userPseudo = user.pseudo;
    const userMessages = messages.filter(msg => messageVisibleForUser(msg, userPseudo));
    const userGroups = groups.filter(group => group.members.includes(userPseudo));

    callback({
        success: true,
        user: selfUserPayload(user),
        messages: userMessages,
        groups: userGroups,
        users: Object.values(persistentUsers).map(safeUser),
        statuses: activeStatusesForViewer(userPseudo)
    });

    broadcastUsers();
    io.emit('system', { text: `${userPseudo} a rejoint DevChat` });
}

const loaded = loadData();
loaded.users.forEach(user => {
    persistentUsers[user.pseudo] = ensureUserDefaults(user);
});
messages = (loaded.messages || []).filter(msg => !isExpired(msg.expiresAt));
groups = loaded.groups || [];
statuses = (loaded.statuses || []).filter(status => !isExpired(status.expiresAt));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
        cb(null, AVATARS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `avatar-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`);
    }
});
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/avatars', express.static(AVATARS_DIR));
app.use(express.json());

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
    res.json({
        fileUrl: `/uploads/${req.file.filename}`,
        fileName: req.file.originalname,
        fileType: req.file.mimetype
    });
});

app.post('/api/upload-avatar', avatarUpload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
    res.json({ avatarUrl: `/avatars/${req.file.filename}` });
});

io.on('connection', (socket) => {
    console.log('🔌 Connexion:', socket.id);

    socket.on('auth', async ({ pseudo, password, isRegister, avatar }, callback) => {
        try {
            const existing = persistentUsers[pseudo];

            if (isRegister) {
                if (existing) return callback({ success: false, error: 'Ce pseudo est déjà pris' });
                const hash = await bcrypt.hash(password, 10);
                const newUser = ensureUserDefaults({
                    pseudo,
                    password: hash,
                    avatar: avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(pseudo)}&backgroundColor=2aabee&fontFamily=Helvetica`,
                    bio: '',
                    createdAt: new Date().toISOString(),
                    online: true,
                    lastSeen: new Date().toISOString()
                });
                persistentUsers[pseudo] = newUser;
                saveData();
                finalizeAuth(socket, newUser, callback);
            } else {
                if (!existing) return callback({ success: false, error: 'Utilisateur introuvable' });
                const valid = await bcrypt.compare(password, existing.password);
                if (!valid) return callback({ success: false, error: 'Mot de passe incorrect' });
                ensureUserDefaults(existing);
                existing.online = true;
                existing.lastSeen = new Date().toISOString();
                saveData();
                finalizeAuth(socket, existing, callback);
            }
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('reset-password', async ({ pseudo, newPassword }, callback) => {
        const user = persistentUsers[pseudo];
        if (!user) return callback({ success: false, error: 'Utilisateur introuvable' });
        user.password = await bcrypt.hash(newPassword, 10);
        saveData();
        callback({ success: true });
    });

    socket.on('update-profile', ({ avatar, bio }, callback) => {
        const pseudo = socketUsers[socket.id];
        if (!pseudo) return callback?.({ success: false });
        const user = persistentUsers[pseudo];
        if (!user) return callback?.({ success: false });
        if (avatar) user.avatar = avatar;
        if (bio !== undefined) user.bio = bio;
        saveData();
        broadcastUsers();
        broadcastStatuses();
        callback?.({ success: true, user: selfUserPayload(user) });
    });

    socket.on('toggle-block-user', ({ pseudo }, callback) => {
        const from = socketUsers[socket.id];
        const user = persistentUsers[from];
        if (!from || !user || !persistentUsers[pseudo] || pseudo === from) {
            return callback?.({ success: false, error: 'Action impossible' });
        }

        ensureUserDefaults(user);
        const idx = user.blockedUsers.indexOf(pseudo);
        let blocked = false;
        if (idx === -1) {
            user.blockedUsers.push(pseudo);
            blocked = true;
        } else {
            user.blockedUsers.splice(idx, 1);
        }
        saveData();
        callback?.({ success: true, blocked, user: selfUserPayload(user) });
    });

    socket.on('set-ephemeral-mode', ({ pseudo, durationMs }, callback) => {
        const from = socketUsers[socket.id];
        const user = persistentUsers[from];
        if (!from || !user || !persistentUsers[pseudo]) {
            return callback?.({ success: false, error: 'Utilisateur introuvable' });
        }

        ensureUserDefaults(user);
        const ttl = Number(durationMs) || 0;
        if (ttl > 0) user.ephemeralSettings[pseudo] = ttl;
        else delete user.ephemeralSettings[pseudo];
        saveData();
        callback?.({
            success: true,
            durationMs: user.ephemeralSettings[pseudo] || 0,
            user: selfUserPayload(user)
        });
    });

    socket.on('delete-chat', ({ chatType, chatId }, callback) => {
        const pseudo = socketUsers[socket.id];
        const user = persistentUsers[pseudo];
        if (!pseudo || !user) return callback?.({ success: false, error: 'Session invalide' });

        ensureUserDefaults(user);
        const key = `${chatType}:${chatId}`;
        user.hiddenChats[key] = new Date().toISOString();
        saveData();
        callback?.({ success: true, user: selfUserPayload(user) });
    });

    socket.on('private-message', ({ to, content, fileUrl, fileName, fileType, replyTo, isSecret }, callback) => {
        const from = socketUsers[socket.id];
        const sender = persistentUsers[from];
        const recipient = persistentUsers[to];
        if (!from || !sender) return callback?.({ success: false, error: 'Session invalide' });
        if (!recipient) return callback?.({ success: false, error: 'Utilisateur introuvable' });
        if (recipient.blockedUsers?.includes(from)) {
            return callback?.({ success: false, error: 'Cette personne vous a bloqué' });
        }

        const ttl = Number(sender.ephemeralSettings?.[to] || 0);
        const msg = {
            id: uuidv4(),
            type: 'private',
            isSecret: !!isSecret,
            isEphemeral: ttl > 0,
            expiresAt: ttl > 0 ? new Date(Date.now() + ttl).toISOString() : null,
            from,
            to,
            content: content || '',
            fileUrl: fileUrl || null,
            fileName: fileName || null,
            fileType: fileType || null,
            replyTo: replyTo || null,
            date: new Date().toISOString(),
            readBy: [from],
            reactions: {}
        };

        if (!isSecret) {
            messages.push(msg);
            saveData();
        }

        const recipientSocketId = _getSocketId(to);
        if (recipientSocketId) io.to(recipientSocketId).emit('new-message', msg);
        socket.emit('new-message', msg);
        callback?.({ success: true, message: msg });
    });

    socket.on('group-message', ({ groupId, content, fileUrl, fileName, fileType, replyTo }, callback) => {
        const from = socketUsers[socket.id];
        if (!from) return callback?.({ success: false, error: 'Session invalide' });

        const group = groups.find(g => g.id === groupId);
        if (!group) return callback?.({ success: false, error: 'Groupe introuvable' });
        if (!group.members.includes(from)) return callback?.({ success: false, error: 'Non autorisé' });
        if (group.banned?.includes(from)) return callback?.({ success: false, error: 'Vous êtes banni' });

        const msg = {
            id: uuidv4(),
            type: 'group',
            groupId,
            from,
            content: content || '',
            fileUrl: fileUrl || null,
            fileName: fileName || null,
            fileType: fileType || null,
            replyTo: replyTo || null,
            date: new Date().toISOString(),
            readBy: [from],
            reactions: {}
        };
        messages.push(msg);
        saveData();

        group.members.forEach(member => {
            const sid = _getSocketId(member);
            if (sid) io.to(sid).emit('new-message', msg);
        });
        callback?.({ success: true, message: msg });
    });

    socket.on('create-group', ({ name, members, isPublic, description }, callback) => {
        const from = socketUsers[socket.id];
        if (!from) return callback?.({ success: false, error: 'Session invalide' });

        const group = {
            id: uuidv4(),
            name,
            description: description || '',
            members: [from, ...members.filter(member => member !== from)],
            admins: [from],
            banned: [],
            creator: from,
            isPublic: !!isPublic,
            avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(name)}&backgroundColor=2aabee`,
            createdAt: new Date().toISOString()
        };
        groups.push(group);
        saveData();
        group.members.forEach(member => {
            const sid = _getSocketId(member);
            if (sid) io.to(sid).emit('group-created', group);
        });
        callback?.({ success: true, group });
    });

    socket.on('add-member', ({ groupId, pseudo }, callback) => {
        const from = socketUsers[socket.id];
        const group = groups.find(g => g.id === groupId);
        if (!group || !group.admins.includes(from)) return callback?.({ success: false, error: 'Non autorisé' });
        if (group.members.includes(pseudo)) return callback?.({ success: false, error: 'Déjà membre' });
        if (!persistentUsers[pseudo]) return callback?.({ success: false, error: 'Utilisateur introuvable' });
        group.members.push(pseudo);
        saveData();
        const sid = _getSocketId(pseudo);
        if (sid) io.to(sid).emit('group-created', group);
        group.members.forEach(member => {
            const memberSid = _getSocketId(member);
            if (memberSid) io.to(memberSid).emit('group-updated', group);
        });
        callback?.({ success: true, group });
    });

    socket.on('ban-member', ({ groupId, pseudo }, callback) => {
        const from = socketUsers[socket.id];
        const group = groups.find(g => g.id === groupId);
        if (!group || !group.admins.includes(from)) return callback?.({ success: false, error: 'Non autorisé' });
        if (!group.banned) group.banned = [];
        if (!group.banned.includes(pseudo)) group.banned.push(pseudo);
        group.members = group.members.filter(member => member !== pseudo);
        saveData();
        const sid = _getSocketId(pseudo);
        if (sid) io.to(sid).emit('you-were-banned', { groupId, groupName: group.name });
        group.members.forEach(member => {
            const memberSid = _getSocketId(member);
            if (memberSid) io.to(memberSid).emit('group-updated', group);
        });
        callback?.({ success: true });
    });

    socket.on('leave-group', ({ groupId }, callback) => {
        const from = socketUsers[socket.id];
        const group = groups.find(g => g.id === groupId);
        if (!group) return callback?.({ success: false, error: 'Groupe introuvable' });
        group.members = group.members.filter(member => member !== from);
        group.admins = group.admins.filter(member => member !== from);
        saveData();
        group.members.forEach(member => {
            const sid = _getSocketId(member);
            if (sid) io.to(sid).emit('group-updated', group);
        });
        socket.emit('group-left', { groupId });
        callback?.({ success: true });
    });

    socket.on('react-message', ({ messageId, emoji }) => {
        const from = socketUsers[socket.id];
        if (!from) return;
        const msg = messages.find(message => message.id === messageId);
        if (!msg) return;
        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        const idx = msg.reactions[emoji].indexOf(from);
        if (idx === -1) msg.reactions[emoji].push(from);
        else {
            msg.reactions[emoji].splice(idx, 1);
            if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
        }
        saveData();
        _broadcastToMessageParticipants(msg, 'message-reaction', { messageId, reactions: msg.reactions });
    });

    socket.on('delete-message', ({ messageId }, callback) => {
        const from = socketUsers[socket.id];
        const msg = messages.find(message => message.id === messageId);
        if (!msg || msg.from !== from) return callback?.({ success: false, error: 'Action impossible' });
        msg.deleted = true;
        msg.content = '';
        msg.fileUrl = null;
        saveData();
        _broadcastToMessageParticipants(msg, 'message-deleted', { messageId });
        callback?.({ success: true });
    });

    socket.on('mark-read', ({ messageIds }) => {
        const from = socketUsers[socket.id];
        if (!from) return;
        let hasChanges = false;
        const affected = [];
        messageIds.forEach(id => {
            const msg = messages.find(message => message.id === id);
            if (!msg || isExpired(msg.expiresAt)) return;
            if (!msg.readBy.includes(from)) {
                msg.readBy.push(from);
                hasChanges = true;
            }
            affected.push(msg);
        });
        if (hasChanges) saveData();
        affected.forEach(msg => {
            const senderSid = _getSocketId(msg.from);
            if (senderSid) io.to(senderSid).emit('messages-read', { messageIds, by: from });
        });
    });

    socket.on('typing', ({ to, groupId, isTyping }) => {
        const from = socketUsers[socket.id];
        if (!from) return;
        if (to) {
            const sid = _getSocketId(to);
            if (sid) io.to(sid).emit('user-typing', { from, isTyping });
        } else if (groupId) {
            const group = groups.find(g => g.id === groupId);
            if (!group) return;
            group.members.forEach(member => {
                if (member === from) return;
                const sid = _getSocketId(member);
                if (sid) io.to(sid).emit('user-typing', { from, groupId, isTyping });
            });
        }
    });

    socket.on('create-status', ({ text, mediaUrl, fileType, fileName }, callback) => {
        const from = socketUsers[socket.id];
        if (!from) return callback?.({ success: false, error: 'Session invalide' });
        if (!text && !mediaUrl) return callback?.({ success: false, error: 'Statut vide' });

        const status = {
            id: uuidv4(),
            userPseudo: from,
            text: text || '',
            mediaUrl: mediaUrl || null,
            fileType: fileType || null,
            fileName: fileName || null,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + STATUS_TTL_MS).toISOString(),
            viewedBy: [from]
        };
        statuses.push(status);
        saveData();
        broadcastStatuses();
        callback?.({ success: true, status: safeStatus(status, from) });
    });

    socket.on('get-statuses', callback => {
        const from = socketUsers[socket.id];
        callback?.(activeStatusesForViewer(from));
    });

    socket.on('view-status', ({ statusId }, callback) => {
        const from = socketUsers[socket.id];
        const status = statuses.find(item => item.id === statusId);
        if (!from || !status || isExpired(status.expiresAt)) return callback?.({ success: false });
        if (!status.viewedBy.includes(from)) {
            status.viewedBy.push(from);
            saveData();
        }
        callback?.({ success: true, status: safeStatus(status, from) });
    });

    socket.on('delete-status', ({ statusId }, callback) => {
        const from = socketUsers[socket.id];
        const status = statuses.find(item => item.id === statusId);
        if (!from || !status || status.userPseudo !== from) {
            return callback?.({ success: false, error: 'Action impossible' });
        }
        statuses = statuses.filter(item => item.id !== statusId);
        saveData();
        io.emit('status-deleted', { statusId });
        broadcastStatuses();
        callback?.({ success: true });
    });

    socket.on('search-users', (query, callback) => {
        const from = socketUsers[socket.id];
        const results = Object.values(persistentUsers)
            .filter(user => user.pseudo !== from && user.pseudo.toLowerCase().includes(query.toLowerCase()))
            .map(user => ({
                ...safeUser(user),
                blocked: persistentUsers[from]?.blockedUsers?.includes(user.pseudo) || false
            }));
        callback(results);
    });

    socket.on('get-app-stats', callback => {
        callback?.(appStats());
    });

    socket.on('get-public-groups', callback => {
        const publicGroups = groups.filter(group => group.isPublic).map(group => ({
            ...group,
            memberCount: group.members.length
        }));
        callback(publicGroups);
    });

    socket.on('join-public-group', ({ groupId }, callback) => {
        const from = socketUsers[socket.id];
        const group = groups.find(g => g.id === groupId);
        if (!group || !group.isPublic) return callback?.({ success: false, error: 'Groupe introuvable' });
        if (group.banned?.includes(from)) return callback?.({ success: false, error: 'Vous êtes banni' });
        if (!group.members.includes(from)) {
            group.members.push(from);
            saveData();
            group.members.forEach(member => {
                const sid = _getSocketId(member);
                if (sid) io.to(sid).emit('group-updated', group);
            });
        }
        socket.emit('group-created', group);
        callback?.({ success: true, group });
    });

    socket.on('disconnect', () => {
        const pseudo = socketUsers[socket.id];
        if (pseudo && persistentUsers[pseudo]) {
            persistentUsers[pseudo].online = false;
            persistentUsers[pseudo].lastSeen = new Date().toISOString();
            saveData();
            broadcastUsers();
        }
        delete socketUsers[socket.id];
    });
});

setInterval(() => {
    cleanupExpiredMessages(true);
    cleanupExpiredStatuses(true);
}, 10000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 DevChat sur http://localhost:${PORT}`));
