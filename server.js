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
    transports: ['websocket', 'polling'],
    // Garder la connexion vivante sur Render (évite la mise en veille socket)
    pingTimeout: 60000,      // 60s avant de considérer le client mort
    pingInterval: 25000,     // ping toutes les 25s
    upgradeTimeout: 30000,
    maxHttpBufferSize: 1e7,  // 10MB pour les fichiers
    connectTimeout: 45000
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
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 45 * 1000;
const USER_CALL_HISTORY_LIMIT = 25;
const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
const MONGODB_DB_NAME = String(process.env.MONGODB_DB_NAME || 'devchat').trim();
const MONGODB_COLLECTION = String(process.env.MONGODB_COLLECTION || 'app_state').trim();
const APP_STATE_DOC_ID = 'main';
const ALLOW_INSECURE_PASSWORD_RESET = process.env.ALLOW_INSECURE_PASSWORD_RESET === 'true';
const BREVO_API_KEY = String(process.env.BREVO_API_KEY || '').trim();
const BREVO_SENDER_EMAIL = String(process.env.BREVO_SENDER_EMAIL || '').trim();
const BREVO_SENDER_NAME = String(process.env.BREVO_SENDER_NAME || 'DevChat').trim();
const BREVO_REPLY_TO_EMAIL = String(process.env.BREVO_REPLY_TO_EMAIL || '').trim();
const BREVO_REPLY_TO_NAME = String(process.env.BREVO_REPLY_TO_NAME || BREVO_SENDER_NAME).trim();
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
const TRUSTED_UPLOAD_PATH_RE = /^\/uploads\/[a-zA-Z0-9._-]+$/;
const TRUSTED_AVATAR_PATH_RE = /^\/avatars\/[a-zA-Z0-9._-]+$/;
let pendingOtps = new Map();

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

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function normalizeStandalonePhone(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (raw.startsWith('+')) return `+${raw.slice(1).replace(/\D/g, '')}`;
    return '';
}

function defaultData() {
    return { users: [], messages: [], groups: [], statuses: [], sessions: [] };
}

function copyMissingFiles(sourceDir, targetDir) {
    if (!sourceDir || !targetDir || sourceDir === targetDir) return;
    if (!fs.existsSync(sourceDir)) return;
    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (!fs.existsSync(targetPath)) fs.copyFileSync(sourcePath, targetPath);
    }
}

function ensureStorageBootstrap() {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.mkdirSync(AVATARS_DIR, { recursive: true });
    copyMissingFiles(LOCAL_UPLOADS_DIR, UPLOADS_DIR);
    copyMissingFiles(LOCAL_AVATARS_DIR, AVATARS_DIR);

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

function defaultPrivacySettings() {
    return {
        profilePhoto: 'everyone',
        presence: 'contacts',
        phone: 'contacts',
        status: 'mutual-contacts'
    };
}

function normalizePrivacyValue(value, allowedValues, fallback) {
    return allowedValues.includes(value) ? value : fallback;
}

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
    user.contactNames = user.contactNames && typeof user.contactNames === 'object' ? user.contactNames : {};
    user.isAdmin = !!user.isAdmin;
    user.email = normalizeEmail(user.email || '');
    user.emailVerified = !!user.emailVerified;
    user.callHistory = Array.isArray(user.callHistory) ? user.callHistory.slice(0, USER_CALL_HISTORY_LIMIT) : [];
    const privacy = user.privacy && typeof user.privacy === 'object' ? user.privacy : {};
    user.privacy = {
        profilePhoto: normalizePrivacyValue(privacy.profilePhoto, ['everyone', 'contacts', 'nobody'], defaultPrivacySettings().profilePhoto),
        presence: normalizePrivacyValue(privacy.presence, ['everyone', 'contacts', 'nobody'], defaultPrivacySettings().presence),
        phone: normalizePrivacyValue(privacy.phone, ['everyone', 'contacts', 'nobody'], defaultPrivacySettings().phone),
        status: normalizePrivacyValue(privacy.status, ['everyone', 'contacts', 'mutual-contacts', 'nobody'], defaultPrivacySettings().status)
    };
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

function isViewerInOwnerContacts(ownerPseudo, viewerPseudo) {
    const owner = persistentUsers[ownerPseudo];
    const viewer = persistentUsers[viewerPseudo];
    const viewerPhone = getUserPhone(viewer);
    if (!owner || !viewerPhone) return false;
    return owner.contacts.includes(viewerPhone);
}

function privacyAllowsUser(ownerPseudo, viewerPseudo, setting) {
    if (!ownerPseudo || !setting) return false;
    if (ownerPseudo === viewerPseudo) return true;
    const owner = persistentUsers[ownerPseudo];
    if (!owner) return false;
    if (owner.blockedUsers?.includes(viewerPseudo)) return false;
    if (setting === 'everyone') return true;
    if (setting === 'contacts') return isViewerInOwnerContacts(ownerPseudo, viewerPseudo);
    if (setting === 'mutual-contacts') return areMutualContacts(ownerPseudo, viewerPseudo);
    return false;
}

function canViewerSeeStatus(ownerPseudo, viewerPseudo) {
    if (!ownerPseudo || !viewerPseudo) return false;
    const owner = persistentUsers[ownerPseudo];
    if (!owner) return false;
    return privacyAllowsUser(ownerPseudo, viewerPseudo, owner.privacy?.status || defaultPrivacySettings().status);
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
        statuses,
        sessions: [...authSessions.entries()].map(([token, session]) => ({
            token,
            pseudo: session?.pseudo || '',
            expiresAt: Number(session?.expiresAt || 0)
        })).filter(session => session.token && session.pseudo && session.expiresAt > Date.now())
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
    saveData();
    return token;
}

function getSessionFromToken(rawToken, shouldExtend = true) {
    cleanupExpiredSessions();
    const token = String(rawToken || '').trim();
    if (!token) return null;
    const session = authSessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        authSessions.delete(token);
        saveData();
        return null;
    }
    if (shouldExtend) {
        session.expiresAt = Date.now() + SESSION_TTL_MS;
        saveData();
    }
    return session;
}

