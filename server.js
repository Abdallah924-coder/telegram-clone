// ── Fix SSL "tlsv1 alert internal error 80" sur Render + Node 25 ──
// Doit être tout en haut, avant tout require réseau
const tls = require('tls');
const _origCreate = tls.createSecureContext;
tls.createSecureContext = (opts = {}) => {
    if (!opts.minVersion) opts.minVersion = 'TLSv1.2';
    if (!opts.maxVersion) opts.maxVersion = 'TLSv1.3';
    if (!opts.ciphers) opts.ciphers = [
        'TLS_AES_256_GCM_SHA384','TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256','ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES128-GCM-SHA256','ECDHE-RSA-CHACHA20-POLY1305'
    ].join(':');
    return _origCreate(opts);
};

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const { MongoClient } = require('mongodb');

const socketCorsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
    : undefined;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: socketCorsOrigin ? { origin: socketCorsOrigin } : undefined,
    transports: ['websocket', 'polling']
});

const RENDER_STORAGE_ROOT = '/opt/render/project/src/storage';
const LOCAL_DATA_FILE = path.join(__dirname, 'data.json');
const LOCAL_UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const LOCAL_AVATARS_DIR = path.join(__dirname, 'public', 'avatars');
const DEFAULT_STORAGE_ROOT = fs.existsSync(RENDER_STORAGE_ROOT) ? RENDER_STORAGE_ROOT : null;
const DATA_FILE = process.env.DATA_FILE || (DEFAULT_STORAGE_ROOT ? path.join(DEFAULT_STORAGE_ROOT, 'data.json') : LOCAL_DATA_FILE);
const UPLOADS_DIR = process.env.UPLOADS_DIR || (DEFAULT_STORAGE_ROOT ? path.join(DEFAULT_STORAGE_ROOT, 'uploads') : LOCAL_UPLOADS_DIR);
const AVATARS_DIR = process.env.AVATARS_DIR || (DEFAULT_STORAGE_ROOT ? path.join(DEFAULT_STORAGE_ROOT, 'avatars') : LOCAL_AVATARS_DIR);
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHANNEL_KEY = 'system:updates';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGODB_DB_NAME = String(process.env.MONGODB_DB_NAME || 'devchat').trim();
const MONGODB_COLLECTION = String(process.env.MONGODB_COLLECTION || 'app_state').trim();
const APP_STATE_DOC_ID = 'main';
const ALLOW_INSECURE_PASSWORD_RESET = process.env.ALLOW_INSECURE_PASSWORD_RESET === 'true';
const ALLOWED_UPLOAD_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
    'application/json',
    'text/plain'
]);

let mongoClient = null;
let mongoCollection = null;
let persistChain = Promise.resolve();

function normalizeCountryCode(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits ? `+${digits}` : '';
}

function normalizePhoneLocal(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizePhone(countryCode, phoneNumber) {
    const raw = String(phoneNumber || '').trim();
    if (raw.startsWith('+')) return normalizeStandalonePhone(raw);
    const code = normalizeCountryCode(countryCode);
    const local = normalizePhoneLocal(raw);
    if (!code || !local) return '';
    return `${code}${local}`;
}

function normalizeStandalonePhone(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('+')) return `+${raw.slice(1).replace(/\D/g, '')}`;
    return '';
}

function defaultData() {
    return { users: [], messages: [], groups: [], statuses: [] };
}

function ensureStorageBootstrap() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(AVATARS_DIR, { recursive: true });

    if (fs.existsSync(DATA_FILE)) return;

    const initialData = fs.existsSync(LOCAL_DATA_FILE)
        ? fs.readFileSync(LOCAL_DATA_FILE, 'utf8')
        : JSON.stringify(defaultData(), null, 2);

    fs.writeFileSync(DATA_FILE, initialData);
}

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
    }
    return defaultData();
}

let persistentUsers = {};
let messages = [];
let groups = [];
let statuses = [];
let socketUsers = {};
let authSessions = new Map();

function ensureUserDefaults(user) {
    user.bio = user.bio || '';
    user.online = !!user.online;
    user.blockedUsers = Array.isArray(user.blockedUsers) ? user.blockedUsers : [];
    user.hiddenChats = user.hiddenChats && typeof user.hiddenChats === 'object' ? user.hiddenChats : {};
    user.ephemeralSettings = user.ephemeralSettings && typeof user.ephemeralSettings === 'object' ? user.ephemeralSettings : {};
    user.phoneCountryCode = normalizeCountryCode(user.phoneCountryCode || '');
    user.phoneLocalNumber = normalizePhoneLocal(user.phoneLocalNumber || '');
    user.phoneNumber = normalizeStandalonePhone(user.phoneNumber) || normalizePhone(user.phoneCountryCode, user.phoneLocalNumber);
    if (!user.phoneCountryCode && user.phoneNumber.startsWith('+242')) user.phoneCountryCode = '+242';
    if (!user.phoneLocalNumber && user.phoneCountryCode && user.phoneNumber.startsWith(user.phoneCountryCode)) {
        user.phoneLocalNumber = normalizePhoneLocal(user.phoneNumber.slice(user.phoneCountryCode.length));
    }
    user.contacts = [...new Set((Array.isArray(user.contacts) ? user.contacts : []).map(contact => normalizeStandalonePhone(contact)).filter(Boolean))];
    user.isAdmin = !!user.isAdmin;
    return user;
}