function cleanupExpiredSessions() {
    const now = Date.now();
    let changed = false;
    for (const [token, session] of authSessions.entries()) {
        if (!session || session.expiresAt <= now) {
            authSessions.delete(token);
            changed = true;
        }
    }
    if (changed) saveData();
}

function revokeSessionToken(rawToken) {
    const token = String(rawToken || '').trim();
    if (!token) return false;
    const existed = authSessions.delete(token);
    if (existed) saveData();
    return existed;
}

function getSessionPseudoFromRequest(req) {
    const header = req.headers.authorization || req.headers['x-session-token'] || '';
    const token = String(header).startsWith('Bearer ') ? String(header).slice(7).trim() : String(header).trim();
    return getSessionFromToken(token)?.pseudo || null;
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

function sanitizeMediaPayload(fileUrl, fileName, fileType, { allowAvatars = false } = {}) {
    const normalizedUrl = String(fileUrl || '').trim();
    const trustedPath = TRUSTED_UPLOAD_PATH_RE.test(normalizedUrl) || (allowAvatars && TRUSTED_AVATAR_PATH_RE.test(normalizedUrl));
    if (!normalizedUrl) {
        return { fileUrl: null, fileName: null, fileType: null };
    }
    if (!trustedPath) {
        return { fileUrl: null, fileName: null, fileType: null, invalid: true };
    }

    const normalizedType = String(fileType || '').toLowerCase().trim();
    const trustedType = normalizedType && (
        ALLOWED_UPLOAD_MIME_PREFIXES.some(prefix => normalizedType.startsWith(prefix)) ||
        ALLOWED_UPLOAD_MIME_TYPES.has(normalizedType)
    );

    return {
        fileUrl: normalizedUrl,
        fileName: String(fileName || '').slice(0, 200) || path.basename(normalizedUrl),
        fileType: trustedType ? normalizedType : null
    };
}

function maskPhoneNumber(phone) {
    const normalized = normalizeStandalonePhone(phone);
    if (!normalized) return '';
    const visibleTail = normalized.slice(-3);
    const hiddenLength = Math.max(0, normalized.length - 4);
    return `${normalized.slice(0, 4)}${'•'.repeat(hiddenLength)}${visibleTail}`;
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

function safeUser(user, viewerPseudo = null) {
    const avatarVisible = privacyAllowsUser(user.pseudo, viewerPseudo, user.privacy?.profilePhoto || defaultPrivacySettings().profilePhoto);
    const presenceVisible = privacyAllowsUser(user.pseudo, viewerPseudo, user.privacy?.presence || defaultPrivacySettings().presence);
    const phoneVisible = privacyAllowsUser(user.pseudo, viewerPseudo, user.privacy?.phone || defaultPrivacySettings().phone);
    return {
        pseudo: user.pseudo,
        avatar: avatarVisible ? user.avatar : '/icons/icon-128.png',
        bio: user.bio || '',
        online: presenceVisible ? (user.online || false) : false,
        lastSeen: presenceVisible ? user.lastSeen : null,
        createdAt: user.createdAt,
        phoneNumber: phoneVisible ? getUserPhone(user) : '',
        avatarHidden: !avatarVisible,
        presenceHidden: !presenceVisible,
        phoneHidden: !phoneVisible
    };
}

function selfUserPayload(user) {
    return {
        ...safeUser(user, user.pseudo),
        email: user.email || '',
        emailVerified: !!user.emailVerified,
        phoneCountryCode: user.phoneCountryCode || '',
        phoneLocalNumber: user.phoneLocalNumber || '',
        phoneNumber: getUserPhone(user),
        contacts: user.contacts || [],
        isAdmin: !!user.isAdmin,
        needsPhoneSetup: !getUserPhone(user),
        blockedUsers: user.blockedUsers || [],
        hiddenChats: user.hiddenChats || {},
        ephemeralSettings: user.ephemeralSettings || {},
        callHistory: user.callHistory || [],
        privacy: user.privacy || defaultPrivacySettings(),
        contactNames: user.contactNames || {},
        contactUsers: contactDirectoryForUser(user.pseudo)
    };
}

function contactDirectoryForUser(userPseudo) {
    const owner = persistentUsers[userPseudo];
    if (!owner) return [];
    ensureUserDefaults(owner);
    return owner.contacts
        .map(phoneNumber => {
            const matchedUser = findUserByPhone(phoneNumber);
            if (!matchedUser || matchedUser.pseudo === userPseudo) return null;
            return {
                ...safeUser(matchedUser, userPseudo),
                phoneNumber,
                contactName: String(owner.contactNames?.[phoneNumber] || '').trim() || matchedUser.pseudo,
                isRegistered: true
            };
        })
        .filter(Boolean);
}

function otpKey(purpose, email) {
    return `${purpose}:${normalizeEmail(email)}`;
}

function cleanupExpiredOtps() {
    const now = Date.now();
    for (const [key, otpState] of pendingOtps.entries()) {
        if (!otpState || otpState.expiresAt <= now) pendingOtps.delete(key);
    }
}

function issueOtpForEmail(purpose, email, payload = {}) {
    cleanupExpiredOtps();
    const normalizedEmail = normalizeEmail(email);
    const key = otpKey(purpose, normalizedEmail);
    const existing = pendingOtps.get(key);
    const now = Date.now();
    if (existing && existing.lastSentAt && now - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000);
        throw new Error(`Réessayez dans ${remainingSeconds}s`);
    }

    const otp = `${Math.floor(100000 + Math.random() * 900000)}`;
    pendingOtps.set(key, {
        otp,
        email: normalizedEmail,
        purpose,
        payload,
        expiresAt: now + OTP_TTL_MS,
        lastSentAt: now,
        attempts: 0
    });
    console.log(`[OTP ${purpose}] ${normalizedEmail}: ${otp}`);
    return { otp, key };
}

function verifyOtpForEmail(purpose, email, otp) {
    cleanupExpiredOtps();
    const key = otpKey(purpose, email);
    const state = pendingOtps.get(key);
    if (!state) return { ok: false, error: 'Code OTP expiré ou introuvable' };
    if (String(state.otp) !== String(otp || '').trim()) {
        state.attempts = (state.attempts || 0) + 1;
        if (state.attempts >= 5) pendingOtps.delete(key);
        return { ok: false, error: 'Code OTP invalide' };
    }
    pendingOtps.delete(key);
    return { ok: true, payload: state.payload || {} };
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
        audience: persistentUsers[status.userPseudo]?.privacy?.status || 'mutual-contacts',
        viewed: !!viewerPseudo && status.viewedBy?.includes(viewerPseudo),
        liked: !!viewerPseudo && status.likedBy?.includes(viewerPseudo),
        likedByCount: Array.isArray(status.likedBy) ? status.likedBy.length : 0,
        viewedByCount: viewers.length,
        repostOf: status.repostOf || null,
        seenBy: viewerPseudo === status.userPseudo
            ? viewers.map(pseudo => persistentUsers[pseudo] ? safeUser(persistentUsers[pseudo], viewerPseudo) : null).filter(Boolean)
            : []
    };
}