function ensureGroupDefaults(group) {
    group.description = group.description || '';
    group.members = Array.isArray(group.members) ? group.members : [];
    group.admins = Array.isArray(group.admins) ? group.admins : [];
    group.banned = Array.isArray(group.banned) ? group.banned : [];
    group.isPublic = !!group.isPublic;
    group.isUpdatesChannel = !!group.isUpdatesChannel;
    group.joinByPrompt = !!group.joinByPrompt;
    group.systemKey = group.systemKey || null;
    group.avatar = group.avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(group.name || 'Group')}&backgroundColor=2aabee`;
    return group;
}

function getUserPhone(user) {
    return user?.phoneNumber || '';
}

function findUserByPhone(phoneNumber) {
    const normalized = normalizeStandalonePhone(phoneNumber);
    return Object.values(persistentUsers).find(user => getUserPhone(user) === normalized) || null;
}

function areMutualContacts(userPseudoA, userPseudoB) {
    const userA = persistentUsers[userPseudoA];
    const userB = persistentUsers[userPseudoB];
    const phoneA = getUserPhone(userA);
    const phoneB = getUserPhone(userB);

    if (!userA || !userB || !phoneA || !phoneB) return false;
    return userA.contacts.includes(phoneB) && userB.contacts.includes(phoneA);
}

function canViewerSeeStatus(ownerPseudo, viewerPseudo) {
    if (!ownerPseudo || !viewerPseudo) return false;
    if (ownerPseudo === viewerPseudo) return true;
    return areMutualContacts(ownerPseudo, viewerPseudo);
}

function getUpdatesChannel() {
    return groups.find(group => group.systemKey === UPDATE_CHANNEL_KEY) || null;
}

function safeUpdateChannel(userPseudo) {
    const channel = getUpdatesChannel();
    if (!channel) return null;
    return {
        id: channel.id,
        name: channel.name,
        description: channel.description,
        avatar: channel.avatar,
        joined: channel.members.includes(userPseudo)
    };
}

function isExpired(iso) {
    return !!iso && new Date(iso).getTime() <= Date.now();
}

function currentDataSnapshot() {
    return {
        users: Object.values(persistentUsers).map(ensureUserDefaults),
        messages,
        groups: groups.map(ensureGroupDefaults),
        statuses
    };
}

function writeLocalSnapshot(snapshot) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
}

async function connectMongo() {
    if (!MONGODB_URI) return false;
    mongoClient = new MongoClient(MONGODB_URI, {
        ignoreUndefined: true,
        tls: true,
        tlsAllowInvalidCertificates: false,
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        socketTimeoutMS: 45000,
        maxPoolSize: 5,
        retryWrites: true,
        w: 'majority'
    });
    await mongoClient.connect();
    mongoCollection = mongoClient.db(MONGODB_DB_NAME).collection(MONGODB_COLLECTION);
    return true;
}

async function loadInitialData() {
    if (mongoCollection) {
        const doc = await mongoCollection.findOne({ _id: APP_STATE_DOC_ID });
        if (doc?.state) return doc.state;
        if (fs.existsSync(DATA_FILE)) {
            try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
        }
        if (LOCAL_DATA_FILE !== DATA_FILE && fs.existsSync(LOCAL_DATA_FILE)) {
            try { return JSON.parse(fs.readFileSync(LOCAL_DATA_FILE, 'utf8')); } catch (e) {}
        }
        return defaultData();
    }

    ensureStorageBootstrap();
    return loadData();
}

function saveData() {
    const snapshot = currentDataSnapshot();
    if (!mongoCollection) {
        writeLocalSnapshot(snapshot);
        return;
    }

    persistChain = persistChain
        .catch(() => {})
        .then(async () => {
            await mongoCollection.updateOne(
                { _id: APP_STATE_DOC_ID },
                {
                    $set: {
                        state: snapshot,
                        updatedAt: new Date().toISOString()
                    }
                },
                { upsert: true }
            );
        })
        .catch(err => {
            console.error('Mongo persist failed:', err.message);
        });
}

function issueSessionToken(pseudo) {
    const token = crypto.randomBytes(24).toString('hex');
    authSessions.set(token, {
        pseudo,
        expiresAt: Date.now() + SESSION_TTL_MS
    });
    return token;
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [token, session] of authSessions.entries()) {
        if (!session || session.expiresAt <= now) authSessions.delete(token);
    }
}

function getSessionPseudoFromRequest(req) {
    cleanupExpiredSessions();
    const header = req.headers.authorization || req.headers['x-session-token'] || '';
    const token = String(header).startsWith('Bearer ') ? String(header).slice(7).trim() : String(header).trim();
    if (!token) return null;
    const session = authSessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        authSessions.delete(token);
        return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session.pseudo;
}

function requireUploadAuth(req, res, next) {
    const pseudo = getSessionPseudoFromRequest(req);
    if (!pseudo || !persistentUsers[pseudo]) {
        return res.status(401).json({ error: 'Authentification requise' });
    }
    req.authPseudo = pseudo;
    next();
}

function isAllowedUploadMime(file) {
    const mime = String(file?.mimetype || '').toLowerCase();
    return ALLOWED_UPLOAD_MIME_PREFIXES.some(prefix => mime.startsWith(prefix)) || ALLOWED_UPLOAD_MIME_TYPES.has(mime);
}

function uploadFileFilter(req, file, cb) {
    if (!isAllowedUploadMime(file)) {
        return cb(new Error('Type de fichier non autorise'));
    }
    cb(null, true);
}

function avatarFileFilter(req, file, cb) {
    if (!String(file?.mimetype || '').toLowerCase().startsWith('image/')) {
        return cb(new Error('Image requise'));
    }
    cb(null, true);
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
        .filter(status => canViewerSeeStatus(status.userPseudo, viewerPseudo))
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
        phoneCountryCode: user.phoneCountryCode || '',
        phoneLocalNumber: user.phoneLocalNumber || '',
        phoneNumber: getUserPhone(user),
        contacts: user.contacts || [],
        isAdmin: !!user.isAdmin,
        needsPhoneSetup: !getUserPhone(user),
        blockedUsers: user.blockedUsers || [],
        hiddenChats: user.hiddenChats || {},
        ephemeralSettings: user.ephemeralSettings || {}
    };
}

function safeStatus(status, viewerPseudo) {
    const viewers = (status.viewedBy || []).filter(pseudo => pseudo !== status.userPseudo);
    return {
        id: status.id,
        userPseudo: status.userPseudo,
        userAvatar: persistentUsers[status.userPseudo]?.avatar || '',
        text: status.text || '',
        mediaUrl: status.mediaUrl || null,
        fileType: status.fileType || null,
        fileName: status.fileName || null,
        background: status.background || null,
        createdAt: status.createdAt,
        expiresAt: status.expiresAt,
        audience: 'mutual-contacts',
        viewed: !!viewerPseudo && status.viewedBy?.includes(viewerPseudo),
        viewedByCount: viewers.length,
        seenBy: viewerPseudo === status.userPseudo ? viewers.map(pseudo => safeUser(persistentUsers[pseudo])).filter(Boolean) : []
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
    cleanupExpiredSessions();

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
        statuses: activeStatusesForViewer(userPseudo),
        updateChannel: safeUpdateChannel(userPseudo),
        sessionToken: issueSessionToken(userPseudo)
    });

    broadcastUsers();
    io.emit('system', { text: `${userPseudo} a rejoint DevChat` });
}

function ensureAdminAccount() {
    const existingAdmin = Object.values(persistentUsers).find(user => user.isAdmin);
    if (existingAdmin) return;

    const adminPseudo = (process.env.ADMIN_PSEUDO || 'Admin DevChat').trim();
    const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex');
    const envPhone = normalizeStandalonePhone(process.env.ADMIN_PHONE);
    const adminCountryCode = normalizeCountryCode(process.env.ADMIN_COUNTRY_CODE || '+242');
    const adminLocalNumber = normalizePhoneLocal(process.env.ADMIN_PHONE_LOCAL || '0000000000');
    const adminPhone = envPhone || normalizePhone(adminCountryCode, adminLocalNumber);

    const existingByPhone = findUserByPhone(adminPhone);
    if (existingByPhone) {
        existingByPhone.isAdmin = true;
        ensureUserDefaults(existingByPhone);
        return;
    }

    const existingByPseudo = persistentUsers[adminPseudo];
    if (existingByPseudo) {
        existingByPseudo.isAdmin = true;
        existingByPseudo.phoneCountryCode = existingByPseudo.phoneCountryCode || adminCountryCode;
        existingByPseudo.phoneLocalNumber = existingByPseudo.phoneLocalNumber || adminLocalNumber;
        existingByPseudo.phoneNumber = existingByPseudo.phoneNumber || adminPhone;
        ensureUserDefaults(existingByPseudo);
        return;
    }

    persistentUsers[adminPseudo] = ensureUserDefaults({
        pseudo: adminPseudo,
        password: bcrypt.hashSync(adminPassword, 10),
        avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(adminPseudo)}&backgroundColor=2aabee&fontFamily=Helvetica`,
        bio: 'Compte administrateur',
        createdAt: new Date().toISOString(),
        online: false,
        lastSeen: new Date().toISOString(),
        isAdmin: true,
        phoneCountryCode: adminCountryCode,
        phoneLocalNumber: adminLocalNumber,
        phoneNumber: adminPhone,
        contacts: []
    });

    if (!process.env.ADMIN_PASSWORD) {
        console.warn(`Admin password generated for "${adminPseudo}": ${adminPassword}`);
    }
}