function brevoConfigured() {
    return !!(BREVO_API_KEY && BREVO_SENDER_EMAIL);
}

async function sendBrevoEmail({ toEmail, toName, subject, htmlContent, textContent }) {
    if (!brevoConfigured()) {
        throw new Error('Configuration email manquante: BREVO_API_KEY et BREVO_SENDER_EMAIL requis');
    }

    const payload = {
        sender: {
            email: BREVO_SENDER_EMAIL,
            name: BREVO_SENDER_NAME || 'DevChat'
        },
        to: [{ email: toEmail, name: toName || toEmail }],
        subject,
        htmlContent,
        textContent
    };

    if (BREVO_REPLY_TO_EMAIL) {
        payload.replyTo = {
            email: BREVO_REPLY_TO_EMAIL,
            name: BREVO_REPLY_TO_NAME || BREVO_SENDER_NAME || 'DevChat'
        };
    }

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'api-key': BREVO_API_KEY
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let message = `Brevo HTTP ${response.status}`;
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                message = parsed?.message || parsed?.code || message;
            } catch (err) {
                message = raw.slice(0, 200) || message;
            }
        }
        throw new Error(message);
    }

    return response.json().catch(() => ({}));
}

async function sendOtpEmail({ purpose, email, otp, pseudo }) {
    const appName = 'DevChat';
    const actionLabel = purpose === 'reset' ? 'réinitialisation du mot de passe' : 'validation de votre inscription';
    const subject = purpose === 'reset' ? 'Votre code OTP DevChat' : 'Confirmez votre inscription DevChat';
    const safePseudo = String(pseudo || '').trim() || email;
    const htmlContent = `
        <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">
            <h2 style="margin:0 0 12px">${appName}</h2>
            <p>Bonjour ${safePseudo},</p>
            <p>Utilisez ce code pour finaliser la ${actionLabel} :</p>
            <p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:20px 0">${otp}</p>
            <p>Ce code expire dans 10 minutes.</p>
            <p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
        </div>
    `.trim();
    const textContent = [
        `${appName}`,
        `Bonjour ${safePseudo},`,
        `Utilisez ce code pour finaliser la ${actionLabel} : ${otp}`,
        'Ce code expire dans 10 minutes.',
        "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email."
    ].join('\n');

    return sendBrevoEmail({
        toEmail: email,
        toName: safePseudo,
        subject,
        htmlContent,
        textContent
    });
}

function sanitizeCallHistoryEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const pseudo = String(entry.pseudo || '').trim();
    if (!pseudo) return null;
    return {
        pseudo: pseudo.slice(0, 80),
        avatar: String(entry.avatar || '').trim().slice(0, 300),
        mode: entry.mode === 'video' ? 'video' : 'audio',
        direction: entry.direction === 'incoming' ? 'incoming' : 'outgoing',
        status: String(entry.status || 'Terminé').trim().slice(0, 80) || 'Terminé',
        date: new Date(entry.date || Date.now()).toISOString(),
        startedAt: new Date(entry.startedAt || entry.date || Date.now()).toISOString(),
        endedAt: new Date(entry.endedAt || entry.date || Date.now()).toISOString(),
        durationMinutes: Math.max(0, Number(entry.durationMinutes || 0)),
        joinedParticipants: Array.isArray(entry.joinedParticipants)
            ? entry.joinedParticipants.map(name => String(name || '').trim()).filter(Boolean).slice(0, 20)
            : []
    };
}

function _getSocketId(pseudo) {
    return Object.keys(socketUsers).find(sid => socketUsers[sid] === pseudo);
}

function _getSocketIdsForPseudo(pseudo) {
    return Object.keys(socketUsers).filter(sid => socketUsers[sid] === pseudo);
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
    Object.entries(socketUsers).forEach(([sid, viewerPseudo]) => {
        io.to(sid).emit('users-list', Object.values(persistentUsers).map(user => safeUser(user, viewerPseudo)));
    });
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
        users: Object.values(persistentUsers).map(candidate => safeUser(candidate, userPseudo)),
        statuses: activeStatusesForViewer(userPseudo),
        updateChannel: safeUpdateChannel(userPseudo),
        sessionToken: issueSessionToken(userPseudo)
    });

    broadcastUsers();
    io.emit('system', { text: `${userPseudo} a rejoint DevChat` });
}