function ensureUpdatesChannel() {
    if (getUpdatesChannel()) return;
    const admin = Object.values(persistentUsers).find(user => user.isAdmin);
    if (!admin) return;

    groups.push(ensureGroupDefaults({
        id: uuidv4(),
        name: 'Mises a jour DevChat',
        description: "Rejoignez ce canal pour recevoir les annonces et nouvelles fonctionnalites de l'application.",
        members: [admin.pseudo],
        admins: [admin.pseudo],
        banned: [],
        creator: admin.pseudo,
        isPublic: false,
        isUpdatesChannel: true,
        joinByPrompt: true,
        systemKey: UPDATE_CHANNEL_KEY,
        avatar: `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent('updates-devchat')}&backgroundColor=2aabee`,
        createdAt: new Date().toISOString()
    }));
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: uploadFileFilter
});

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });
        cb(null, AVATARS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `avatar-${uuidv4().slice(0, 8)}${path.extname(file.originalname)}`);
    }
});
const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: avatarFileFilter
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/avatars', express.static(AVATARS_DIR));
app.use(express.json());

app.post('/api/upload', requireUploadAuth, (req, res) => {
    upload.single('file')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message || 'Upload impossible' });
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
        res.json({
            fileUrl: `/uploads/${req.file.filename}`,
            fileName: req.file.originalname,
            fileType: req.file.mimetype
        });
    });
});