function ensureAdminAccount() {
    const configuredAdminPseudo = String(process.env.ADMIN_PSEUDO || '').trim();
    const adminPseudo = configuredAdminPseudo || 'Admin DevChat';
    const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex');
    const envPhone = normalizeStandalonePhone(process.env.ADMIN_PHONE);
    const adminCountryCode = normalizeCountryCode(process.env.ADMIN_COUNTRY_CODE || '+242');
    const adminLocalNumber = normalizePhoneLocal(process.env.ADMIN_PHONE_LOCAL || '069325937');
    const adminPhone = envPhone || normalizePhone(adminCountryCode, adminLocalNumber);
    const existingAdmins = Object.values(persistentUsers).filter(user => user.isAdmin);

    // Ne pas réécrire silencieusement les rôles si aucun admin explicite n'est configuré
    // et qu'un administrateur existe déjà dans les données.
    if (!configuredAdminPseudo && existingAdmins.length) {
        existingAdmins.forEach(ensureUserDefaults);
        return;
    }

    // 1. Chercher par pseudo (priorité)
    const existingByPseudo = persistentUsers[adminPseudo];
    if (existingByPseudo) {
        Object.values(persistentUsers).forEach(u => {
            if (u.pseudo !== adminPseudo) u.isAdmin = false;
        });
        existingByPseudo.isAdmin = true;
        existingByPseudo.phoneCountryCode = existingByPseudo.phoneCountryCode || adminCountryCode;
        existingByPseudo.phoneLocalNumber = existingByPseudo.phoneLocalNumber || adminLocalNumber;
        existingByPseudo.phoneNumber = existingByPseudo.phoneNumber || adminPhone;
        ensureUserDefaults(existingByPseudo);
        console.log(`✅ Admin: "${adminPseudo}" promu administrateur`);
        return;
    }

    // 2. Chercher par téléphone
    const existingByPhone = findUserByPhone(adminPhone);
    if (existingByPhone) {
        Object.values(persistentUsers).forEach(u => {
            if (u.pseudo !== existingByPhone.pseudo) u.isAdmin = false;
        });
        existingByPhone.isAdmin = true;
        ensureUserDefaults(existingByPhone);
        console.log(`✅ Admin: "${existingByPhone.pseudo}" promu administrateur via téléphone`);
        return;
    }

    // 3. Créer le compte admin s'il n'existe pas du tout
    Object.values(persistentUsers).forEach(u => {
        if (u.pseudo !== adminPseudo) u.isAdmin = false;
    });

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
    const admin = Object.values(persistentUsers).find(user => user.isAdmin);
    if (!admin) return;

    const existing = getUpdatesChannel();
    if (existing) {
        // S'assurer que l'admin actuel est bien dans les admins et membres du canal
        if (!existing.admins.includes(admin.pseudo)) {
            existing.admins.push(admin.pseudo);
            console.log(`✅ Canal updates: "${admin.pseudo}" ajouté aux admins`);
        }
        if (!existing.members.includes(admin.pseudo)) {
            existing.members.push(admin.pseudo);
        }
        return;
    }

    // Créer le canal s'il n'existe pas
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
    console.log(`✅ Canal updates créé par "${admin.pseudo}"`);
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

app.post('/api/upload-avatar', requireUploadAuth, (req, res) => {
    avatarUpload.single('avatar')(req, res, err => {
        if (err) return res.status(400).json({ error: err.message || 'Upload impossible' });
        if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
        res.json({ avatarUrl: `/avatars/${req.file.filename}` });
    });
});

io.on('connection', (socket) => {
    console.log('🔌 Connexion:', socket.id);

    socket.on('auth', async ({ pseudo, password, isRegister, avatar, countryCode, phoneNumber, sessionToken, email, otp }, callback) => {
        try {
            const normalizedPseudo = String(pseudo || '').trim();
            const normalizedPhone = normalizePhone(countryCode, phoneNumber);
            const normalizedPassword = String(password || '');
            const normalizedEmail = normalizeEmail(email);
            const providedOtp = String(otp || '').trim();
            const tokenSession = getSessionFromToken(sessionToken);
            const tokenUser = tokenSession?.pseudo ? persistentUsers[tokenSession.pseudo] : null;
            const existing = normalizedPhone ? findUserByPhone(normalizedPhone) : persistentUsers[normalizedPseudo];

            if (isRegister) {
                if (!normalizedPseudo) return callback({ success: false, error: 'Pseudo requis' });
                if (!normalizedPhone) return callback({ success: false, error: 'Numero de telephone requis' });
                if (!isValidEmail(normalizedEmail)) return callback({ success: false, error: 'Email invalide' });
                if (normalizedPassword.length < 4) return callback({ success: false, error: 'Mot de passe trop court' });
                if (persistentUsers[normalizedPseudo]) return callback({ success: false, error: 'Ce pseudo est deja pris' });
                if (findUserByPhone(normalizedPhone)) return callback({ success: false, error: 'Ce numero est deja utilise' });
                if (Object.values(persistentUsers).some(user => user.email && user.email === normalizedEmail)) {
                    return callback({ success: false, error: 'Cet email est déjà utilisé' });
                }
                const otpCheck = verifyOtpForEmail('register', normalizedEmail, providedOtp);
                if (!otpCheck.ok) return callback({ success: false, error: otpCheck.error });
                const hash = await bcrypt.hash(normalizedPassword, 10);
                const newUser = ensureUserDefaults({
                    pseudo: normalizedPseudo,
                    password: hash,
                    avatar: avatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(normalizedPseudo)}&backgroundColor=2aabee&fontFamily=Helvetica`,
                    bio: '',
                    email: normalizedEmail,
                    emailVerified: true,
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
                if (tokenUser) {
                    ensureUserDefaults(tokenUser);
                    tokenUser.online = true;
                    tokenUser.lastSeen = new Date().toISOString();
                    saveData();
                    return finalizeAuth(socket, tokenUser, callback);
                }
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

    socket.on('request-register-otp', async ({ pseudo, countryCode, phoneNumber, email }, callback) => {
        const normalizedPseudo = String(pseudo || '').trim();
        const normalizedPhone = normalizePhone(countryCode, phoneNumber);
        const normalizedEmail = normalizeEmail(email);
        if (!normalizedPseudo) return callback?.({ success: false, error: 'Pseudo requis' });
        if (!normalizedPhone) return callback?.({ success: false, error: 'Numero invalide' });
        if (!isValidEmail(normalizedEmail)) return callback?.({ success: false, error: 'Email invalide' });
        if (persistentUsers[normalizedPseudo]) return callback?.({ success: false, error: 'Ce pseudo est deja pris' });
        if (findUserByPhone(normalizedPhone)) return callback?.({ success: false, error: 'Ce numero est deja utilise' });
        if (Object.values(persistentUsers).some(user => user.email && user.email === normalizedEmail)) {
            return callback?.({ success: false, error: 'Cet email est déjà utilisé' });
        }
        try {
            const { otp } = issueOtpForEmail('register', normalizedEmail, {
                pseudo: normalizedPseudo,
                phoneNumber: normalizedPhone
            });
            await sendOtpEmail({
                purpose: 'register',
                email: normalizedEmail,
                otp,
                pseudo: normalizedPseudo
            });
            callback?.({
                success: true,
                message: 'Code OTP envoyé',
                ...(process.env.NODE_ENV === 'production' ? {} : { devOtp: otp })
            });
        } catch (err) {
            if (!String(err.message || '').startsWith('Réessayez dans ')) {
                pendingOtps.delete(otpKey('register', normalizedEmail));
            }
            callback?.({ success: false, error: err.message });
        }
    });

    socket.on('request-reset-otp', async ({ pseudo, countryCode, phoneNumber, email }, callback) => {
        const normalizedEmail = normalizeEmail(email);
        const normalizedPhone = normalizePhone(countryCode, phoneNumber);
        const userByPhone = normalizedPhone ? findUserByPhone(normalizedPhone) : null;
        const userByPseudo = persistentUsers[String(pseudo || '').trim()] || null;
        const user = userByPhone || userByPseudo;
        if (!user) return callback?.({ success: false, error: 'Utilisateur introuvable' });
        if (!isValidEmail(normalizedEmail)) return callback?.({ success: false, error: 'Email invalide' });
        if (normalizeEmail(user.email) !== normalizedEmail) {
            return callback?.({ success: false, error: 'Cet email ne correspond pas au compte' });
        }
        try {
            const { otp } = issueOtpForEmail('reset', normalizedEmail, { pseudo: user.pseudo });
            await sendOtpEmail({
                purpose: 'reset',
                email: normalizedEmail,
                otp,
                pseudo: user.pseudo
            });
            callback?.({
                success: true,
                message: 'Code OTP envoyé',
                ...(process.env.NODE_ENV === 'production' ? {} : { devOtp: otp })
            });
        } catch (err) {
            if (!String(err.message || '').startsWith('Réessayez dans ')) {
                pendingOtps.delete(otpKey('reset', normalizedEmail));
            }
            callback?.({ success: false, error: err.message });
        }
    });

    socket.on('reset-password', async ({ pseudo, countryCode, phoneNumber, oldPassword, newPassword, email, otp }, callback) => {
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

        const normalizedEmail = normalizeEmail(email);
        const normalizedPhone = normalizePhone(countryCode, phoneNumber);
        const userByPhone = normalizedPhone ? findUserByPhone(normalizedPhone) : null;
        const userByPseudo = persistentUsers[String(pseudo || '').trim()] || null;
        const user = userByPhone || userByPseudo;
        if (!user) return callback?.({ success: false, error: 'Utilisateur introuvable' });
        if (normalizeEmail(user.email) !== normalizedEmail) {
            return callback?.({ success: false, error: 'Cet email ne correspond pas au compte' });
        }
        const otpCheck = verifyOtpForEmail('reset', normalizedEmail, otp);
        if (!otpCheck.ok) return callback?.({ success: false, error: otpCheck.error });
        user.password = await bcrypt.hash(normalizedNewPassword, 10);
        saveData();
        return callback?.({ success: true });
    });

    socket.on('update-profile', ({ avatar, bio, countryCode, phoneNumber, email, privacy }, callback) => {
        const pseudo = socketUsers[socket.id];
        if (!pseudo) return callback?.({ success: false });
        const user = persistentUsers[pseudo];
        if (!user) return callback?.({ success: false });
        if (avatar) user.avatar = avatar;
        if (bio !== undefined) user.bio = bio;
        if (email !== undefined) {
            const normalizedEmail = normalizeEmail(email);
            if (!isValidEmail(normalizedEmail)) return callback?.({ success: false, error: 'Email invalide' });
            const duplicate = Object.values(persistentUsers).find(candidate => candidate.email === normalizedEmail && candidate.pseudo !== pseudo);
            if (duplicate) return callback?.({ success: false, error: 'Cet email est déjà utilisé' });
            user.email = normalizedEmail;
            user.emailVerified = true;
        }
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
        if (privacy && typeof privacy === 'object') {
            user.privacy = {
                profilePhoto: normalizePrivacyValue(privacy.profilePhoto, ['everyone', 'contacts', 'nobody'], user.privacy?.profilePhoto || defaultPrivacySettings().profilePhoto),
                presence: normalizePrivacyValue(privacy.presence, ['everyone', 'contacts', 'nobody'], user.privacy?.presence || defaultPrivacySettings().presence),
                phone: normalizePrivacyValue(privacy.phone, ['everyone', 'contacts', 'nobody'], user.privacy?.phone || defaultPrivacySettings().phone),
                status: normalizePrivacyValue(privacy.status, ['everyone', 'contacts', 'mutual-contacts', 'nobody'], user.privacy?.status || defaultPrivacySettings().status)
            };
        }
        saveData();
        broadcastUsers();
        broadcastStatuses();
        callback?.({ success: true, user: selfUserPayload(user) });
    });

    socket.on('save-call-history', ({ entries }, callback) => {
        const pseudo = socketUsers[socket.id];
        const user = persistentUsers[pseudo];
        if (!pseudo || !user) return callback?.({ success: false, error: 'Session invalide' });

        const nextEntries = (Array.isArray(entries) ? entries : [])
            .map(sanitizeCallHistoryEntry)
            .filter(Boolean)
            .slice(0, USER_CALL_HISTORY_LIMIT);

        user.callHistory = nextEntries;
        saveData();
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
        if (!user.contactNames[normalizedPhone]) user.contactNames[normalizedPhone] = targetUser.pseudo;
        saveData();
        broadcastUsers();
        broadcastStatuses();
        callback?.({ success: true, user: selfUserPayload(user), contactUser: safeUser(targetUser, pseudo) });
    });

    socket.on('remove-contact', ({ phoneNumber }, callback) => {
        const pseudo = socketUsers[socket.id];
        const user = persistentUsers[pseudo];
        if (!pseudo || !user) return callback?.({ success: false, error: 'Session invalide' });

        ensureUserDefaults(user);
        const normalizedPhone = normalizeStandalonePhone(phoneNumber);
        user.contacts = user.contacts.filter(contact => contact !== normalizedPhone);
        delete user.contactNames[normalizedPhone];
        saveData();
        broadcastUsers();
        broadcastStatuses();
        callback?.({ success: true, user: selfUserPayload(user) });
    });

    socket.on('sync-contacts', ({ contacts, replaceAll }, callback) => {
        const pseudo = socketUsers[socket.id];
        const user = persistentUsers[pseudo];
        if (!pseudo || !user) return callback?.({ success: false, error: 'Session invalide' });

        ensureUserDefaults(user);
        const nextContacts = replaceAll ? [] : [...user.contacts];
        const nextNames = replaceAll ? {} : { ...user.contactNames };

        (Array.isArray(contacts) ? contacts : []).forEach(entry => {
            const normalizedPhone = normalizeStandalonePhone(entry?.phoneNumber);
            const label = String(entry?.label || '').trim().slice(0, 120);
            if (!normalizedPhone || normalizedPhone === getUserPhone(user)) return;
            if (!nextContacts.includes(normalizedPhone)) nextContacts.push(normalizedPhone);
            if (label) nextNames[normalizedPhone] = label;
        });

        user.contacts = [...new Set(nextContacts)];
        user.contactNames = nextNames;
        saveData();
        broadcastUsers();
        broadcastStatuses();
        callback?.({
            success: true,
            user: selfUserPayload(user),
            matchedCount: contactDirectoryForUser(pseudo).length
        });
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
        const media = sanitizeMediaPayload(fileUrl, fileName, fileType);
        if (media.invalid) {
            return callback?.({ success: false, error: 'Fichier invalide' });
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
            fileUrl: media.fileUrl,
            fileName: media.fileName,
            fileType: media.fileType,
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
        const media = sanitizeMediaPayload(fileUrl, fileName, fileType);
        if (media.invalid) {
            return callback?.({ success: false, error: 'Fichier invalide' });
        }

        const msg = {
            id: uuidv4(),
            type: 'group',
            groupId,
            from,
            content: content || '',
            fileUrl: media.fileUrl,
            fileName: media.fileName,
            fileType: media.fileType,
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

    socket.on('call-user', ({ to, mode }, callback) => {
        const from = socketUsers[socket.id];
        const recipient = persistentUsers[String(to || '').trim()];
        const normalizedMode = mode === 'video' ? 'video' : 'audio';
        if (!from) return callback?.({ success: false, error: 'Session invalide' });
        if (!recipient) return callback?.({ success: false, error: 'Utilisateur introuvable' });
        if (recipient.blockedUsers?.includes(from)) {
            return callback?.({ success: false, error: 'Cette personne vous a bloqué' });
        }
        const targetSid = _getSocketId(recipient.pseudo);
        if (!targetSid) return callback?.({ success: false, error: 'Utilisateur hors ligne' });
        io.to(targetSid).emit('incoming-call', {
            from,
            mode: normalizedMode,
            avatar: persistentUsers[from]?.avatar || ''
        });
        callback?.({ success: true });
    });

    socket.on('call-response', ({ to, accepted, mode, reason }, callback) => {
        const from = socketUsers[socket.id];
        const targetSid = _getSocketId(String(to || '').trim());
        if (!from || !targetSid) return callback?.({ success: false, error: 'Utilisateur indisponible' });
        io.to(targetSid).emit('call-response', {
            from,
            accepted: !!accepted,
            mode: mode === 'video' ? 'video' : 'audio',
            reason: String(reason || '')
        });
        callback?.({ success: true });
    });

    socket.on('call-signal', ({ to, data }, callback) => {
        const from = socketUsers[socket.id];
        const targetSid = _getSocketId(String(to || '').trim());
        if (!from || !targetSid || !data || typeof data !== 'object') {
            return callback?.({ success: false, error: 'Signal invalide' });
        }
        io.to(targetSid).emit('call-signal', { from, data });
        callback?.({ success: true });
    });

    socket.on('end-call', ({ to, reason }, callback) => {
        const from = socketUsers[socket.id];
        const targetSid = _getSocketId(String(to || '').trim());
        if (!from) return callback?.({ success: false, error: 'Session invalide' });
        if (targetSid) io.to(targetSid).emit('call-ended', { from, reason: String(reason || '') });
        callback?.({ success: true });
    });

    socket.on('create-status', ({ text, mediaUrl, fileType, fileName, background }, callback) => {
        const from = socketUsers[socket.id];
        if (!from) return callback?.({ success: false, error: 'Session invalide' });
        if (!text && !mediaUrl) return callback?.({ success: false, error: 'Statut vide' });
        if (!getUserPhone(persistentUsers[from])) {
            return callback?.({ success: false, error: 'Ajoutez votre numero principal avant de publier un statut' });
        }
        const media = sanitizeMediaPayload(mediaUrl, fileName, fileType);
        if (media.invalid) {
            return callback?.({ success: false, error: 'Media invalide' });
        }

        const status = {
            id: uuidv4(),
            userPseudo: from,
            text: text || '',
            mediaUrl: media.fileUrl,
            fileType: media.fileType,
            fileName: media.fileName,
            background: typeof background === 'string' ? background : null,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + STATUS_TTL_MS).toISOString(),
            viewedBy: [from],
            likedBy: [],
            repostOf: null
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

    socket.on('toggle-status-like', ({ statusId }, callback) => {
        const from = socketUsers[socket.id];
        const status = statuses.find(item => item.id === statusId);
        if (!from || !status || isExpired(status.expiresAt) || !canViewerSeeStatus(status.userPseudo, from)) {
            return callback?.({ success: false, error: 'Statut introuvable' });
        }
        status.likedBy = Array.isArray(status.likedBy) ? status.likedBy : [];
        const index = status.likedBy.indexOf(from);
        if (index === -1) status.likedBy.push(from);
        else status.likedBy.splice(index, 1);
        saveData();
        broadcastStatuses();
        callback?.({ success: true, status: safeStatus(status, from) });
    });

    socket.on('repost-status', ({ statusId }, callback) => {
        const from = socketUsers[socket.id];
        const original = statuses.find(item => item.id === statusId);
        if (!from || !original || isExpired(original.expiresAt) || !canViewerSeeStatus(original.userPseudo, from)) {
            return callback?.({ success: false, error: 'Statut introuvable' });
        }
        const repost = {
            id: uuidv4(),
            userPseudo: from,
            text: original.text || '',
            mediaUrl: original.mediaUrl || null,
            fileType: original.fileType || null,
            fileName: original.fileName || null,
            background: original.background || null,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + STATUS_TTL_MS).toISOString(),
            viewedBy: [from],
            likedBy: [],
            repostOf: {
                statusId: original.id,
                userPseudo: original.userPseudo
            }
        };
        statuses.push(repost);
        saveData();
        broadcastStatuses();
        callback?.({ success: true, status: safeStatus(repost, from) });
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
            .map(user => {
                const visibleUser = safeUser(user, from);
                return {
                    ...visibleUser,
                    maskedPhoneNumber: maskPhoneNumber(visibleUser.phoneNumber || ''),
                    blocked: persistentUsers[from]?.blockedUsers?.includes(user.pseudo) || false,
                    inContacts: persistentUsers[from]?.contacts?.includes(getUserPhone(user)) || false
                };
            });
        callback(results);
    });

    socket.on('logout', ({ sessionToken }, callback) => {
        revokeSessionToken(sessionToken);
        callback?.({ success: true });
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
        delete socketUsers[socket.id];
        if (pseudo && persistentUsers[pseudo] && !_getSocketIdsForPseudo(pseudo).length) {
            persistentUsers[pseudo].online = false;
            persistentUsers[pseudo].lastSeen = new Date().toISOString();
            saveData();
            broadcastUsers();
        }
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
    authSessions = new Map(
        (Array.isArray(loaded.sessions) ? loaded.sessions : [])
            .filter(session => session?.token && session?.pseudo && Number(session?.expiresAt || 0) > Date.now())
            .map(session => [String(session.token), {
                pseudo: String(session.pseudo),
                expiresAt: Number(session.expiresAt)
            }])
    );

    // ── Log tous les users chargés depuis MongoDB ─────────────
    const allPseudos = Object.keys(persistentUsers);
    console.log(`📦 Users chargés depuis MongoDB: [${allPseudos.join(', ')}]`);

    ensureAdminAccount();
    ensureUpdatesChannel();

    // ── Vérification finale admin ──────────────────────────────
    const adminPseudo = String(process.env.ADMIN_PSEUDO || 'Admin DevChat').trim();
    const finalAdmin = persistentUsers[adminPseudo];
    if (finalAdmin) {
        console.log(`🔑 Admin final: "${adminPseudo}" isAdmin=${finalAdmin.isAdmin}`);
    } else {
        console.warn(`⚠️  Pseudo "${adminPseudo}" introuvable. Users dispo: [${Object.keys(persistentUsers).join(', ')}]`);
    }

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