app.post('/api/upload-avatar', (req, res) => {
    avatarUpload.single('avatar')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message || 'Upload impossible' });
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
        res.json({ avatarUrl: `/avatars/${req.file.filename}` });
    });
});

io.on('connection', (socket) => {
    console.log('🔌 Connexion:', socket.id);

    socket.on('auth', async ({ pseudo, password, isRegister, avatar, countryCode, phoneNumber }, callback) => {
        try {
            const normalizedPseudo = String(pseudo || '').trim();
            const normalizedPhone = normalizePhone(countryCode, phoneNumber);
            const normalizedPassword = String(password || '');
            const existing = normalizedPhone ? findUserByPhone(normalizedPhone) : persistentUsers[normalizedPseudo];

            if (isRegister) {
                if (!normalizedPseudo) return callback({ success: false, error: 'Pseudo requis' });
                if (!normalizedPhone) return callback({ success: false, error: 'Numero de telephone requis' });
                if (normalizedPassword.length < 4) return callback({ success: false, error: 'Mot de passe trop court' });
                if (persistentUsers[normalizedPseudo]) return callback({ success: false, error: 'Ce pseudo est deja pris' });
                if (findUserByPhone(normalizedPhone)) return callback({ success: false, error: 'Ce numero est deja utilise' });
                const hash = await bcrypt.hash(normalizedPassword, 10);
                const newUser = ensureUserDefaults({
                    pseudo: normalizedPseudo,
                    password: hash,
                    avatar: avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(normalizedPseudo)}&backgroundColor=2aabee&fontFamily=Helvetica`,
                    bio: '',
                    createdAt: new Date().toISOString(),
                    online: true,
                    lastSeen: new Date().toISOString(),
                    phoneCountryCode: normalizeCountryCode(countryCode),
                    phoneLocalNumber: normalizePhoneLocal(phoneNumber),
                    phoneNumber: normalizedPhone,
                    contacts: []
                });
                persistentUsers[normalizedPseudo] = newUser;
                saveData();
                finalizeAuth(socket, newUser, callback);
            } else {
                const legacyUser = !existing && normalizedPseudo ? persistentUsers[normalizedPseudo] : null;
                const authUser = existing || legacyUser;
                if (!authUser) return callback({ success: false, error: 'Utilisateur introuvable' });
                const valid = await bcrypt.compare(normalizedPassword, authUser.password);
                if (!valid) return callback({ success: false, error: 'Mot de passe incorrect' });
                ensureUserDefaults(authUser);
                authUser.online = true;
                authUser.lastSeen = new Date().toISOString();
                saveData();
                finalizeAuth(socket, authUser, callback);
            }
        } catch (err) {
            callback({ success: false, error: err.message });
        }
    });

    socket.on('reset-password', async ({ pseudo, countryCode, phoneNumber, oldPassword, newPassword }, callback) => {
        const sessionPseudo = socketUsers[socket.id];
        const normalizedNewPassword = String(newPassword || '');
        if (normalizedNewPassword.length < 4) {
            return callback?.({ success: false, error: 'Mot de passe trop court' });
        }

        if (sessionPseudo) {
            const user = persistentUsers[sessionPseudo];
            if (!user) return callback?.({ success: false, error: 'Session invalide' });
            const valid = await bcrypt.compare(String(oldPassword || ''), user.password);
            if (!valid) return callback?.({ success: false, error: 'Mot de passe actuel incorrect' });
            user.password = await bcrypt.hash(normalizedNewPassword, 10);
            saveData();
            return callback?.({ success: true });
        }

        if (!ALLOW_INSECURE_PASSWORD_RESET) {
            return callback?.({
                success: false,
                error: 'Réinitialisation désactivée pour sécurité. Connectez-vous puis changez le mot de passe depuis votre session.'
            });
        }

        const normalizedPhone = normalizePhone(countryCode, phoneNumber);
        const user = (normalizedPhone && findUserByPhone(normalizedPhone)) || persistentUsers[String(pseudo || '').trim()];
        if (!user) return callback?.({ success: false, error: 'Utilisateur introuvable' });
        user.password = await bcrypt.hash(normalizedNewPassword, 10);
        saveData();
        callback?.({ success: true });
    });

    socket.on('update-profile', ({ avatar, bio, countryCode, phoneNumber }, callback) => {
        const pseudo = socketUsers[socket.id];
        if (!pseudo) return callback?.({ success: false });
        const user = persistentUsers[pseudo];
        if (!user) return callback?.({ success: false });
        if (avatar) user.avatar = avatar;
        if (bio !== undefined) user.bio = bio;
        if (countryCode || phoneNumber) {
            const nextPhone = normalizePhone(countryCode, phoneNumber);
            if (!nextPhone) return callback?.({ success: false, error: 'Numero invalide' });
            const duplicate = findUserByPhone(nextPhone);
            if (duplicate && duplicate.pseudo !== pseudo) {
                return callback?.({ success: false, error: 'Ce numero est deja utilise' });
            }
            user.phoneCountryCode = normalizeCountryCode(countryCode);
            user.phoneLocalNumber = normalizePhoneLocal(phoneNumber);
            user.phoneNumber = nextPhone;
        }
        saveData();
        broadcastUsers();
        broadcastStatuses();
        callback?.({ success: true, user: selfUserPayload(user) });
    });

    socket.on('add-contact', ({ countryCode, phoneNumber }, callback) => {
        const pseudo = socketUsers[socket.id];
        const user = persistentUsers[pseudo];
        if (!pseudo || !user) return callback?.({ success: false, error: 'Session invalide' });

        const normalizedPhone = normalizePhone(countryCode, phoneNumber);
        if (!normalizedPhone) return callback?.({ success: false, error: 'Numero invalide' });
        if (normalizedPhone === getUserPhone(user)) return callback?.({ success: false, error: 'Impossible d ajouter votre propre numero' });

        const targetUser = findUserByPhone(normalizedPhone);
        if (!targetUser) return callback?.({ success: false, error: 'Aucun compte n utilise ce numero' });

        ensureUserDefaults(user);
        if (!user.contacts.includes(normalizedPhone)) user.contacts.push(normalizedPhone);
        saveData();
        broadcastStatuses();
        callback?.({ success: true, user: selfUserPayload(user), contactUser: safeUser(targetUser) });
    });

    socket.on('remove-contact', ({ phoneNumber }, callback) => {
        const pseudo = socketUsers[socket.id];
        const user = persistentUsers[pseudo];
        if (!pseudo || !user) return callback?.({ success: false, error: 'Session invalide' });

        ensureUserDefaults(user);
        user.contacts = user.contacts.filter(contact => contact !== normalizeStandalonePhone(phoneNumber));
        saveData();
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
        if (group.isUpdatesChannel && !group.admins.includes(from)) {
            return callback?.({ success: false, error: 'Seuls les administrateurs peuvent publier dans ce canal' });
        }

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

    socket.on('create-group', ({ name, members, isPublic, description, avatar }, callback) => {
        const from = socketUsers[socket.id];
        if (!from) return callback?.({ success: false, error: 'Session invalide' });
        const groupName = String(name || '').trim();
        const memberList = Array.isArray(members) ? members.filter(member => typeof member === 'string') : [];
        if (!groupName) return callback?.({ success: false, error: 'Nom du groupe requis' });

        const group = ensureGroupDefaults({
            id: uuidv4(),
            name: groupName,
            description: description || '',
            members: [from, ...memberList.filter(member => member !== from)],
            admins: [from],
            banned: [],
            creator: from,
            isPublic: !!isPublic,
            avatar: avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(groupName)}&backgroundColor=2aabee`,
            createdAt: new Date().toISOString()
        });
        groups.push(group);
        saveData();
        group.members.forEach(member => {
            const sid = _getSocketId(member);
            if (sid) io.to(sid).emit('group-created', group);
        });
        callback?.({ success: true, group });
    });

    socket.on('update-group-profile', ({ groupId, name, description, avatar }, callback) => {
        const from = socketUsers[socket.id];
        const group = groups.find(item => item.id === groupId);
        if (!group || !group.admins.includes(from)) return callback?.({ success: false, error: 'Non autorise' });

        if (name) group.name = String(name).trim();
        if (description !== undefined) group.description = description;
        if (avatar) group.avatar = avatar;
        ensureGroupDefaults(group);
        saveData();
        group.members.forEach(member => {
            const sid = _getSocketId(member);
            if (sid) io.to(sid).emit('group-updated', group);
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
        if (!messageVisibleForUser(msg, from)) return;
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

    socket.on('delete-messages', ({ messageIds }, callback) => {
        const from = socketUsers[socket.id];
        const ids = Array.isArray(messageIds) ? messageIds : [];
        const targets = ids
            .map(id => messages.find(message => message.id === id))
            .filter(Boolean);
        if (!from || !targets.length) return callback?.({ success: false, error: 'Aucun message valide' });
        if (targets.some(msg => msg.from !== from)) return callback?.({ success: false, error: 'Action impossible' });

        targets.forEach(msg => {
            msg.deleted = true;
            msg.content = '';
            msg.fileUrl = null;
            msg.fileName = null;
            msg.fileType = null;
        });
        saveData();
        targets.forEach(msg => _broadcastToMessageParticipants(msg, 'message-deleted', { messageId: msg.id }));
        callback?.({ success: true, messageIds: targets.map(msg => msg.id) });
    });

    socket.on('edit-message', ({ messageId, content }, callback) => {
        const from = socketUsers[socket.id];
        const msg = messages.find(message => message.id === messageId);
        const nextContent = String(content || '').trim();
        if (!msg || msg.from !== from || msg.deleted) return callback?.({ success: false, error: 'Action impossible' });
        if (msg.fileUrl) return callback?.({ success: false, error: 'Modification indisponible pour ce message' });
        if (!nextContent) return callback?.({ success: false, error: 'Contenu vide' });

        msg.content = nextContent;
        msg.editedAt = new Date().toISOString();
        saveData();
        _broadcastToMessageParticipants(msg, 'message-edited', { message: msg });
        callback?.({ success: true, message: msg });
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

    socket.on('create-status', ({ text, mediaUrl, fileType, fileName, background }, callback) => {
        const from = socketUsers[socket.id];
        if (!from) return callback?.({ success: false, error: 'Session invalide' });
        if (!text && !mediaUrl) return callback?.({ success: false, error: 'Statut vide' });
        if (!getUserPhone(persistentUsers[from])) {
            return callback?.({ success: false, error: 'Ajoutez votre numero principal avant de publier un statut' });
        }

        const status = {
            id: uuidv4(),
            userPseudo: from,
            text: text || '',
            mediaUrl: mediaUrl || null,
            fileType: fileType || null,
            fileName: fileName || null,
            background: typeof background === 'string' ? background : null,
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
        if (!from || !status || isExpired(status.expiresAt) || !canViewerSeeStatus(status.userPseudo, from)) {
            return callback?.({ success: false });
        }
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
        const rawQuery = String(query || '').trim();
        const normalizedDigits = rawQuery.replace(/\D/g, '');
        const results = Object.values(persistentUsers)
            .filter(user => {
                if (user.pseudo === from) return false;
                const pseudoMatch = user.pseudo.toLowerCase().includes(rawQuery.toLowerCase());
                const phone = getUserPhone(user);
                const phoneMatch = normalizedDigits.length >= 3 && phone.replace(/\D/g, '').includes(normalizedDigits);
                return pseudoMatch || phoneMatch;
            })
            .map(user => ({
                ...safeUser(user),
                phoneNumber: getUserPhone(user),
                blocked: persistentUsers[from]?.blockedUsers?.includes(user.pseudo) || false,
                inContacts: persistentUsers[from]?.contacts?.includes(getUserPhone(user)) || false
            }));
        callback(results);
    });

    socket.on('get-app-stats', callback => {
        const from = socketUsers[socket.id];
        const user = persistentUsers[from];
        if (!user?.isAdmin) return callback?.({ error: 'Non autorise' });
        callback?.(appStats());
    });

    socket.on('get-update-channel', callback => {
        const from = socketUsers[socket.id];
        callback?.(safeUpdateChannel(from));
    });

    socket.on('join-update-channel', callback => {
        const from = socketUsers[socket.id];
        const channel = getUpdatesChannel();
        if (!from || !channel) return callback?.({ success: false, error: 'Canal indisponible' });

        if (!channel.members.includes(from)) {
            channel.members.push(from);
            saveData();
            const sid = _getSocketId(from);
            if (sid) io.to(sid).emit('group-created', channel);
            channel.members.forEach(member => {
                const memberSid = _getSocketId(member);
                if (memberSid) io.to(memberSid).emit('group-updated', channel);
            });
        }
        callback?.({ success: true, group: channel, updateChannel: safeUpdateChannel(from) });
    });

    socket.on('get-public-groups', callback => {
        const publicGroups = groups.filter(group => group.isPublic && !group.isUpdatesChannel).map(group => ({
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

async function bootstrap() {
    try {
        if (MONGODB_URI) {
            await connectMongo();
            console.log(`MongoDB connected (${MONGODB_DB_NAME}/${MONGODB_COLLECTION})`);
        } else {
            ensureStorageBootstrap();
            console.log('MongoDB disabled, using local JSON storage');
        }
    } catch (err) {
        console.error('MongoDB unavailable, fallback to local JSON storage:', err.message);
        mongoClient = null;
        mongoCollection = null;
        ensureStorageBootstrap();
    }

    const loaded = await loadInitialData();
    loaded.users.forEach(user => {
        persistentUsers[user.pseudo] = ensureUserDefaults(user);
    });
    messages = (loaded.messages || []).filter(msg => !isExpired(msg.expiresAt));
    groups = (loaded.groups || []).map(ensureGroupDefaults);
    statuses = (loaded.statuses || []).filter(status => !isExpired(status.expiresAt));

    ensureAdminAccount();
    ensureUpdatesChannel();
    saveData();

    setInterval(() => {
        cleanupExpiredMessages(true);
        cleanupExpiredStatuses(true);
        cleanupExpiredSessions();
    }, 10000);

    const PORT = process.env.PORT || 3001;
    server.listen(PORT, () => console.log(`🚀 DevChat sur http://localhost:${PORT}`));
}

bootstrap().catch(err => {
    console.error('Fatal bootstrap error:', err);
    process.exit(1);
});