// ═══════════════════════════════════════════════════════════════
//  DevChat - Client Script
// ═══════════════════════════════════════════════════════════════
const socket = io({
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 45000
});

// ── State ──────────────────────────────────────────────────────
let currentUser   = null;   // { pseudo, avatar, bio }
let currentChat   = null;   // { type:'private'|'group', id, name, avatar, isSecret }
let conversations = [];     // all messages
let groups        = [];
let allUsers      = [];
let replyTo       = null;
let selectedMembers = [];   // for group creation
let typingTimers  = {};
let unreadCounts  = {};
let mediaRecorder = null;
let isRecording   = false;
let regAvatarUrl  = null;
let pendingRegistrationAvatarFile = null;
let socketListenersInitialized = false;
let sendLockUntil = 0;
let statuses = [];
let statusUpload = null;
let activeStatusGroup = [];
let activeStatusIndex = 0;
let appStats = null;
let knownPrivateChats = [];
let updateChannelInfo = null;
let groupAvatarUrl = null;
let manageGroupAvatarUrl = null;
let authSessionToken = null;
let selectedStatusTheme = 'ocean';
let mediaRecorderStream = null;
let selectedMessageIds = new Set();
let activeCall = null;
let pendingIncomingCall = null;
let callHistory = [];
let pendingInviteContext = null;
let qrScannerStream = null;
let qrScanRaf = 0;
let qrBarcodeDetector = null;

function formatFileSize(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '';
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} Ko`;
    return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} Mo`;
}

function normalizeCallHistory(entries) {
    if (!Array.isArray(entries)) return [];
    return entries
        .filter(entry => entry && entry.pseudo)
        .map(entry => ({
            pseudo: String(entry.pseudo || '').trim(),
            avatar: String(entry.avatar || '').trim(),
            mode: entry.mode === 'video' ? 'video' : 'audio',
            direction: entry.direction === 'incoming' ? 'incoming' : 'outgoing',
            status: String(entry.status || 'Terminé').trim() || 'Terminé',
            date: entry.date || new Date().toISOString(),
            startedAt: entry.startedAt || entry.date || new Date().toISOString(),
            endedAt: entry.endedAt || entry.date || new Date().toISOString(),
            durationMinutes: Number(entry.durationMinutes || 0),
            joinedParticipants: Array.isArray(entry.joinedParticipants) ? entry.joinedParticipants : []
        }))
        .slice(0, 25);
}

function parseInviteParam(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const [groupIdPart, tokenPart] = raw.split(':');
    const groupId = decodeURIComponent(groupIdPart || '').trim();
    const inviteToken = decodeURIComponent(tokenPart || '').trim();
    if (!groupId || !inviteToken) return null;
    return { groupId, inviteToken };
}

function readPendingInviteFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        return parseInviteParam(params.get('invite'));
    } catch (err) {
        return null;
    }
}

function clearInviteParamFromUrl() {
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        const next = `${url.pathname}${url.search}${url.hash}`;
        window.history.replaceState({}, '', next);
    } catch (err) {
        // Ignore URL cleanup failures.
    }
}

function buildProfileQrPayload() {
    const params = new URLSearchParams();
    params.set('pseudo', currentUser?.pseudo || '');
    if (currentUser?.phoneNumber) params.set('phone', currentUser.phoneNumber);
    if (currentUser?.avatar) params.set('avatar', currentUser.avatar);
    return `devchat://contact?${params.toString()}`;
}

function buildQrImageUrl(text) {
    if (typeof qrcode !== 'function') return '';
    const qr = qrcode(0, 'M');
    qr.addData(String(text || ''));
    qr.make();
    return qr.createDataURL(8, 12);
}

function parseScannedQrPayload(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const inviteFromUrl = (() => {
        try {
            const url = new URL(raw, window.location.origin);
            return parseInviteParam(url.searchParams.get('invite'));
        } catch (err) {
            return null;
        }
    })();
    if (inviteFromUrl) return { type: 'invite', ...inviteFromUrl };

    if (raw.startsWith('devchat://contact?')) {
        const query = raw.split('?')[1] || '';
        const params = new URLSearchParams(query);
        return {
            type: 'contact',
            pseudo: String(params.get('pseudo') || '').trim(),
            phone: String(params.get('phone') || '').trim(),
            avatar: String(params.get('avatar') || '').trim()
        };
    }

    const directInvite = parseInviteParam(raw);
    if (directInvite) return { type: 'invite', ...directInvite };
    return null;
}

function ensureQrDetector() {
    if (!('BarcodeDetector' in window)) return null;
    if (!qrBarcodeDetector) qrBarcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
    return qrBarcodeDetector;
}

function getQrImageDataFromSource(source) {
    const canvas = $('qrScannerCanvas');
    if (!canvas) throw new Error('Canvas QR introuvable');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const width = source.videoWidth || source.naturalWidth || source.width;
    const height = source.videoHeight || source.naturalHeight || source.height;
    if (!width || !height) throw new Error('Source QR illisible');
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(source, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
}

function stopQrScanner() {
    if (qrScanRaf) {
        cancelAnimationFrame(qrScanRaf);
        qrScanRaf = 0;
    }
    if (qrScannerStream) {
        qrScannerStream.getTracks().forEach(track => track.stop());
        qrScannerStream = null;
    }
    const video = $('qrScannerVideo');
    if (video) video.srcObject = null;
}

function closeQrScannerModal() {
    stopQrScanner();
    closeModal('qrScannerModal');
}

function consumeGroupInvite(groupId, inviteToken, successMessage = 'Groupe rejoint') {
    if (!groupId || !inviteToken) return;
    socket.emit('join-public-group', { groupId, inviteToken }, (res) => {
        if (!res?.success) {
            showToast(res?.error || 'Invitation invalide');
            return;
        }
        upsertGroup(res.group);
        renderConversations();
        openChat({
            type: 'group',
            id: res.group.id,
            name: res.group.name,
            avatar: res.group.avatar
        });
        clearInviteParamFromUrl();
        pendingInviteContext = null;
        showToast(successMessage);
    });
}

function applyScannedQrPayload(payload) {
    if (!payload) {
        showToast('QR non reconnu');
        return;
    }
    if (payload.type === 'invite') {
        closeQrScannerModal();
        consumeGroupInvite(payload.groupId, payload.inviteToken, 'Invitation acceptée');
        return;
    }
    if (payload.type === 'contact') {
        closeQrScannerModal();
        if (payload.pseudo && payload.pseudo === currentUser?.pseudo) {
            showToast('Ceci est votre propre QR');
            return;
        }
        if (payload.phone) {
            addContactByPhone(payload.phone, (res) => {
                const matched = res?.contactUser;
                if (matched?.pseudo) {
                    openChat({
                        type: 'private',
                        id: matched.pseudo,
                        name: matched.contactName || matched.pseudo,
                        avatar: matched.avatar || payload.avatar || dicebear(matched.pseudo)
                    });
                } else if (payload.pseudo) {
                    openChat({
                        type: 'private',
                        id: payload.pseudo,
                        name: payload.pseudo,
                        avatar: payload.avatar || dicebear(payload.pseudo)
                    });
                }
            });
            return;
        }
        if (payload.pseudo) {
            closeQrScannerModal();
            openChat({
                type: 'private',
                id: payload.pseudo,
                name: payload.pseudo,
                avatar: payload.avatar || dicebear(payload.pseudo)
            });
            return;
        }
    }
    showToast('QR non pris en charge');
}

function persistCallHistory() {
    if (!socket.connected || !currentUser?.pseudo) return;
    socket.emit('save-call-history', { entries: callHistory.slice(0, 25) }, (res) => {
        if (res?.success && res.user) syncCurrentUser(res.user);
    });
}

function getRegisteredContacts() {
    return Array.isArray(currentUser?.contactUsers) ? currentUser.contactUsers : [];
}

function filteredRegisteredContacts(query = '') {
    const q = String(query || '').trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return getRegisteredContacts().filter(contact => {
        if (!q) return true;
        const name = String(contact.contactName || contact.pseudo || '').toLowerCase();
        const pseudo = String(contact.pseudo || '').toLowerCase();
        const phone = String(contact.phoneNumber || '').replace(/\D/g, '');
        return name.includes(q) || pseudo.includes(q) || (digits && phone.includes(digits));
    });
}

function parseManualContactsInput(raw) {
    return String(raw || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const [labelPart, phonePart] = line.includes(',') ? line.split(/,(.+)/) : ['', line];
            return {
                label: String(labelPart || '').trim(),
                phoneNumber: String(phonePart || '').trim()
            };
        })
        .filter(entry => entry.phoneNumber);
}

function persistSessionAuth(session) {
    if (!session?.pseudo || !session?.token) return;
    localStorage.setItem('devchat_auth', JSON.stringify({
        pseudo: session.pseudo,
        token: session.token
    }));
}

function clearSessionAuth() {
    localStorage.removeItem('devchat_auth');
}

function getReadReceiptsEnabled() {
    const stored = localStorage.getItem('devchat_read_receipts');
    return stored === null ? true : stored === '1';
}

function setReadReceiptsEnabled(enabled) {
    localStorage.setItem('devchat_read_receipts', enabled ? '1' : '0');
}

function shouldEmitReadReceipt(message) {
    if (!message) return false;
    if (message.type === 'group') return true;
    return getReadReceiptsEnabled();
}

const EPHEMERAL_CHOICES = [
    { label: 'Désactivé', value: 0 },
    { label: '1 min', value: 60 * 1000 },
    { label: '1 heure', value: 60 * 60 * 1000 },
    { label: '24 heures', value: 24 * 60 * 60 * 1000 }
];
const COUNTRY_CODES = [
    { code: '+242', label: 'Congo (+242)' },
    { code: '+243', label: 'RDC (+243)' },
    { code: '+33', label: 'France (+33)' },
    { code: '+32', label: 'Belgique (+32)' },
    { code: '+225', label: "Cote d'Ivoire (+225)" },
    { code: '+221', label: 'Senegal (+221)' },
    { code: '+237', label: 'Cameroun (+237)' },
    { code: '+234', label: 'Nigeria (+234)' },
    { code: '+1', label: 'USA/Canada (+1)' }
];
const STATUS_THEMES = [
    { key: 'ocean', bg: 'linear-gradient(135deg, #0f5cc0, #23a6d5)' },
    { key: 'sunset', bg: 'linear-gradient(135deg, #ff6a88, #ff9a44)' },
    { key: 'forest', bg: 'linear-gradient(135deg, #0b8f6a, #74c365)' },
    { key: 'night', bg: 'linear-gradient(135deg, #232526, #414345)' },
    { key: 'berry', bg: 'linear-gradient(135deg, #7f00ff, #e100ff)' },
    { key: 'gold', bg: 'linear-gradient(135deg, #8a6a00, #f7b733)' }
];

// ── DOM Shortcuts ──────────────────────────────────────────────
const $ = id => document.getElementById(id);
$('chatArea')?.appendChild($('replyPreview'));
$('chatArea')?.appendChild($('messageSelectionBar'));

async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (authSessionToken) headers.set('Authorization', `Bearer ${authSessionToken}`);
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || 'Requete impossible');
    }
    return data;
}

function statusThemeByKey(key) {
    return STATUS_THEMES.find(theme => theme.key === key) || STATUS_THEMES[0];
}

function statusBackgroundStyle(key) {
    return statusThemeByKey(key).bg;
}

function statusTextPreviewHtml(text, key) {
    return `<div class="status-text-preview-inner">${escHtml(text || 'Votre texte de statut')}</div>`;
}

function maskPhoneNumber(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return 'Numéro masqué';
    return normalized;
}

function isReadonlyOfficialChannel(chat = currentChat) {
    if (!chat || chat.type !== 'group') return false;
    const group = groups.find(item => item.id === chat.id);
    if (!group?.isUpdatesChannel) return false;
    // L'admin de l'app peut toujours écrire dans le canal
    if (currentUser?.isAdmin) return false;
    // Les admins du groupe peuvent aussi écrire
    if (group?.admins?.includes(currentUser?.pseudo)) return false;
    return true;
}

function refreshChatComposerState() {
    const readonly = isReadonlyOfficialChannel();
    $('chatReadonlyNotice').style.display = readonly ? 'block' : 'none';
    $('attachBtn').style.display = readonly ? 'none' : 'inline-flex';
    $('emojiBtn').style.display = readonly ? 'none' : 'inline-flex';
    $('messageInput').disabled = readonly;
    $('messageInput').placeholder = readonly ? 'Canal officiel en lecture seule' : 'Message...';
    updateComposerActionButtons();
}

function updateComposerActionButtons() {
    if (!$('sendBtn') || !$('voiceRecordBtn') || !$('messageInput')) return;
    const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    if (isReadonlyOfficialChannel()) {
        $('sendBtn').style.display = 'none';
        $('voiceRecordBtn').style.display = 'none';
        return;
    }
    const hasText = !!$('messageInput').value.trim();
    $('sendBtn').style.display = hasText || isRecording ? 'inline-flex' : 'none';
    $('voiceRecordBtn').style.display = !canRecord || hasText ? 'none' : 'inline-flex';
}

function stopVoiceStream() {
    if (mediaRecorderStream) {
        mediaRecorderStream.getTracks().forEach(track => track.stop());
        mediaRecorderStream = null;
    }
}

function clearMessageSelection() {
    selectedMessageIds.clear();
    $('messageSelectionBar').style.display = 'none';
}

function updateMessageSelectionUI() {
    const count = selectedMessageIds.size;
    $('messageSelectionBar').style.display = count ? 'flex' : 'none';
    $('messageSelectionCount').textContent = `${count} sélectionné${count > 1 ? 's' : ''}`;
}

function toggleMessageSelection(messageId) {
    if (!messageId) return;
    if (selectedMessageIds.has(messageId)) selectedMessageIds.delete(messageId);
    else selectedMessageIds.add(messageId);
    updateMessageSelectionUI();
    renderMessages();
}

function promptEditMessage(msg) {
    if (!msg || msg.from !== currentUser?.pseudo || msg.deleted || msg.fileUrl) return;
    const next = window.prompt('Modifier votre message', msg.content || '');
    if (next === null) return;
    socket.emit('edit-message', { messageId: msg.id, content: next }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        const local = conversations.find(item => item.id === msg.id);
        if (local) Object.assign(local, res.message);
        renderMessages();
        renderConversations();
        showToast('Message modifié');
    });
}

function addContactByPhone(phoneNumber, onSuccess) {
    if (!phoneNumber) return;
    const normalized = String(phoneNumber);
    const digits = normalized.startsWith('+') ? normalized.slice(1) : normalized;
    const code = COUNTRY_CODES
        .map(item => item.code)
        .sort((a, b) => b.length - a.length)
        .find(item => normalized.startsWith(item));
    const countryCode = code || '+242';
    const localNumber = normalized.startsWith(countryCode) ? digits.slice(countryCode.slice(1).length) : digits;
    socket.emit('add-contact', { countryCode, phoneNumber: localNumber }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        currentUser = res.user;
        renderContactsList();
        if (typeof onSuccess === 'function') onSuccess(res);
        showToast('Contact ajouté');
    });
}

async function sendUploadedMessageFile(filePayload) {
    if (!currentChat || !filePayload) return;
    const payload = {
        content: '',
        fileUrl: filePayload.fileUrl,
        fileName: filePayload.fileName,
        fileType: filePayload.fileType,
        replyTo: replyTo?.id || null,
        isSecret: currentChat.type === 'private' ? !!currentChat.isSecret : false
    };
    if (currentChat.type === 'private') {
        payload.to = currentChat.id;
        socket.emit('private-message', payload, (res) => {
            if (!res?.success) showToast(res?.error || 'Erreur d\'envoi');
        });
    } else {
        payload.groupId = currentChat.id;
        socket.emit('group-message', payload, (res) => {
            if (!res?.success) showToast(res?.error || 'Erreur d\'envoi');
        });
    }
    cancelReply();
}

function removeConversationMessage(messageId) {
    conversations = conversations.filter(message => message.id !== messageId);
}

function upsertOptimisticMessage(message) {
    const index = conversations.findIndex(entry => entry.id === message.id);
    if (index === -1) conversations.push(message);
    else conversations[index] = { ...conversations[index], ...message };
    if (currentChat) renderMessages();
    renderConversations();
}

function buildPendingMediaMessage({ chat, file, fileUrl, fileType, fileName, replyMessageId = null }) {
    if (!chat || !currentUser?.pseudo) return null;
    return {
        id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: chat.type,
        from: currentUser.pseudo,
        to: chat.type === 'private' ? chat.id : undefined,
        groupId: chat.type === 'group' ? chat.id : undefined,
        content: '',
        fileUrl,
        fileName: fileName || file?.name || 'media',
        fileType: fileType || file?.type || '',
        fileSize: Number(file?.size || 0),
        replyTo: replyMessageId || null,
        date: new Date().toISOString(),
        readBy: [currentUser.pseudo],
        reactions: {},
        pendingStatus: 'uploading',
        localPreviewUrl: fileUrl
    };
}

function markPendingMessageFailed(tempId, errorMessage = 'Échec de l’envoi') {
    const localMessage = conversations.find(message => message.id === tempId);
    if (!localMessage) return;
    localMessage.pendingStatus = 'failed';
    localMessage.pendingError = errorMessage;
    if (currentChat) renderMessages();
    renderConversations();
}

function reconcilePendingMessage(tempId, serverMessage) {
    const localMessage = conversations.find(message => message.id === tempId);
    if (localMessage?.localPreviewUrl && localMessage.localPreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(localMessage.localPreviewUrl);
    }
    removeConversationMessage(tempId);
    if (serverMessage) upsertConversationMessage(serverMessage);
    if (currentChat) renderMessages();
    renderConversations();
}

async function sendChatFileWithOptimisticPreview(file, options = {}) {
    if (!file || !currentChat) return;
    const chat = {
        type: currentChat.type,
        id: currentChat.id,
        isSecret: !!currentChat.isSecret
    };
    const previewUrl = URL.createObjectURL(file);
    const pendingMessage = buildPendingMediaMessage({
        chat,
        file,
        fileUrl: previewUrl,
        fileType: file.type,
        fileName: file.name,
        replyMessageId: options.replyTo || replyTo?.id || null
    });
    if (!pendingMessage) return;

    upsertOptimisticMessage(pendingMessage);
    if (!options.keepReply) cancelReply();

    try {
        const fd = new FormData();
        fd.append('file', file);
        const uploaded = await apiFetch('/api/upload', { method: 'POST', body: fd });
        const payload = {
            content: options.content || '',
            fileUrl: uploaded.fileUrl,
            fileName: uploaded.fileName,
            fileType: uploaded.fileType,
            fileSize: uploaded.fileSize || file.size || 0,
            replyTo: pendingMessage.replyTo,
            isSecret: chat.type === 'private' ? chat.isSecret : false
        };
        const eventName = chat.type === 'private' ? 'private-message' : 'group-message';
        const transportPayload = chat.type === 'private'
            ? { ...payload, to: chat.id }
            : { ...payload, groupId: chat.id };

        await new Promise((resolve, reject) => {
            socket.emit(eventName, transportPayload, (res) => {
                if (!res?.success || !res.message) {
                    reject(new Error(res?.error || 'Erreur d\'envoi'));
                    return;
                }
                reconcilePendingMessage(pendingMessage.id, res.message);
                resolve(res.message);
            });
        });
    } catch (err) {
        markPendingMessageFailed(pendingMessage.id, err.message || 'Échec de l’envoi');
        throw err;
    }
}

function renderStatusThemePicker() {
    const wrap = $('statusThemePicker');
    if (!wrap) return;
    wrap.innerHTML = STATUS_THEMES.map(theme => `
        <button
            type="button"
            class="status-theme-swatch ${theme.key === selectedStatusTheme ? 'active' : ''}"
            data-theme="${theme.key}"
            style="background:${theme.bg}"
            title="${theme.key}"
        ></button>
    `).join('');
}

function updateStatusComposerPreview() {
    const text = $('statusTextInput').value.trim();
    const preview = $('statusComposerPreview');
    if (statusUpload) return;
    if (text) {
        preview.classList.add('status-text-preview');
        preview.style.background = statusBackgroundStyle(selectedStatusTheme);
        preview.innerHTML = statusTextPreviewHtml(text, selectedStatusTheme);
    } else {
        preview.classList.remove('status-text-preview');
        preview.style.background = '';
        preview.innerHTML = 'Ajoutez un texte, une image ou une vidéo';
    }
}

// ═══════════════════════════════════════════════════════════════
//  AUTH SCREEN
// ═══════════════════════════════════════════════════════════════
function showPanel(id) {
    document.querySelectorAll('.auth-card').forEach(c => c.classList.remove('active'));
    $(id).classList.add('active');
    ['loginError', 'registerError', 'registerSuccess', 'resetError', 'resetSuccess'].forEach(elId => {
        if ($(elId)) $(elId).textContent = '';
    });
}

function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim().toLowerCase());
}

function setButtonBusy(buttonId, busy, busyLabel = 'Chargement...') {
    const btn = $(buttonId);
    if (!btn) return;
    if (!btn.dataset.defaultLabel) btn.dataset.defaultLabel = btn.innerHTML;
    btn.disabled = !!busy;
    btn.classList.toggle('loading', !!busy);
    btn.innerHTML = busy ? `<span>${busyLabel}</span>` : btn.dataset.defaultLabel;
}

function initCountrySelect(id, defaultCode = '+242') {
    const select = $(id);
    if (!select) return;
    select.innerHTML = COUNTRY_CODES.map(country => `<option value="${country.code}">${country.label}</option>`).join('');
    select.value = defaultCode;
}

function initCountrySelectors() {
    ['loginCountryCode', 'regCountryCode', 'resetCountryCode', 'profileCountryCode']
        .forEach(id => initCountrySelect(id));
}

initCountrySelectors();

async function uploadAvatarFile(file) {
    const fd = new FormData();
    fd.append('avatar', file);
    return apiFetch('/api/upload-avatar', { method: 'POST', body: fd });
}

async function flushPendingRegistrationAvatar() {
    if (!pendingRegistrationAvatarFile || !currentUser || !authSessionToken) return;
    try {
        const data = await uploadAvatarFile(pendingRegistrationAvatarFile);
        pendingRegistrationAvatarFile = null;
        currentUser.avatar = data.avatarUrl;
        socket.emit('update-profile', { avatar: data.avatarUrl, bio: currentUser.bio || '', countryCode: currentUser.phoneCountryCode || '+242', phoneNumber: currentUser.phoneLocalNumber || '' }, (res) => {
            if (res?.success) {
                currentUser = res.user;
                updateSidebarUser();
                renderConversations();
            }
        });
    } catch (err) {
        showToast('Photo de profil non synchronisée');
    }
}

// Avatar preview for registration
$('regAvatarPreview').addEventListener('click', () => $('regAvatarFile').click());
$('regAvatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    pendingRegistrationAvatarFile = file;
    regAvatarUrl = URL.createObjectURL(file);
    $('regAvatarPreview').innerHTML = `<img src="${regAvatarUrl}" alt="">`;
});

// ── Login ──────────────────────────────────────────────────────
$('loginBtn').addEventListener('click', async () => {
    const pseudo   = $('loginLegacyPseudo').value.trim();
    const countryCode = $('loginCountryCode').value;
    const phoneNumber = $('loginPhoneNumber').value.trim();
    const password = $('loginPassword').value.trim();
    if ((!phoneNumber && !pseudo) || !password) return showAuthError('loginError', 'Ajoutez un numero ou un pseudo existant');
    $('loginBtn').classList.add('loading');
    socket.emit('auth', { pseudo, countryCode, phoneNumber, password, isRegister: false }, (res) => {
        $('loginBtn').classList.remove('loading');
        if (res.success) {
            onAuthSuccess(res);
        } else {
            clearSessionAuth();
            showAuthError('loginError', res.error);
        }
    });
});
$('loginPassword').addEventListener('keypress', e => { if (e.key === 'Enter') $('loginBtn').click(); });

// ── Register ───────────────────────────────────────────────────
$('registerBtn').addEventListener('click', async () => {
    const pseudo = $('regPseudo').value.trim();
    const email = $('regEmail').value.trim();
    const countryCode = $('regCountryCode').value;
    const phoneNumber = $('regPhoneNumber').value.trim();
    const pw1    = $('regPassword').value;
    const pw2    = $('regPassword2').value;
    const otp = $('regOtp').value.trim();
    if (!pseudo || !pw1 || !phoneNumber || !email) return showAuthError('registerError', 'Remplissez tous les champs principaux');
    if (!isValidEmail(email)) return showAuthError('registerError', 'Email invalide');
    if (pw1 !== pw2)     return showAuthError('registerError', 'Mots de passe différents');
    if (pw1.length < 4)  return showAuthError('registerError', 'Mot de passe trop court (min 4 caractères)');
    $('registerBtn').classList.add('loading');
    socket.emit('auth', { pseudo, email, otp, countryCode, phoneNumber, password: pw1, isRegister: true, avatar: null }, (res) => {
        $('registerBtn').classList.remove('loading');
        if (res.success) onAuthSuccess(res);
        else showAuthError('registerError', res.error);
    });
});

$('sendRegisterOtpBtn').addEventListener('click', () => {
    const pseudo = $('regPseudo').value.trim();
    const email = $('regEmail').value.trim();
    const countryCode = $('regCountryCode').value;
    const phoneNumber = $('regPhoneNumber').value.trim();
    if (!pseudo || !email || !phoneNumber) return showAuthError('registerError', 'Pseudo, email et numéro requis');
    if (!isValidEmail(email)) return showAuthError('registerError', 'Email invalide');
    setButtonBusy('sendRegisterOtpBtn', true, 'Envoi OTP...');
    socket.emit('request-register-otp', { pseudo, email, countryCode, phoneNumber }, (res) => {
        setButtonBusy('sendRegisterOtpBtn', false);
        if (!res?.success) return showAuthError('registerError', res?.error || 'Erreur');
        if (res.otpOptional) {
            $('registerSuccess').textContent = 'Vous pouvez créer le compte directement sans OTP.';
            showToast('Inscription sans OTP activée');
            return;
        }
        $('registerSuccess').textContent = res.devOtp ? `OTP dev: ${res.devOtp}` : 'Code OTP envoyé sur votre email';
        showToast(res.devOtp ? `OTP dev: ${res.devOtp}` : 'Code OTP envoyé');
    });
});

// ── Reset ──────────────────────────────────────────────────────
$('resetBtn').addEventListener('click', () => {
    const pseudo = $('resetPseudo').value.trim();
    const countryCode = $('resetCountryCode').value;
    const phoneNumber = $('resetPhoneNumber').value.trim();
    const email = $('resetEmail').value.trim();
    const otp = $('resetOtp').value.trim();
    const newPw  = $('resetNewPw').value;
    if ((!pseudo && !phoneNumber) || !newPw || !email || !otp) return showAuthError('resetError', 'Complétez pseudo/numéro, email, OTP et nouveau mot de passe');
    if (!isValidEmail(email)) return showAuthError('resetError', 'Email invalide');
    socket.emit('reset-password', { pseudo, countryCode, phoneNumber, email, otp, newPassword: newPw }, (res) => {
        if (res.success) {
            $('resetError').textContent = '';
            $('resetSuccess').textContent = 'Mot de passe modifié ! Connectez-vous.';
            setTimeout(() => showPanel('loginPanel'), 1500);
        } else showAuthError('resetError', res.error);
    });
});

$('sendResetOtpBtn').addEventListener('click', () => {
    const pseudo = $('resetPseudo').value.trim();
    const countryCode = $('resetCountryCode').value;
    const phoneNumber = $('resetPhoneNumber').value.trim();
    const email = $('resetEmail').value.trim();
    if ((!pseudo && !phoneNumber) || !email) return showAuthError('resetError', 'Ajoutez pseudo/numéro et email');
    if (!isValidEmail(email)) return showAuthError('resetError', 'Email invalide');
    setButtonBusy('sendResetOtpBtn', true, 'Envoi OTP...');
    socket.emit('request-reset-otp', { pseudo, countryCode, phoneNumber, email }, (res) => {
        setButtonBusy('sendResetOtpBtn', false);
        if (!res?.success) return showAuthError('resetError', res?.error || 'Erreur');
        $('resetSuccess').textContent = res.devOtp ? `OTP dev: ${res.devOtp}` : 'Code OTP envoyé sur votre email';
        showToast(res.devOtp ? `OTP dev: ${res.devOtp}` : 'Code OTP envoyé');
    });
});

function showAuthError(id, msg) {
    $(id).textContent = msg;
    const siblingSuccess = id === 'registerError' ? $('registerSuccess') : id === 'resetError' ? $('resetSuccess') : null;
    if (siblingSuccess) siblingSuccess.textContent = '';
    setTimeout(() => $(id).textContent = '', 3500);
}
function togglePw(id) {
    const inp = $(id);
    inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ═══════════════════════════════════════════════════════════════
//  AUTH SUCCESS → Enter App
// ═══════════════════════════════════════════════════════════════
function onAuthSuccess(res) {
    currentUser   = res.user;
    conversations = res.messages || [];
    groups        = res.groups || [];
    allUsers      = res.users || [];
    statuses      = res.statuses || [];
    updateChannelInfo = res.updateChannel || null;
    authSessionToken = res.sessionToken || null;
    callHistory = normalizeCallHistory(res.user?.callHistory);
    if (authSessionToken && currentUser?.pseudo) {
        persistSessionAuth({ pseudo: currentUser.pseudo, token: authSessionToken });
    }
    seedKnownPrivateChats();

    updateSidebarUser();
    setupSocketListeners();
    setupReconnectHandler();
    $('authScreen')?.classList.remove('restoring');
    playAuthLaunch().then(() => {
        $('authScreen').style.display = 'none';
        $('mainScreen').style.display = 'flex';
        renderStatusStrip();
        renderUpdateChannelPrompt();
        renderConversations();
        renderCallsHistory();
        // Init new UI
        initMobileUI();
        initSettingsPage();
        initActusPage();
        if (currentUser.needsPhoneSetup) {
            showToast('Ajoutez votre numero principal dans le profil pour activer les statuts prives');
        }
        flushPendingRegistrationAvatar();
        pendingInviteContext = pendingInviteContext || readPendingInviteFromUrl();
        if (pendingInviteContext) {
            setTimeout(() => consumeGroupInvite(
                pendingInviteContext.groupId,
                pendingInviteContext.inviteToken,
                'Invitation détectée'
            ), 250);
        }
    });
}

function updateSidebarUser() {
    if ($('sidebarUserAvatar')) $('sidebarUserAvatar').src = currentUser.avatar;
    if ($('drawerAvatar'))      $('drawerAvatar').src      = currentUser.avatar;
    if ($('drawerPseudo'))      $('drawerPseudo').textContent = currentUser.pseudo;
    if ($('drawerStatus'))      $('drawerStatus').textContent = currentUser.online ? 'En ligne' : lastSeenText(currentUser.lastSeen);
    // Mobile: update actus avatar
    if ($('actusMyAvatar'))     $('actusMyAvatar').src = currentUser.avatar;
    // Admin-only elements
    const isAdmin = currentUser.isAdmin;
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = isAdmin ? '' : 'none';
    });
}

function readStoredSession() {
    try {
        const raw = sessionStorage.getItem('devchat_auth');
        const fallback = localStorage.getItem('devchat_auth');
        const parsed = JSON.parse(raw || fallback || 'null');
        if (!parsed?.pseudo || !parsed?.token) return null;
        return parsed;
    } catch (err) {
        clearSessionAuth();
        return null;
    }
}

function restoreSessionWithToken(onSuccess) {
    const stored = readStoredSession();
    if (!stored) return false;
    $('authScreen')?.classList.add('restoring');
    socket.emit('auth', { pseudo: stored.pseudo, sessionToken: stored.token, isRegister: false }, (res) => {
        $('authScreen')?.classList.remove('restoring');
        if (!res?.success) {
            clearSessionAuth();
            if (currentUser) showToast('Session expirée — veuillez vous reconnecter');
            return;
        }
        if (typeof onSuccess === 'function') onSuccess(res);
        else onAuthSuccess(res);
    });
    return true;
}

function formatPhoneNumber(value) {
    if (!value) return 'Non renseigné';
    return value;
}

function renderUpdateChannelPrompt() {
    const show = updateChannelInfo && !updateChannelInfo.joined;
    ['updateChannelPrompt','updateChannelPromptMobile'].forEach(id => {
        const el = $(id);
        if (el) el.style.display = show ? 'flex' : 'none';
    });
}

function joinUpdateChannel() {
    socket.emit('join-update-channel', (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        if (res.group) upsertGroup(res.group);
        updateChannelInfo = res.updateChannel || updateChannelInfo;
        renderUpdateChannelPrompt();
        renderConversations();
        showToast('Canal de mises à jour rejoint ✓');
    });
}
$('joinUpdateChannelBtn').addEventListener('click', joinUpdateChannel);
const mobileJoinBtn = $('joinUpdateChannelBtnMobile');
if (mobileJoinBtn) mobileJoinBtn.addEventListener('click', joinUpdateChannel);

function playAuthLaunch() {
    return new Promise(resolve => {
        const launch = $('authLaunch');
        if (!launch) { resolve(); return; }
        // Show splash with .active class
        launch.classList.add('active');
        // After animation completes, fade out and resolve
        setTimeout(() => {
            launch.style.transition = 'opacity 0.3s ease';
            launch.style.opacity = '0';
            setTimeout(() => {
                launch.style.display = 'none';
                launch.style.opacity = '';
                launch.classList.remove('active');
                resolve();
            }, 320);
        }, 1300);
    });
}

function upsertConversationMessage(message) {
    const idx = conversations.findIndex(m => m.id === message.id);
    if (idx === -1) conversations.push(message);
    else conversations[idx] = { ...conversations[idx], ...message };
}

function registerPrivateChat(pseudo, avatar = null) {
    if (!pseudo || pseudo === currentUser?.pseudo) return;
    const idx = knownPrivateChats.findIndex(chat => chat.pseudo === pseudo);
    const next = {
        pseudo,
        avatar: avatar || allUsers.find(user => user.pseudo === pseudo)?.avatar || dicebear(pseudo)
    };
    if (idx === -1) knownPrivateChats.push(next);
    else knownPrivateChats[idx] = { ...knownPrivateChats[idx], ...next };
}

function seedKnownPrivateChats() {
    knownPrivateChats = [];
    conversations.forEach(message => {
        if (message.type !== 'private') return;
        registerPrivateChat(
            message.from === currentUser?.pseudo ? message.to : message.from
        );
    });
}

function upsertGroup(group) {
    const idx = groups.findIndex(g => g.id === group.id);
    if (idx === -1) groups.push(group);
    else groups[idx] = { ...groups[idx], ...group };
}

function markMessagesAsReadLocally(messageIds, reader = currentUser?.pseudo) {
    if (!reader || !Array.isArray(messageIds) || !messageIds.length) return;
    messageIds.forEach(id => {
        const msg = conversations.find(m => m.id === id);
        if (!msg) return;
        if (!Array.isArray(msg.readBy)) msg.readBy = [];
        if (!msg.readBy.includes(reader)) msg.readBy.push(reader);
    });
}

function conversationKey(chatType, chatId) {
    return `${chatType}:${chatId}`;
}

function isMessageExpired(message) {
    return !!message?.expiresAt && new Date(message.expiresAt).getTime() <= Date.now();
}

function isMessageHiddenForCurrentUser(message) {
    if (!currentUser) return false;
    const key = message.type === 'private'
        ? conversationKey('private', message.from === currentUser.pseudo ? message.to : message.from)
        : conversationKey('group', message.groupId);
    const cutoff = currentUser.hiddenChats?.[key];
    return !!cutoff && new Date(message.date).getTime() <= new Date(cutoff).getTime();
}

function getVisibleConversations() {
    return conversations.filter(message => !isMessageExpired(message) && !isMessageHiddenForCurrentUser(message));
}

function syncCurrentUser(nextUser) {
    if (!nextUser) return;
    currentUser = { ...currentUser, ...nextUser };
    if (Array.isArray(nextUser.callHistory)) {
        callHistory = normalizeCallHistory(nextUser.callHistory);
        renderCallsHistory();
    }
    updateSidebarUser();
    renderContactsList();
    renderStatusStrip();
    refreshActusPage();
}

function getEphemeralDurationForChat(pseudo) {
    return Number(currentUser?.ephemeralSettings?.[pseudo] || 0);
}

function ephemeralLabel(durationMs) {
    return EPHEMERAL_CHOICES.find(choice => choice.value === durationMs)?.label || 'Personnalisé';
}

function nextEphemeralValue(currentValue) {
    const index = EPHEMERAL_CHOICES.findIndex(choice => choice.value === currentValue);
    return EPHEMERAL_CHOICES[(index + 1) % EPHEMERAL_CHOICES.length].value;
}

function upsertStatus(status) {
    const idx = statuses.findIndex(item => item.id === status.id);
    if (idx === -1) statuses.push(status);
    else statuses[idx] = { ...statuses[idx], ...status };
}

function isStatusExpired(status) {
    return !!status?.expiresAt && new Date(status.expiresAt).getTime() <= Date.now();
}

function groupedStatuses() {
    const active = statuses.filter(status => !isStatusExpired(status));
    const map = new Map();
    active.forEach(status => {
        if (!map.has(status.userPseudo)) map.set(status.userPseudo, []);
        map.get(status.userPseudo).push(status);
    });
    return [...map.entries()].map(([userPseudo, items]) => ({
        userPseudo,
        items: items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    }));
}

function renderStatusStrip() {
    const strip = $('statusStrip');
    strip.innerHTML = '';

    const ownGroup = groupedStatuses().find(group => group.userPseudo === currentUser.pseudo);
    const ownItem = document.createElement('div');
    ownItem.className = 'status-strip-item';
    ownItem.innerHTML = `
        <div class="status-ring-strip ${ownGroup ? 'has-status' : ''}">
            <img src="${currentUser.avatar}" alt="">
        </div>
        <span>${ownGroup ? 'Mon statut' : 'Ajouter'}</span>
    `;
    ownItem.addEventListener('click', openStatusComposerModal);
    strip.appendChild(ownItem);

    groupedStatuses()
        .filter(group => group.userPseudo !== currentUser.pseudo)
        .forEach(group => {
            const user = allUsers.find(item => item.pseudo === group.userPseudo);
            const contact = getRegisteredContacts().find(entry => entry.pseudo === group.userPseudo);
            const allViewed = group.items.every(item => item.viewed);
            const div = document.createElement('div');
            div.className = 'status-strip-item';
            div.innerHTML = `
                <div class="status-ring-strip ${allViewed ? '' : 'has-status'}">
                    <img src="${user?.avatar || contact?.avatar || dicebear(group.userPseudo)}" alt="">
                </div>
                <span>${escHtml(contact?.contactName || group.userPseudo)}</span>
            `;
            div.addEventListener('click', () => openStatusViewer(group.userPseudo));
            strip.appendChild(div);
        });
}

function updateProfileStatsUI(stats) {
    if (!stats || stats.error) return;
    $('statUsers').textContent = stats.users ?? '-';
    $('statOnlineUsers').textContent = stats.onlineUsers ?? '-';
    $('statGroups').textContent = stats.groups ?? '-';
    $('statMessages').textContent = stats.messages ?? '-';
    $('statStatuses').textContent = stats.activeStatuses ?? '-';
}

function requestAppStats() {
    if (!currentUser?.isAdmin) return;
    socket.emit('get-app-stats', stats => {
        if (stats?.error) return;
        appStats = stats;
        updateProfileStatsUI(stats);
    });
}

async function notifyIncomingMessage(msg) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    if (!currentUser || msg.from === currentUser.pseudo) return;

    const title = msg.type === 'group' ? `Nouveau message dans ${groups.find(g => g.id === msg.groupId)?.name || 'groupe'}` : msg.from;
    const body = msg.fileUrl ? (msg.content || 'Fichier reçu') : (msg.content || 'Nouveau message');
    const data = {
        url: '/',
        chatType: msg.type,
        chatId: msg.type === 'group' ? msg.groupId : msg.from
    };

    try {
        const registration = await navigator.serviceWorker?.getRegistration();
        if (registration) {
            await registration.showNotification(title, {
                body,
                icon: '/icons/icon-192.png',
                badge: '/icons/icon-96.png',
                tag: `chat-${data.chatType}-${data.chatId}`,
                data
            });
            return;
        }
    } catch (err) {}

    const notification = new Notification(title, {
        body,
        icon: '/icons/icon-192.png',
        tag: `chat-${data.chatType}-${data.chatId}`
    });
    notification.onclick = () => {
        window.focus();
    };
}

// ═══════════════════════════════════════════════════════════════
//  CONVERSATIONS
// ═══════════════════════════════════════════════════════════════
function renderConversations(filter = '') {
    const list = $('conversationsList');
    list.innerHTML = '';

    // Build chat list from messages + groups
    const chatMap = new Map();

    getVisibleConversations().forEach(msg => {
        if (msg.type === 'private') {
            const other = msg.from === currentUser.pseudo ? msg.to : msg.from;
            if (!chatMap.has('p_' + other)) {
                chatMap.set('p_' + other, { type: 'private', id: other, lastMsg: msg, unread: 0 });
            } else {
                const entry = chatMap.get('p_' + other);
                if (new Date(msg.date) > new Date(entry.lastMsg.date)) entry.lastMsg = msg;
            }
            if (msg.to === currentUser.pseudo && !msg.readBy?.includes(currentUser.pseudo)) {
                const entry = chatMap.get('p_' + other);
                entry.unread = (entry.unread || 0) + 1;
            }
        } else if (msg.type === 'group') {
            const key = 'g_' + msg.groupId;
            if (!chatMap.has(key)) {
                chatMap.set(key, { type: 'group', id: msg.groupId, lastMsg: msg, unread: 0 });
            } else {
                const entry = chatMap.get(key);
                if (new Date(msg.date) > new Date(entry.lastMsg.date)) entry.lastMsg = msg;
            }
            if (msg.from !== currentUser.pseudo && !msg.readBy?.includes(currentUser.pseudo)) {
                const entry = chatMap.get(key);
                entry.unread = (entry.unread || 0) + 1;
            }
        }
    });

    groups.forEach(g => {
        const key = 'g_' + g.id;
        if (!chatMap.has(key)) {
            chatMap.set(key, { type: 'group', id: g.id, lastMsg: null, unread: 0 });
        }
    });

    knownPrivateChats.forEach(chat => {
        const key = 'p_' + chat.pseudo;
        if (currentUser?.hiddenChats?.[conversationKey('private', chat.pseudo)]) return;
        if (!chatMap.has(key)) {
            chatMap.set(key, { type: 'private', id: chat.pseudo, lastMsg: null, unread: 0 });
        }
    });

    // Sort by last message date
    const sorted = [...chatMap.values()].sort((a, b) => {
        const da = a.lastMsg ? new Date(a.lastMsg.date) : 0;
        const db = b.lastMsg ? new Date(b.lastMsg.date) : 0;
        return db - da;
    });

    let displayed = 0;
    const renderedEntries = [];
    sorted.forEach(entry => {
        const contact = entry.type === 'private' ? getRegisteredContacts().find(item => item.pseudo === entry.id) : null;
        const name = entry.type === 'group'
            ? (groups.find(g => g.id === entry.id)?.name || entry.id)
            : (contact?.contactName || entry.id);

        if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;

        const user  = allUsers.find(u => u.pseudo === entry.id);
        const group = groups.find(g => g.id === entry.id);
        const avatar = entry.type === 'group'
            ? (group?.avatar || dicebear(name))
            : (user?.avatar || dicebear(name));

        const isOnline = entry.type === 'private' && user?.online;
        const lastTxt  = entry.lastMsg
            ? (entry.lastMsg.deleted ? '🗑 Message supprimé' :
               entry.lastMsg.isEphemeral ? '⏳ Message éphémère' :
               entry.lastMsg.fileUrl ? '📎 Fichier' :
               entry.lastMsg.content?.slice(0, 40) || '')
            : (entry.type === 'group' ? '👥 Groupe' : '');
        const lastTime = entry.lastMsg ? formatTime(entry.lastMsg.date) : '';
        const isOwn    = entry.lastMsg?.from === currentUser.pseudo;
        const unread   = entry.unread || 0;
        const isActive = currentChat?.type === entry.type && currentChat?.id === entry.id;

        const div = document.createElement('div');
        div.className = `conv-item${isActive ? ' active' : ''}`;
        div.innerHTML = `
            <div class="conv-avatar-wrap">
                <img src="${avatar}" class="conv-avatar" alt="">
                <span class="conv-online-dot ${isOnline ? 'show' : ''}"></span>
            </div>
            <div class="conv-info">
                <div class="conv-name-row">
                    <span class="conv-name">${escHtml(name)}</span>
                    <span class="conv-time">${lastTime}</span>
                </div>
                <div class="conv-msg-row">
                    <span class="conv-last-msg">${isOwn && !unread ? '<i class="fas fa-check-double conv-sent-check"></i> ' : ''}${escHtml(lastTxt)}</span>
                    ${unread > 0 ? `<span class="conv-badge">${unread}</span>` : ''}
                </div>
            </div>
        `;
        div.addEventListener('click', () => {
            openChat({ type: entry.type, id: entry.id, name, avatar });
        });
        list.appendChild(div);
        renderedEntries.push(entry);
        displayed++;
    });

    if (displayed === 0) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-comments"></i><p>Aucune conversation</p><small>Recherchez un utilisateur pour commencer</small></div>`;
    }

    // Mirror to mobile list
    const mobileList = $('conversationsListMobile');
    if (mobileList) mobileList.innerHTML = list.innerHTML;

    // Update tab badge
    const totalUnread = [...chatMap.values()].reduce((s, e) => s + (e.unread || 0), 0);
    const badge = $('tabBadgeDiscussions');
    if (badge) {
        badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
        badge.style.display = totalUnread > 0 ? 'block' : 'none';
    }

    // Add click handlers to mobile items too
    if (mobileList) {
        mobileList.querySelectorAll('.conv-item').forEach((el, i) => {
            const entry2 = renderedEntries[i];
            if (!entry2) return;
            const contact2 = entry2.type === 'private' ? getRegisteredContacts().find(item => item.pseudo === entry2.id) : null;
            const name2 = entry2.type === 'group'
                ? (groups.find(g => g.id === entry2.id)?.name || entry2.id)
                : (contact2?.contactName || entry2.id);
            const user2  = allUsers.find(u => u.pseudo === entry2.id);
            const group2 = groups.find(g => g.id === entry2.id);
            const avatar2 = entry2.type === 'group' ? (group2?.avatar || dicebear(name2)) : (user2?.avatar || dicebear(name2));
            el.addEventListener('click', () => openChat({ type: entry2.type, id: entry2.id, name: name2, avatar: avatar2 }));
        });
    }
}

// ═══════════════════════════════════════════════════════════════
//  OPEN CHAT
// ═══════════════════════════════════════════════════════════════
function openChat(chat) {
    if (chat.type === 'private') registerPrivateChat(chat.id, chat.avatar);
    currentChat = chat;
    // Mobile: open chat overlay
    if (window.innerWidth <= 768) {
        $('chatArea').classList.add('open');
    }
    cancelReply();

    // Mobile: hide sidebar
    if (window.innerWidth <= 768) {
        $('sidebar').classList.add('hidden');
    }

    // Show header + input
    $('chatWelcome').style.display  = 'none';
    $('chatHeader').style.display   = 'flex';
    $('messageInputArea').style.display = 'flex';

    $('currentChatName').textContent = chat.name;
    $('chatAvatar').src = chat.avatar;

    // Status / dot
    const user = allUsers.find(u => u.pseudo === chat.id);
    if (chat.type === 'private') {
        $('currentChatStatus').textContent = user?.presenceHidden ? 'Présence masquée' : (user?.online ? 'En ligne' : lastSeenText(user?.lastSeen));
        $('chatOnlineDot').classList.toggle('show', !!user?.online);
        $('ctxSecretChat').style.display = 'flex';
        $('ctxViewProfile').style.display = 'flex';
        $('ctxDeleteChat').style.display = 'flex';
        $('ctxEphemeralMode').style.display = 'flex';
        $('ctxBlockUser').style.display = 'flex';
        $('ctxAddMember').style.display = 'none';
        $('ctxManageGroup').style.display = 'none';
        $('ctxLeaveGroup').style.display = 'none';
        $('ctxBlockUser').innerHTML = currentUser.blockedUsers?.includes(chat.id)
            ? '<i class="fas fa-user-check"></i> Débloquer'
            : '<i class="fas fa-ban"></i> Bloquer';
        const duration = getEphemeralDurationForChat(chat.id);
        $('ctxEphemeralMode').innerHTML = `<i class="fas fa-hourglass-half"></i> Éphémère: ${ephemeralLabel(duration)}`;
    } else {
        const group = groups.find(g => g.id === chat.id);
        $('currentChatStatus').textContent = `${group?.members.length || 0} membres`;
        $('chatOnlineDot').classList.remove('show');
        $('ctxSecretChat').style.display = 'none';
        $('ctxViewProfile').style.display = 'none';
        $('ctxDeleteChat').style.display = 'flex';
        $('ctxEphemeralMode').style.display = 'none';
        $('ctxBlockUser').style.display = 'none';
        $('ctxAddMember').style.display = 'flex';
        $('ctxLeaveGroup').style.display = 'flex';
        const isAdmin = group?.admins.includes(currentUser.pseudo);
        $('ctxManageGroup').style.display = isAdmin ? 'flex' : 'none';
    }

    refreshChatComposerState();

    renderMessages();
    renderConversations();

    // Mark messages read
    const unread = getVisibleConversations()
        .filter(m => {
            if (chat.type === 'private') {
                return m.type === 'private' &&
                    m.to === currentUser.pseudo &&
                    m.from === chat.id &&
                    !m.readBy?.includes(currentUser.pseudo);
            }
            return m.type === 'group' &&
                m.groupId === chat.id &&
                m.from !== currentUser.pseudo &&
                !m.readBy?.includes(currentUser.pseudo);
        })
        .map(m => m.id);
    if (unread.length) {
        markMessagesAsReadLocally(unread);
        const receiptEligible = unread.filter(id => shouldEmitReadReceipt(conversations.find(message => message.id === id)));
        if (receiptEligible.length) socket.emit('mark-read', { messageIds: receiptEligible });
        renderConversations();
    }

    if (!isReadonlyOfficialChannel(chat)) $('messageInput').focus();
}

// ═══════════════════════════════════════════════════════════════
//  RENDER MESSAGES
// ═══════════════════════════════════════════════════════════════
function renderMessages() {
    const container = $('messagesContainer');
    container.innerHTML = '';

    if (!currentChat) {
        clearMessageSelection();
        return;
    }

    const msgs = getVisibleConversations().filter(m => {
        if (currentChat.type === 'private') {
            return m.type === 'private' &&
                ((m.from === currentChat.id && m.to === currentUser.pseudo) ||
                 (m.from === currentUser.pseudo && m.to === currentChat.id));
        } else {
            return m.type === 'group' && m.groupId === currentChat.id;
        }
    }).sort((a, b) => new Date(a.date) - new Date(b.date));

    if (msgs.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-lock-open"></i><p>Aucun message</p><small>Soyez le premier à écrire !</small></div>`;
        return;
    }

    let lastDate = null;
    msgs.forEach(msg => {
        // Date divider
        const msgDate = new Date(msg.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
        if (msgDate !== lastDate) {
            lastDate = msgDate;
            const div = document.createElement('div');
            div.className = 'date-divider';
            div.innerHTML = `<span>${msgDate}</span>`;
            container.appendChild(div);
        }
        container.appendChild(buildMessageEl(msg));
    });

    container.scrollTop = container.scrollHeight;
}

function buildMessageEl(msg) {
    const isOwn = msg.from === currentUser.pseudo;

    if (msg.type === 'system' || msg.system) {
        const div = document.createElement('div');
        div.className = 'msg-system';
        div.textContent = msg.content;
        return div;
    }

    const wrap = document.createElement('div');
    wrap.className = `msg-wrap ${isOwn ? 'own' : 'other'}`;
    wrap.dataset.msgId = msg.id;
    if (selectedMessageIds.has(msg.id)) wrap.classList.add('selected');

    // Sender name (groups only, not own)
    if (currentChat?.type === 'group' && !isOwn) {
        const senderEl = document.createElement('div');
        senderEl.className = 'msg-sender';
        senderEl.textContent = msg.from;
        wrap.appendChild(senderEl);
    }

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble${msg.deleted ? ' deleted' : ''}${msg.isSecret ? ' secret' : ''}`;

    // Reply reference
    if (msg.replyTo) {
        const refMsg = conversations.find(m => m.id === msg.replyTo);
        if (refMsg) {
            const replyDiv = document.createElement('div');
            replyDiv.className = 'msg-reply';
            replyDiv.innerHTML = `<div class="reply-from">${escHtml(refMsg.from)}</div>${escHtml(refMsg.content?.slice(0,60) || '📎')}`;
            replyDiv.addEventListener('click', () => scrollToMessage(msg.replyTo));
            bubble.appendChild(replyDiv);
        }
    }

    // Content
    if (msg.deleted) {
        bubble.appendChild(document.createTextNode('Message supprimé'));
    } else if (msg.fileUrl) {
        const isImg = /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(msg.fileUrl) || (msg.fileType && msg.fileType.startsWith('image/'));
        const isAudio = msg.fileType && msg.fileType.startsWith('audio/');
        const isVideo = msg.fileType && msg.fileType.startsWith('video/');
        if (isImg) {
            const img = document.createElement('img');
            img.className = 'msg-img'; img.src = msg.fileUrl; img.alt = 'Image';
            img.addEventListener('click', () => openImageViewer(msg.fileUrl));
            bubble.appendChild(img);
            if (msg.fileSize) {
                const size = document.createElement('div');
                size.className = 'msg-media-meta';
                size.textContent = formatFileSize(msg.fileSize);
                bubble.appendChild(size);
            }
            if (msg.content) bubble.appendChild(document.createTextNode(msg.content));
        } else if (isVideo) {
            const video = document.createElement('video');
            video.className = 'msg-video';
            video.src = msg.fileUrl;
            video.controls = true;
            video.playsInline = true;
            if (msg.pendingStatus === 'uploading') video.muted = true;
            bubble.appendChild(video);
            const size = document.createElement('div');
            size.className = 'msg-media-meta';
            size.textContent = msg.fileSize ? formatFileSize(msg.fileSize) : (msg.fileName || 'Vidéo');
            bubble.appendChild(size);
            if (msg.content) bubble.appendChild(document.createTextNode(msg.content));
        } else if (isAudio) {
            const audio = document.createElement('audio');
            audio.className = 'msg-audio';
            audio.controls = true;
            audio.src = msg.fileUrl;
            bubble.appendChild(audio);
            const size = document.createElement('div');
            size.className = 'msg-media-meta';
            size.textContent = msg.fileSize ? formatFileSize(msg.fileSize) : (msg.fileName || 'Audio');
            bubble.appendChild(size);
            if (msg.content) bubble.appendChild(document.createTextNode(msg.content));
        } else {
            const fileDiv = document.createElement('div');
            fileDiv.className = 'msg-file';
            const icon = document.createElement('i');
            icon.className = 'fas fa-file';
            const link = document.createElement('a');
            link.href = msg.fileUrl;
            link.download = msg.fileName || 'fichier';
            link.textContent = msg.fileName || 'Fichier';
            fileDiv.appendChild(icon);
            fileDiv.appendChild(link);
            if (msg.fileSize) {
                const size = document.createElement('span');
                size.className = 'msg-file-size';
                size.textContent = formatFileSize(msg.fileSize);
                fileDiv.appendChild(size);
            }
            bubble.appendChild(fileDiv);
        }
    } else {
        bubble.appendChild(document.createTextNode(msg.content));
    }

    wrap.appendChild(bubble);

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    if (msg.isSecret) meta.innerHTML += `<i class="fas fa-lock msg-secret-icon"></i>`;
    if (msg.isEphemeral) meta.innerHTML += `<i class="fas fa-hourglass-half msg-secret-icon"></i>`;
    if (msg.editedAt && !msg.deleted) meta.innerHTML += `<span class="msg-time">modifié</span>`;
    meta.innerHTML += `<span class="msg-time">${formatTime(msg.date)}</span>`;
    if (msg.pendingStatus === 'uploading') {
        meta.innerHTML += `<span class="msg-status pending">Envoi...</span>`;
    } else if (msg.pendingStatus === 'failed') {
        meta.innerHTML += `<span class="msg-status failed">${escHtml(msg.pendingError || 'Échec')}</span>`;
    } else if (isOwn && !msg.deleted) {
        const isRead = msg.readBy && msg.readBy.some(r => r !== currentUser.pseudo);
        meta.innerHTML += `<i class="fas fa-check-double msg-status ${isRead ? 'read' : ''}"></i>`;
    }
    wrap.appendChild(meta);

    // Reactions
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
        const reactRow = document.createElement('div');
        reactRow.className = 'msg-reactions';
        Object.entries(msg.reactions).forEach(([emoji, users]) => {
            if (!users.length) return;
            const badge = document.createElement('div');
            const mine = users.includes(currentUser.pseudo);
            badge.className = `reaction-badge ${mine ? 'mine' : ''}`;
            badge.innerHTML = `${emoji}<span>${users.length}</span>`;
            badge.addEventListener('click', () => socket.emit('react-message', { messageId: msg.id, emoji }));
            reactRow.appendChild(badge);
        });
        wrap.appendChild(reactRow);
    }

    // Right-click context menu
    bubble.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showMsgContextMenu(e, msg, isOwn);
    });
    bubble.addEventListener('click', () => {
        if (!selectedMessageIds.size) return;
        if (!isOwn || msg.deleted) return;
        toggleMessageSelection(msg.id);
    });
    // Long press (mobile)
    let pressTimer;
    bubble.addEventListener('touchstart', () => { pressTimer = setTimeout(() => showMsgContextMenu({ clientX: window.innerWidth/2, clientY: window.innerHeight/2 }, msg, isOwn), 500); });
    bubble.addEventListener('touchend', () => clearTimeout(pressTimer));

    return wrap;
}

function scrollToMessage(id) {
    const el = document.querySelector(`[data-msg-id="${id}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.style.outline = '2px solid var(--primary)'; setTimeout(() => el.style.outline = '', 1200); }
}

// ═══════════════════════════════════════════════════════════════
//  MESSAGE CONTEXT MENU
// ═══════════════════════════════════════════════════════════════
let activeMsgMenu = null;
function showMsgContextMenu(e, msg, isOwn) {
    closeMsgContextMenu();
    const menu = document.createElement('div');
    menu.className = 'msg-context-menu';

    // Quick reactions
    const emojiRow = document.createElement('div');
    emojiRow.className = 'mcx-emoji-row';
    ['👍','❤️','😂','😮','😢','🔥'].forEach(emoji => {
        const span = document.createElement('span');
        span.className = 'mcx-emoji'; span.textContent = emoji;
        span.addEventListener('click', () => {
            socket.emit('react-message', { messageId: msg.id, emoji });
            closeMsgContextMenu();
        });
        emojiRow.appendChild(span);
    });
    menu.appendChild(emojiRow);

    const items = [
        { icon: 'fa-reply', label: 'Répondre', action: () => setReply(msg) },
        ...(isOwn && !msg.deleted ? [{ icon: 'fa-check-square', label: 'Sélectionner', action: () => {
            toggleMessageSelection(msg.id);
        }}] : []),
        ...(isOwn && !msg.deleted && !msg.fileUrl ? [{ icon: 'fa-pen', label: 'Modifier', action: () => {
            promptEditMessage(msg);
        }}] : []),
        ...(isOwn && !msg.deleted ? [{ icon: 'fa-trash', label: 'Supprimer', danger: true, action: () => {
            socket.emit('delete-message', { messageId: msg.id }, (res) => {
                if (res.success) {
                    const m = conversations.find(m => m.id === msg.id);
                    if (m) { m.deleted = true; m.content = ''; }
                    renderMessages(); renderConversations();
                }
            });
        }}] : [])
    ];

    items.forEach(item => {
        const div = document.createElement('div');
        div.className = `mcx-item${item.danger ? ' danger' : ''}`;
        div.innerHTML = `<i class="fas ${item.icon}"></i> ${item.label}`;
        div.addEventListener('click', () => { item.action(); closeMsgContextMenu(); });
        menu.appendChild(div);
    });

    let x = Math.min(e.clientX, window.innerWidth - 210);
    let y = Math.min(e.clientY, window.innerHeight - 200);
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    document.body.appendChild(menu);
    activeMsgMenu = menu;

    setTimeout(() => document.addEventListener('click', closeMsgContextMenu, { once: true }), 10);
}
function closeMsgContextMenu() {
    if (activeMsgMenu) { activeMsgMenu.remove(); activeMsgMenu = null; }
}

// ── Reply ──────────────────────────────────────────────────────
function setReply(msg) {
    replyTo = msg;
    $('replyAuthor').textContent = msg.from;
    $('replyText').textContent   = msg.content?.slice(0, 60) || '📎 Fichier';
    $('replyPreview').style.display = 'flex';
    $('messageInput').focus();
}
function cancelReply() { replyTo = null; $('replyPreview').style.display = 'none'; }
window.cancelReply = cancelReply;

// ═══════════════════════════════════════════════════════════════
//  SEND MESSAGE
// ═══════════════════════════════════════════════════════════════
function sendMessage() {
    const now = Date.now();
    if (now < sendLockUntil) return;
    if (isReadonlyOfficialChannel()) {
        showToast('Seul l administrateur peut publier dans ce canal');
        return;
    }

    const content = $('messageInput').value.trim();
    if (!content && !replyTo) return;
    if (!currentChat) return;
    sendLockUntil = now + 400;

    const payload = {
        content,
        replyTo: replyTo?.id || null,
        isSecret: currentChat.isSecret || false
    };

    if (currentChat.type === 'private') {
        payload.to = currentChat.id;
        socket.emit('private-message', payload, (res) => {
            if (!res?.success) showToast(res?.error || 'Erreur d\'envoi');
        });
    } else {
        payload.groupId = currentChat.id;
        socket.emit('group-message', payload, (res) => {
            if (!res?.success) showToast(res?.error || 'Erreur d\'envoi');
        });
    }

    $('messageInput').value = '';
    autoResizeInput();
    cancelReply();
    updateComposerActionButtons();
}

$('sendBtn').addEventListener('click', sendMessage);

$('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
$('messageInput').addEventListener('input', () => {
    autoResizeInput();
    updateComposerActionButtons();
});

$('messageInput').addEventListener('input', () => {
    autoResizeInput();
    if (!currentChat) return;
    clearTimeout(typingTimers._self);
    if (currentChat.type === 'private') {
        socket.emit('typing', { to: currentChat.id, isTyping: true });
    } else {
        socket.emit('typing', { groupId: currentChat.id, isTyping: true });
    }
    typingTimers._self = setTimeout(() => {
        if (currentChat?.type === 'private') socket.emit('typing', { to: currentChat.id, isTyping: false });
        else socket.emit('typing', { groupId: currentChat.id, isTyping: false });
    }, 1200);
});

function autoResizeInput() {
    const el = $('messageInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── File Attach ────────────────────────────────────────────────
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentChat) return;
    if (isReadonlyOfficialChannel()) {
        e.target.value = '';
        showToast('Seul l administrateur peut publier dans ce canal');
        return;
    }
    try {
        await sendChatFileWithOptimisticPreview(file);
        showToast('Fichier envoyé ✓');
    } catch (err) {
        showToast(err.message);
    } finally {
        $('fileInput').value = '';
    }
});

// ── Emoji ──────────────────────────────────────────────────────
let emojiPickerEl = null;
$('emojiBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const container = $('emojiPickerContainer');
    if (container.style.display === 'none' || !container.style.display) {
        container.style.display = 'block';
        if (!emojiPickerEl && window.EmojiMart) {
            emojiPickerEl = new window.EmojiMart.Picker({
                theme: 'dark',
                dynamicWidth: window.innerWidth <= 768,
                onEmojiSelect: (emoji) => {
                    $('messageInput').value += emoji.native;
                    container.style.display = 'none';
                    $('messageInput').focus();
                    updateComposerActionButtons();
                }
            });
            container.appendChild(emojiPickerEl);
        }
        const rect = $('emojiBtn').getBoundingClientRect();
        const pickerWidth = Math.min(window.innerWidth - 16, 352);
        const desiredLeft = window.innerWidth <= 768 ? (window.innerWidth - pickerWidth) / 2 : rect.left - 8;
        const maxLeft = Math.max(8, window.innerWidth - pickerWidth - 8);
        container.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        container.style.left = `${Math.max(8, Math.min(desiredLeft, maxLeft))}px`;
    } else {
        container.style.display = 'none';
    }
});
document.addEventListener('click', (e) => {
    if (!$('emojiPickerContainer').contains(e.target) && e.target !== $('emojiBtn'))
        $('emojiPickerContainer').style.display = 'none';
});

$('voiceRecordBtn').addEventListener('click', async () => {
    if (isReadonlyOfficialChannel()) {
        showToast('Seul l administrateur peut publier dans ce canal');
        return;
    }
    if (!currentChat) return;

    if (isRecording && mediaRecorder) {
        mediaRecorder.stop();
        return;
    }

    try {
        mediaRecorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const chunks = [];
        const recorderOptions = MediaRecorder.isTypeSupported?.('audio/webm') ? { mimeType: 'audio/webm' } : undefined;
        mediaRecorder = recorderOptions ? new MediaRecorder(mediaRecorderStream, recorderOptions) : new MediaRecorder(mediaRecorderStream);
        isRecording = true;
        $('voiceRecordBtn').classList.add('recording');
        $('voiceRecordBtn').innerHTML = '<i class="fas fa-stop"></i>';
        $('messageInput').placeholder = 'Enregistrement vocal...';
        updateComposerActionButtons();

        mediaRecorder.addEventListener('dataavailable', (event) => {
            if (event.data?.size) chunks.push(event.data);
        });

        mediaRecorder.addEventListener('stop', async () => {
            isRecording = false;
            $('voiceRecordBtn').classList.remove('recording');
            $('voiceRecordBtn').innerHTML = '<i class="fas fa-microphone"></i>';
            $('messageInput').placeholder = isReadonlyOfficialChannel() ? 'Canal officiel en lecture seule' : 'Message...';
            stopVoiceStream();
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
            mediaRecorder = null;
            updateComposerActionButtons();
            if (!blob.size) return;

            try {
                const file = new File([blob], `note-vocale-${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
                await sendChatFileWithOptimisticPreview(file);
                showToast('Note vocale envoyée ✓');
            } catch (err) {
                showToast(err.message);
            }
        });

        mediaRecorder.start();
    } catch (err) {
        isRecording = false;
        mediaRecorder = null;
        stopVoiceStream();
        $('voiceRecordBtn').classList.remove('recording');
        $('voiceRecordBtn').innerHTML = '<i class="fas fa-microphone"></i>';
        $('messageInput').placeholder = isReadonlyOfficialChannel() ? 'Canal officiel en lecture seule' : 'Message...';
        updateComposerActionButtons();
        showToast('Microphone indisponible');
    }
});

// ═══════════════════════════════════════════════════════════════
//  SIDEBAR SEARCH
// ═══════════════════════════════════════════════════════════════
let searchDebounce;
$('sidebarSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    $('searchClearBtn').style.display = q ? 'block' : 'none';
    clearTimeout(searchDebounce);
    if (!q) {
        $('searchResultsPanel').style.display = 'none';
        $('conversationsList').style.display  = 'block';
        renderConversations();
        return;
    }
    searchDebounce = setTimeout(() => {
        const results = filteredRegisteredContacts(q);
        $('searchResultsPanel').style.display  = 'block';
        $('conversationsList').style.display   = 'none';
        const list = $('searchResultsList');
        list.innerHTML = '';
        if (!results.length) {
            list.innerHTML = `<div class="empty-state" style="padding:24px"><i class="fas fa-address-book"></i><p>Aucun contact enregistré trouvé</p></div>`;
            return;
        }
        results.forEach(u => {
            const div = document.createElement('div');
            div.className = 'search-result-item';
            div.innerHTML = `
                <img src="${u.avatar || dicebear(u.contactName || u.pseudo)}" class="ri-avatar" alt="">
                <div class="ri-info">
                    <div class="ri-name">${escHtml(u.contactName || u.pseudo)}</div>
                    <div class="ri-sub">${escHtml(u.phoneNumber || '')}</div>
                    <div class="ri-sub">${u.presenceHidden ? 'Présence masquée' : (u.online ? 'En ligne' : lastSeenText(u.lastSeen))}</div>
                </div>
            `;
            div.addEventListener('click', () => {
                $('sidebarSearch').value = '';
                $('searchResultsPanel').style.display = 'none';
                $('conversationsList').style.display  = 'block';
                openChat({ type: 'private', id: u.pseudo, name: u.contactName || u.pseudo, avatar: u.avatar || dicebear(u.contactName || u.pseudo) });
            });
            list.appendChild(div);
        });
    }, 300);
});
$('searchClearBtn').addEventListener('click', () => {
    $('sidebarSearch').value = '';
    $('searchClearBtn').style.display = 'none';
    $('searchResultsPanel').style.display = 'none';
    $('conversationsList').style.display  = 'block';
    renderConversations();
});

$('cancelMessageSelectionBtn').addEventListener('click', () => {
    clearMessageSelection();
    renderMessages();
});

$('deleteSelectedMessagesBtn').addEventListener('click', () => {
    const messageIds = [...selectedMessageIds];
    if (!messageIds.length) return;
    if (!confirm(`Supprimer ${messageIds.length} message(s) ?`)) return;
    socket.emit('delete-messages', { messageIds }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        res.messageIds.forEach(id => {
            const msg = conversations.find(item => item.id === id);
            if (msg) {
                msg.deleted = true;
                msg.content = '';
                msg.fileUrl = null;
                msg.fileName = null;
                msg.fileType = null;
            }
        });
        clearMessageSelection();
        renderMessages();
        renderConversations();
        showToast('Messages supprimés');
    });
});

// ═══════════════════════════════════════════════════════════════
//  DRAWER / MENU
// ═══════════════════════════════════════════════════════════════
$('menuBtn').addEventListener('click', () => {
    toggleDrawer();
});
$('drawerOverlay').addEventListener('click', closeDrawer);
if ($('drawerCloseBtn')) $('drawerCloseBtn').addEventListener('click', closeDrawer);
function openDrawer() {
    $('drawer').classList.add('open');
    $('drawerOverlay').classList.add('show');
    $('topbarCtxMenu')?.classList.remove('open');
}
function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawerOverlay').classList.remove('show');
}
function toggleDrawer() {
    if ($('drawer').classList.contains('open')) closeDrawer();
    else openDrawer();
}

document.querySelectorAll('.drawer-nav a').forEach(link => {
    link.addEventListener('click', (event) => {
        event.preventDefault();
    });
});

function _legacyOpenDrawerSection(section) {
    closeDrawer();
    if (section === 'profile') openProfileModal();
    else if (section === 'explore') openExploreModal();
    else if (section === 'newgroup') openModal('newGroupModal');
    else if (section === 'secret') showToast('Choisissez un contact puis "Chat secret"');
}

$('logoutBtn').addEventListener('click', () => {
    const token = authSessionToken;
    authSessionToken = null;
    clearSessionAuth();
    socket.emit('logout', { sessionToken: token }, () => {
        socket.disconnect();
        location.reload();
    });
});

function renderCallsHistory() {
    const list = $('callsList');
    if (!list) return;
    if (!callHistory.length) {
        list.innerHTML = `
            <div class="actus-empty-state">
                <i class="fas fa-phone-slash"></i>
                <p>Aucun appel récent</p>
                <small>Lancez un appel audio ou vidéo depuis un chat privé.</small>
            </div>
        `;
        return;
    }

    list.innerHTML = '';
    callHistory.slice(0, 12).forEach(entry => {
        const contact = getRegisteredContacts().find(item => item.pseudo === entry.pseudo);
        const label = contact?.contactName || entry.pseudo;
        const row = document.createElement('div');
        row.className = 'call-item';
        row.innerHTML = `
            <img src="${entry.avatar || dicebear(entry.pseudo)}" class="call-item-av" alt="">
            <div class="call-item-info">
                <div class="call-item-name">${escHtml(label)}</div>
                <div class="call-item-detail">${entry.direction === 'incoming' ? 'Reçu' : 'Sortant'} · ${entry.mode === 'video' ? 'Vidéo' : 'Audio'} · ${escHtml(entry.status)}</div>
                <div class="call-item-detail">Début ${formatTime(entry.startedAt)} · Fin ${formatTime(entry.endedAt)} · ${entry.durationMinutes || 0} min</div>
                <div class="call-item-detail">${entry.joinedParticipants?.length ? `Participants: ${escHtml(entry.joinedParticipants.join(', '))}` : 'Participants: -'}</div>
            </div>
            <button class="btn-secondary call-quick-btn">${contact?.online ? 'Rappeler' : 'Ouvrir'}</button>
        `;
        row.addEventListener('click', () => openChat({ type: 'private', id: entry.pseudo, name: label, avatar: entry.avatar || dicebear(entry.pseudo) }));
        row.querySelector('.call-quick-btn')?.addEventListener('click', (event) => {
            event.stopPropagation();
            openChat({ type: 'private', id: entry.pseudo, name: label, avatar: entry.avatar || dicebear(entry.pseudo) });
            if (contact?.online) startCall(entry.mode || 'audio');
        });
        list.appendChild(row);
    });
}

function pushCallHistory(entry) {
    callHistory.unshift({
        pseudo: entry.pseudo,
        avatar: entry.avatar || '',
        mode: entry.mode === 'video' ? 'video' : 'audio',
        direction: entry.direction === 'incoming' ? 'incoming' : 'outgoing',
        status: entry.status || 'Terminé',
        date: new Date().toISOString(),
        startedAt: entry.startedAt || new Date().toISOString(),
        endedAt: entry.endedAt || new Date().toISOString(),
        durationMinutes: Number(entry.durationMinutes || 0),
        joinedParticipants: Array.isArray(entry.joinedParticipants) ? entry.joinedParticipants : []
    });
    callHistory = callHistory.slice(0, 25);
    renderCallsHistory();
    persistCallHistory();
}

function updateCallControls() {
    const call = activeCall || pendingIncomingCall;
    const status = $('callStatusText');
    if (status) status.textContent = call?.status || 'Connexion...';
    if ($('callPeerName')) $('callPeerName').textContent = call?.name || call?.pseudo || 'Appel';
    if ($('callRemoteAvatar')) $('callRemoteAvatar').src = call?.avatar || dicebear(call?.pseudo || 'DevChat');
    if ($('callAcceptBtn')) $('callAcceptBtn').style.display = pendingIncomingCall ? 'inline-flex' : 'none';
    if ($('callToggleCameraBtn')) $('callToggleCameraBtn').style.display = call?.mode === 'video' ? 'inline-flex' : 'none';
    if ($('callMuteBtn')) $('callMuteBtn').style.display = activeCall ? 'inline-flex' : 'none';
    if ($('callLocalVideo')) $('callLocalVideo').style.display = activeCall?.mode === 'video' && activeCall?.localStream ? 'block' : 'none';
    if ($('callRemoteVideo')) $('callRemoteVideo').style.display = activeCall?.remoteStream && activeCall.remoteStream.getTracks().length ? 'block' : 'none';
    if ($('callRemotePlaceholder')) $('callRemotePlaceholder').style.display = $('callRemoteVideo').style.display === 'block' ? 'none' : 'flex';
}

function openCallModal() {
    $('callModal').style.display = 'flex';
    document.body.classList.add('call-open');
    updateCallControls();
}

function closeCallModal() {
    $('callModal').style.display = 'none';
    document.body.classList.remove('call-open');
}

function attachCallStreams() {
    const localVideo = $('callLocalVideo');
    const remoteVideo = $('callRemoteVideo');
    if (localVideo) localVideo.srcObject = activeCall?.localStream || null;
    if (remoteVideo) remoteVideo.srcObject = activeCall?.remoteStream || null;
    updateCallControls();
}

async function ensureCallMedia(mode) {
    const constraints = mode === 'video' ? { audio: true, video: true } : { audio: true, video: false };
    return navigator.mediaDevices.getUserMedia(constraints);
}

function cleanupCallMedia(stream) {
    if (!stream) return;
    stream.getTracks().forEach(track => track.stop());
}

function resetActiveCallState() {
    if (activeCall?.pc) {
        activeCall.pc.onicecandidate = null;
        activeCall.pc.ontrack = null;
        activeCall.pc.close();
    }
    cleanupCallMedia(activeCall?.localStream);
    cleanupCallMedia(activeCall?.remoteStream);
    activeCall = null;
    pendingIncomingCall = null;
    const localVideo = $('callLocalVideo');
    const remoteVideo = $('callRemoteVideo');
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    closeCallModal();
}

function createPeerConnection(call) {
    if (call.pc) return call.pc;
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
    });
    call.remoteStream = new MediaStream();
    pc.ontrack = event => {
        event.streams[0].getTracks().forEach(track => call.remoteStream.addTrack(track));
        attachCallStreams();
        call.status = 'Connecté';
        if (!call.connectedAt) call.connectedAt = new Date().toISOString();
        call.joinedParticipants = [...new Set([currentUser?.pseudo, call.pseudo].filter(Boolean))];
        updateCallControls();
    };
    pc.onicecandidate = event => {
        if (!event.candidate) return;
        socket.emit('call-signal', {
            to: call.pseudo,
            data: { type: 'ice', candidate: event.candidate }
        });
    };
    call.localStream.getTracks().forEach(track => pc.addTrack(track, call.localStream));
    call.pc = pc;
    attachCallStreams();
    return pc;
}

async function startPeerOffer() {
    if (!activeCall) return;
    const pc = createPeerConnection(activeCall);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('call-signal', {
        to: activeCall.pseudo,
        data: { type: 'offer', sdp: offer }
    });
}

async function startCall(mode) {
    if (!currentChat || currentChat.type !== 'private') {
        showToast('Les appels ne sont disponibles que dans les chats privés');
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        showToast('Appels non supportés sur cet appareil');
        return;
    }
    if (activeCall || pendingIncomingCall) {
        showToast('Un appel est déjà en cours');
        return;
    }

    try {
        const localStream = await ensureCallMedia(mode);
        activeCall = {
            pseudo: currentChat.id,
            name: currentChat.name,
            avatar: currentChat.avatar,
            mode,
            direction: 'outgoing',
            status: `Appel ${mode === 'video' ? 'vidéo' : 'audio'} en cours...`,
            localStream,
            remoteStream: null,
            pc: null,
            muted: false,
            startedAt: new Date().toISOString(),
            connectedAt: null,
            joinedParticipants: [currentUser?.pseudo].filter(Boolean)
        };
        openCallModal();
        attachCallStreams();
        socket.emit('call-user', { to: currentChat.id, mode }, (res) => {
            if (!res?.success) {
                showToast(res?.error || 'Appel impossible');
                pushCallHistory({
                    pseudo: currentChat.id,
                    avatar: currentChat.avatar,
                    mode,
                    direction: 'outgoing',
                    status: 'Échec',
                    startedAt: activeCall?.startedAt || new Date().toISOString(),
                    endedAt: new Date().toISOString(),
                    durationMinutes: 0,
                    joinedParticipants: [currentUser?.pseudo].filter(Boolean)
                });
                resetActiveCallState();
            }
        });
    } catch (err) {
        showToast(mode === 'video' ? 'Caméra ou micro indisponible' : 'Microphone indisponible');
    }
}

async function acceptIncomingCall() {
    if (!pendingIncomingCall) return;
    try {
        const localStream = await ensureCallMedia(pendingIncomingCall.mode);
        activeCall = {
            ...pendingIncomingCall,
            direction: 'incoming',
            status: 'Connexion...',
            localStream,
            remoteStream: null,
            pc: null,
            muted: false,
            startedAt: pendingIncomingCall.startedAt || new Date().toISOString(),
            connectedAt: null,
            joinedParticipants: [pendingIncomingCall.pseudo, currentUser?.pseudo].filter(Boolean)
        };
        pendingIncomingCall = null;
        openCallModal();
        attachCallStreams();
        socket.emit('call-response', { to: activeCall.pseudo, accepted: true, mode: activeCall.mode });
    } catch (err) {
        showToast('Impossible d’accéder au micro/caméra');
        declineIncomingCall('Accès refusé');
    }
}

function declineIncomingCall(reason = 'Refusé') {
    if (!pendingIncomingCall) return;
    socket.emit('call-response', { to: pendingIncomingCall.pseudo, accepted: false, mode: pendingIncomingCall.mode, reason });
    pushCallHistory({
        pseudo: pendingIncomingCall.pseudo,
        avatar: pendingIncomingCall.avatar,
        mode: pendingIncomingCall.mode,
        direction: 'incoming',
        status: reason,
        startedAt: pendingIncomingCall.startedAt || new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMinutes: 0,
        joinedParticipants: [pendingIncomingCall.pseudo]
    });
    pendingIncomingCall = null;
    closeCallModal();
}

function endCurrentCall(reason = 'Terminé') {
    if (pendingIncomingCall) return declineIncomingCall(reason);
    if (!activeCall) return closeCallModal();
    socket.emit('end-call', { to: activeCall.pseudo, reason });
    const endedAt = new Date().toISOString();
    const durationMinutes = activeCall.connectedAt ? Math.max(1, Math.round((new Date(endedAt) - new Date(activeCall.connectedAt)) / 60000)) : 0;
    pushCallHistory({
        pseudo: activeCall.pseudo,
        avatar: activeCall.avatar,
        mode: activeCall.mode,
        direction: activeCall.direction,
        status: reason,
        startedAt: activeCall.startedAt || endedAt,
        endedAt,
        durationMinutes,
        joinedParticipants: activeCall.joinedParticipants || [activeCall.pseudo]
    });
    resetActiveCallState();
}

// ── Header buttons ─────────────────────────────────────────────
$('newChatBtn').addEventListener('click', () => {
    openContactsModal();
});
$('chatCallBtn').addEventListener('click', () => {
    startCall('audio');
});
$('chatVideoBtn').addEventListener('click', () => {
    startCall('video');
});
$('chatMoreBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('chatContextMenu').classList.toggle('open');
});
document.addEventListener('click', () => $('chatContextMenu').classList.remove('open'));

$('chatHeaderInfo').addEventListener('click', () => {
    if (!currentChat) return;
    openRightPanel();
});

$('ctxViewProfile').addEventListener('click', () => {
    closeContextMenu();
    openRightPanel();
});
$('ctxAddMember').addEventListener('click', () => { closeContextMenu(); openModal('newGroupModal'); });
$('ctxManageGroup').addEventListener('click', () => { closeContextMenu(); openManageGroupModal(); });
$('ctxLeaveGroup').addEventListener('click', () => {
    closeContextMenu();
    if (!confirm('Quitter ce groupe ?')) return;
    socket.emit('leave-group', { groupId: currentChat.id }, (res) => {
        if (res.success) { groups = groups.filter(g => g.id !== currentChat.id); currentChat = null; closeChatArea(); renderConversations(); }
    });
});
$('ctxDeleteChat').addEventListener('click', () => {
    closeContextMenu();
    if (!currentChat) return;
    if (!confirm('Supprimer ce chat de votre liste ?')) return;
    socket.emit('delete-chat', {
        chatType: currentChat.type,
        chatId: currentChat.id
    }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        syncCurrentUser(res.user);
        renderMessages();
        renderConversations();
        closeChatArea();
        showToast('Chat supprimé de votre liste');
    });
});
$('ctxEphemeralMode').addEventListener('click', () => {
    closeContextMenu();
    if (!currentChat || currentChat.type !== 'private') return;
    const nextValue = nextEphemeralValue(getEphemeralDurationForChat(currentChat.id));
    socket.emit('set-ephemeral-mode', { pseudo: currentChat.id, durationMs: nextValue }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        syncCurrentUser(res.user);
        $('ctxEphemeralMode').innerHTML = `<i class="fas fa-hourglass-half"></i> Éphémère: ${ephemeralLabel(res.durationMs)}`;
        showToast(`Mode éphémère: ${ephemeralLabel(res.durationMs)}`);
    });
});
$('ctxBlockUser').addEventListener('click', () => {
    closeContextMenu();
    if (!currentChat || currentChat.type !== 'private') return;
    const actionLabel = currentUser.blockedUsers?.includes(currentChat.id) ? 'débloquer' : 'bloquer';
    if (!confirm(`Voulez-vous ${actionLabel} ${currentChat.name} ?`)) return;
    socket.emit('toggle-block-user', { pseudo: currentChat.id }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        syncCurrentUser(res.user);
        renderConversations();
        showToast(res.blocked ? 'Utilisateur bloqué' : 'Utilisateur débloqué');
    });
});
$('ctxSecretChat').addEventListener('click', () => {
    closeContextMenu();
    currentChat.isSecret = true;
    $('currentChatName').textContent = '🔒 ' + currentChat.name;
    showToast('Chat secret activé — les messages ne sont pas sauvegardés');
});

function closeContextMenu() { $('chatContextMenu').classList.remove('open'); }

$('backBtn').addEventListener('click', () => {
    if (!currentChat) return;
    $('sidebar').classList.remove('hidden');
    $('chatArea').classList.remove('open');
    closeChatArea();
});
$('callAcceptBtn').addEventListener('click', acceptIncomingCall);
$('callDeclineBtn').addEventListener('click', () => endCurrentCall('Terminé'));
$('callMuteBtn').addEventListener('click', () => {
    if (!activeCall?.localStream) return;
    const audioTrack = activeCall.localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
    activeCall.muted = !audioTrack.enabled;
    $('callMuteBtn').classList.toggle('active', activeCall.muted);
});
$('callToggleCameraBtn').addEventListener('click', () => {
    if (!activeCall?.localStream) return;
    const videoTrack = activeCall.localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    videoTrack.enabled = !videoTrack.enabled;
    $('callToggleCameraBtn').classList.toggle('active', !videoTrack.enabled);
});

function closeChatArea() {
    if (isRecording && mediaRecorder) mediaRecorder.stop();
    currentChat = null;
    clearMessageSelection();
    $('chatWelcome').style.display    = 'flex';
    $('chatHeader').style.display     = 'none';
    $('messageInputArea').style.display = 'none';
    $('messagesContainer').innerHTML  = '';
    $('chatReadonlyNotice').style.display = 'none';
    renderConversations();
}

// ── New Group ──────────────────────────────────────────────────
$('newGroupSideBtn').addEventListener('click', () => openModal('newGroupModal'));

selectedMembers = [];
let memberSearchDebounce;
$('memberSearchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(memberSearchDebounce);
    if (!q) { $('memberSearchDropdown').style.display = 'none'; return; }
    memberSearchDebounce = setTimeout(() => {
        const results = filteredRegisteredContacts(q);
        const dd = $('memberSearchDropdown');
        dd.innerHTML = '';
        if (!results.length) { dd.style.display = 'none'; return; }
        dd.style.display = 'block';
        results.filter(u => !selectedMembers.find(m => m.pseudo === u.pseudo)).forEach(u => {
            const div = document.createElement('div');
            div.className = 'msd-item';
            div.innerHTML = `<img src="${u.avatar}" alt=""><span>${escHtml(u.contactName || u.pseudo)}</span>`;
            div.addEventListener('click', () => {
                selectedMembers.push(u);
                $('memberSearchInput').value = '';
                dd.style.display = 'none';
                renderSelectedMembers();
            });
            dd.appendChild(div);
        });
    }, 250);
});

function renderSelectedMembers() {
    const wrap = $('selectedMembersList');
    wrap.innerHTML = '';
    selectedMembers.forEach(u => {
        const chip = document.createElement('div');
        chip.className = 'selected-chip';
        chip.innerHTML = `<img src="${u.avatar}" alt=""><span>${escHtml(u.pseudo)}</span><button onclick="removeSelectedMember('${u.pseudo}')"><i class="fas fa-times"></i></button>`;
        wrap.appendChild(chip);
    });
}
function removeSelectedMember(pseudo) {
    selectedMembers = selectedMembers.filter(m => m.pseudo !== pseudo);
    renderSelectedMembers();
}
window.removeSelectedMember = removeSelectedMember;

$('groupAvatarPreview').addEventListener('click', () => $('groupAvatarFile').click());
$('groupAvatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const data = await uploadAvatarFile(file);
        groupAvatarUrl = data.avatarUrl;
        $('groupAvatarPreview').innerHTML = `<img src="${groupAvatarUrl}" alt="">`;
    } catch (err) {
        showToast(err.message);
    }
});

$('createGroupBtn').addEventListener('click', () => {
    const name = $('groupName').value.trim();
    if (!name) return showToast('Nom du groupe requis');
    socket.emit('create-group', {
        name,
        description: $('groupDesc').value.trim(),
        members: selectedMembers.map(m => m.pseudo),
        isPublic: $('groupPublic').checked,
        avatar: groupAvatarUrl
    }, (res) => {
        if (res.success) {
            upsertGroup(res.group);
            closeModal('newGroupModal');
            openChat({ type: 'group', id: res.group.id, name: res.group.name, avatar: res.group.avatar });
            if (res.inviteUrl) {
                if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(res.inviteUrl).then(() => {
                        showToast('Groupe créé, lien d’invitation copié');
                    }).catch(() => {
                        showToast('Groupe créé, lien disponible dans la gestion du groupe');
                    });
                } else {
                    showToast('Groupe créé, lien disponible dans la gestion du groupe');
                }
            }
            selectedMembers = [];
            $('groupName').value = '';
            $('groupDesc').value = '';
            $('groupPublic').checked = false;
            groupAvatarUrl = null;
            $('groupAvatarPreview').innerHTML = '<i class="fas fa-camera"></i>';
            $('groupAvatarFile').value = '';
            renderSelectedMembers();
        }
    });
});

// ── Explore Public Groups ──────────────────────────────────────
$('exploreBtn').addEventListener('click', openExploreModal);
function openExploreModal() {
    openModal('exploreModal');
    socket.emit('get-public-groups', (pgroups) => {
        const list = $('publicGroupsList');
        list.innerHTML = '';
        if (!pgroups.length) {
            list.innerHTML = '<div class="empty-state"><i class="fas fa-compass"></i><p>Aucun groupe public</p></div>';
            return;
        }
        pgroups.forEach(g => {
            const div = document.createElement('div');
            div.className = 'pg-item';
            const alreadyIn = groups.find(gr => gr.id === g.id);
            div.innerHTML = `
                <img src="${g.avatar}" alt="">
                <div class="pg-item-info">
                    <div class="pg-item-name">${escHtml(g.name)}</div>
                    <div class="pg-item-desc">${escHtml(g.description || 'Groupe public')}</div>
                    <div class="pg-item-count"><i class="fas fa-users"></i> ${g.memberCount} membres</div>
                </div>
                ${alreadyIn
                    ? `<button class="pg-join-btn" onclick="openGroupFromExplore('${g.id}','${escHtml(g.name)}','${g.avatar}')">Ouvrir</button>`
                    : `<button class="pg-join-btn" onclick="joinPublicGroup('${g.id}','${escHtml(g.name)}','${g.avatar}')">Rejoindre</button>`
                }
            `;
            list.appendChild(div);
        });
    });
}
function joinPublicGroup(groupId, name, avatar, inviteToken = '') {
    socket.emit('join-public-group', { groupId, inviteToken }, (res) => {
        if (res.success) {
            upsertGroup(res.group);
            closeModal('exploreModal');
            openChat({ type: 'group', id: res.group.id, name: res.group.name || name, avatar: res.group.avatar || avatar });
            renderConversations();
        } else showToast(res.error || 'Erreur');
    });
}
function openGroupFromExplore(groupId, name, avatar) {
    closeModal('exploreModal');
    openChat({ type: 'group', id: groupId, name, avatar });
}
window.joinPublicGroup = joinPublicGroup;
window.openGroupFromExplore = openGroupFromExplore;

// ── Profile ────────────────────────────────────────────────────
$('profileBtn').addEventListener('click', openProfileModal);

function renderContactsList() {
    const list = $('contactsList');
    const contacts = getRegisteredContacts();
    list.innerHTML = '';

    if (!contacts.length) {
        list.innerHTML = '<div class="empty-state" style="height:auto;padding:12px"><small>Aucun contact enregistré trouvé dans votre répertoire.</small></div>';
        return;
    }

    contacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'contact-item';
        item.innerHTML = `
            <div>
                <strong>${escHtml(contact.contactName || contact.pseudo)}</strong>
                <div class="status-meta-sub">${escHtml(contact.phoneNumber || '')}</div>
            </div>
            <button class="btn-secondary" onclick="removeContact('${contact.phoneNumber}')">Retirer</button>
        `;
        list.appendChild(item);
    });
}

function removeContact(phone) {
    socket.emit('remove-contact', { phoneNumber: phone }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        syncCurrentUser(res.user);
        renderContactsList();
        renderStatusStrip();
        showToast('Contact retiré');
    });
}
window.removeContact = removeContact;

function renderContactsDirectory(query = '') {
    const list = $('contactsDirectoryList');
    if (!list) return;
    const contacts = filteredRegisteredContacts(query);
    list.innerHTML = '';
    if (!contacts.length) {
        list.innerHTML = '<div class="empty-state" style="height:auto;padding:12px"><small>Aucun contact enregistré correspondant.</small></div>';
        return;
    }
    contacts.forEach(contact => {
        const item = document.createElement('div');
        item.className = 'contact-item';
        item.innerHTML = `
            <div>
                <strong>${escHtml(contact.contactName || contact.pseudo)}</strong>
                <div class="status-meta-sub">${escHtml(contact.phoneNumber || '')}</div>
                <div class="status-meta-sub">${contact.presenceHidden ? 'Présence masquée' : (contact.online ? 'En ligne' : lastSeenText(contact.lastSeen))}</div>
            </div>
            <button class="btn-primary">Ouvrir</button>
        `;
        item.querySelector('button').addEventListener('click', () => {
            closeModal('contactsModal');
            openChat({ type: 'private', id: contact.pseudo, name: contact.contactName || contact.pseudo, avatar: contact.avatar || dicebear(contact.contactName || contact.pseudo) });
        });
        list.appendChild(item);
    });
}

function openContactsModal() {
    $('contactsDirectorySearch').value = '';
    renderContactsDirectory();
    openModal('contactsModal');
}

function syncContacts(entries, replaceAll = false, successMessage = 'Répertoire synchronisé') {
    if (!entries.length) {
        showToast('Aucun contact valide à synchroniser');
        return;
    }
    socket.emit('sync-contacts', { contacts: entries, replaceAll }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        syncCurrentUser(res.user);
        renderContactsList();
        renderActusFriends();
        renderStatusStrip();
        renderContactsDirectory($('contactsDirectorySearch')?.value || '');
        showToast(`${successMessage} (${res.matchedCount || 0} comptes trouvés)`);
    });
}

function openProfileModal() {
    $('profileAvatar').src = currentUser.avatar;
    $('profilePseudo').textContent = currentUser.pseudo;
    $('profileHeroEmail').textContent = currentUser.email || 'Email non renseigné';
    $('profileHeroPhone').textContent = currentUser.phoneNumber || 'Numéro non renseigné';
    $('profileEmail').value = currentUser.email || '';
    $('profileEmailHint').textContent = currentUser.emailVerified ? 'Email vérifié pour récupération OTP.' : 'Ajoutez un email valide pour la récupération de compte.';
    $('profileBio').value = currentUser.bio || '';
    $('profileCountryCode').value = currentUser.phoneCountryCode || '+242';
    $('profilePhoneNumber').value = currentUser.phoneLocalNumber || '';
    $('profilePhoneHint').textContent = currentUser.phoneNumber
        ? `Numero actuel: ${formatPhoneNumber(currentUser.phoneNumber)}`
        : 'Ajoutez votre numero pour activer les statuts prives.';
    $('privacyProfilePhoto').value = currentUser.privacy?.profilePhoto || 'everyone';
    $('privacyPresence').value = currentUser.privacy?.presence || 'contacts';
    $('privacyPhone').value = currentUser.privacy?.phone || 'contacts';
    $('privacyStatus').value = currentUser.privacy?.status || 'mutual-contacts';
    $('manualContactsInput').value = '';
    $('profileAdminBadge').style.display = currentUser.isAdmin ? 'inline-flex' : 'none';
    $('profileStatsGrid').style.display = currentUser.isAdmin ? 'grid' : 'none';
    $('profileStatsNotice').style.display = currentUser.isAdmin ? 'none' : 'block';
    const notificationsEnabled = ('Notification' in window) && Notification.permission === 'granted';
    $('enableNotificationsBtn').textContent = notificationsEnabled
        ? 'Notifications activées'
        : 'Activer les notifications';
    renderContactsList();
    updateProfileStatsUI(appStats || {});
    requestAppStats();
    openModal('profileModal');
}

function openPrivacyModal() {
    if (!currentUser) return;
    $('privacyPageProfilePhoto').value = currentUser.privacy?.profilePhoto || 'everyone';
    $('privacyPagePresence').value = currentUser.privacy?.presence || 'contacts';
    $('privacyPagePhone').value = currentUser.privacy?.phone || 'contacts';
    $('privacyPageStatus').value = currentUser.privacy?.status || 'mutual-contacts';
    $('privacyReadReceipts').checked = getReadReceiptsEnabled();
    openModal('privacyModal');
}

$('desktopPrivacyBtn')?.addEventListener('click', openPrivacyModal);
$('settingsQrBtn').addEventListener('click', () => {
    const qrText = buildProfileQrPayload();
    $('profileQrImage').src = buildQrImageUrl(qrText);
    $('profileQrText').textContent = currentUser?.phoneNumber
        ? `Partagez ce QR pour être ajouté via ${formatPhoneNumber(currentUser.phoneNumber)}.`
        : 'Ce QR ouvre votre profil DevChat. Ajoutez un numéro principal pour un ajout direct au répertoire.';
    openModal('profileQrModal');
});
$('scanQrBtn').addEventListener('click', () => {
    closeModal('profileQrModal');
    openModal('qrScannerModal');
});
$('changeAvatarBtn').addEventListener('click', () => $('profileAvatarFile').click());
$('profileAvatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const previousAvatar = currentUser?.avatar;
    try {
        const data = await uploadAvatarFile(file);
        $('profileAvatar').src = data.avatarUrl;
        currentUser.avatar = data.avatarUrl;
        socket.emit('update-profile', { avatar: data.avatarUrl }, (res) => {
            if (!res?.success) {
                currentUser.avatar = previousAvatar;
                $('profileAvatar').src = previousAvatar || '';
                showToast(res?.error || 'Erreur');
                return;
            }
            syncCurrentUser(res.user);
            showToast('Photo de profil mise à jour');
        });
    } catch (err) {
        currentUser.avatar = previousAvatar;
        showToast(err.message);
    } finally {
        e.target.value = '';
    }
});
$('saveProfileBtn').addEventListener('click', () => {
    const email = $('profileEmail').value.trim();
    if (!isValidEmail(email)) return showToast('Email invalide');
    socket.emit('update-profile', {
        avatar: currentUser.avatar,
        bio: $('profileBio').value,
        email,
        countryCode: $('profileCountryCode').value,
        phoneNumber: $('profilePhoneNumber').value.trim(),
        privacy: {
            profilePhoto: $('privacyProfilePhoto').value,
            presence: $('privacyPresence').value,
            phone: $('privacyPhone').value,
            status: $('privacyStatus').value
        }
    }, (res) => {
        if (res.success) {
            syncCurrentUser(res.user);
            closeModal('profileModal');
            showToast('Profil mis à jour ✓');
        } else showToast(res?.error || 'Erreur');
    });
});
$('openContactsDirectoryBtn').addEventListener('click', openContactsModal);
$('contactsDirectorySearch').addEventListener('input', (e) => renderContactsDirectory(e.target.value));
$('syncManualContactsBtn').addEventListener('click', () => {
    syncContacts(parseManualContactsInput($('manualContactsInput').value), false, 'Répertoire mis à jour');
});
$('importDeviceContactsBtn').addEventListener('click', async () => {
    if (!navigator.contacts?.select) {
        showToast('Import direct indisponible ici. Utilisez le champ de répertoire ci-dessous.');
        return;
    }
    try {
        const picked = await navigator.contacts.select(['name', 'tel'], { multiple: true });
        const entries = (picked || []).flatMap(contact => (contact.tel || []).map(phoneNumber => ({
            label: Array.isArray(contact.name) ? contact.name[0] : (contact.name || ''),
            phoneNumber
        })));
        syncContacts(entries, false, 'Contacts importés');
    } catch (err) {
        showToast('Import des contacts annulé');
    }
});

$('enableNotificationsBtn').addEventListener('click', async () => {
    if (!('Notification' in window)) {
        showToast('Notifications non supportées sur cet appareil');
        return;
    }
    if (Notification.permission === 'granted') {
        showToast('Notifications déjà activées');
        return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
        $('enableNotificationsBtn').textContent = 'Notifications activées';
        showToast('Notifications activées');
    } else {
        showToast('Permission refusée');
    }
});

$('savePrivacyBtn').addEventListener('click', () => {
    if (!currentUser) return;
    const privacy = {
        profilePhoto: $('privacyPageProfilePhoto').value,
        presence: $('privacyPagePresence').value,
        phone: $('privacyPagePhone').value,
        status: $('privacyPageStatus').value
    };
    const payload = {
        avatar: currentUser.avatar,
        bio: currentUser.bio || '',
        privacy
    };
    if (currentUser.email) payload.email = currentUser.email;
    if (currentUser.phoneCountryCode || currentUser.phoneLocalNumber) {
        payload.countryCode = currentUser.phoneCountryCode || '+242';
        payload.phoneNumber = currentUser.phoneLocalNumber || '';
    }
    socket.emit('update-profile', payload, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        setReadReceiptsEnabled($('privacyReadReceipts').checked);
        syncCurrentUser(res.user);
        if ($('privacyProfilePhoto')) $('privacyProfilePhoto').value = privacy.profilePhoto;
        if ($('privacyPresence')) $('privacyPresence').value = privacy.presence;
        if ($('privacyPhone')) $('privacyPhone').value = privacy.phone;
        if ($('privacyStatus')) $('privacyStatus').value = privacy.status;
        closeModal('privacyModal');
        showToast('Confidentialité mise à jour');
    });
});

// ── Manage Group ───────────────────────────────────────────────
function openManageGroupModal() {
    if (!currentChat || currentChat.type !== 'group') return;
    const group = groups.find(g => g.id === currentChat.id);
    if (!group) return;
    manageGroupAvatarUrl = group.avatar;
    $('manageGroupAvatarPreview').innerHTML = `<img src="${group.avatar}" alt="">`;
    $('manageGroupName').value = group.name || '';
    $('manageGroupDesc').value = group.description || '';
    $('manageGroupPublic').checked = !!group.isPublic;
    $('manageGroupInviteLink').value = `${window.location.origin}/?invite=${encodeURIComponent(group.id)}:${encodeURIComponent(group.inviteToken || '')}`;
    const list = $('manageMembersList');
    list.innerHTML = '';
    group.members.forEach(pseudo => {
        const user = allUsers.find(u => u.pseudo === pseudo);
        const isAdmin = group.admins.includes(pseudo);
        const isMe = pseudo === currentUser.pseudo;
        const div = document.createElement('div');
        div.className = 'mm-item';
        div.innerHTML = `
            <img src="${user?.avatar || dicebear(pseudo)}" alt="">
            <div style="flex:1">
                <div class="mm-item-name">${escHtml(pseudo)}</div>
                ${isAdmin ? '<div class="mm-item-role">Admin</div>' : ''}
            </div>
            <div class="mm-actions">
                ${!isMe && !isAdmin ? `<button class="mm-ban-btn" onclick="banMember('${pseudo}')">Bannir</button>` : ''}
            </div>
        `;
        list.appendChild(div);
    });
    $('addMemberInput').value = '';
    openModal('manageGroupModal');
}
$('manageGroupAvatarPreview').addEventListener('click', () => $('manageGroupAvatarFile').click());
$('manageGroupAvatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const data = await uploadAvatarFile(file);
        manageGroupAvatarUrl = data.avatarUrl;
        $('manageGroupAvatarPreview').innerHTML = `<img src="${manageGroupAvatarUrl}" alt="">`;
    } catch (err) {
        showToast(err.message);
    }
});
$('saveGroupProfileBtn').addEventListener('click', () => {
    if (!currentChat || currentChat.type !== 'group') return;
    socket.emit('update-group-profile', {
        groupId: currentChat.id,
        name: $('manageGroupName').value.trim(),
        description: $('manageGroupDesc').value.trim(),
        avatar: manageGroupAvatarUrl,
        isPublic: $('manageGroupPublic').checked
    }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        upsertGroup(res.group);
        currentChat.name = res.group.name;
        currentChat.avatar = res.group.avatar;
        $('currentChatName').textContent = res.group.name;
        $('chatAvatar').src = res.group.avatar;
        $('manageGroupPublic').checked = !!res.group.isPublic;
        $('manageGroupInviteLink').value = res.inviteUrl || $('manageGroupInviteLink').value;
        renderConversations();
        showToast('Profil du groupe mis à jour');
    });
});
$('copyGroupInviteBtn').addEventListener('click', async () => {
    const input = $('manageGroupInviteLink');
    if (!input?.value) return showToast('Lien indisponible');
    try {
        await navigator.clipboard.writeText(input.value);
        showToast('Lien copié');
    } catch (err) {
        input.focus();
        input.select();
        document.execCommand('copy');
        showToast('Lien copié');
    }
});
$('resetGroupInviteBtn').addEventListener('click', () => {
    if (!currentChat || currentChat.type !== 'group') return;
    socket.emit('reset-group-invite', { groupId: currentChat.id }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        upsertGroup(res.group);
        $('manageGroupInviteLink').value = res.inviteUrl || '';
        showToast('Lien d’invitation réinitialisé');
    });
});
function banMember(pseudo) {
    if (!confirm(`Bannir ${pseudo} ?`)) return;
    socket.emit('ban-member', { groupId: currentChat.id, pseudo }, (res) => {
        if (res.success) {
            const group = groups.find(g => g.id === currentChat.id);
            if (group) group.members = group.members.filter(m => m !== pseudo);
            showToast(`${pseudo} a été banni`);
            openManageGroupModal();
            renderConversations();
        } else showToast(res.error);
    });
}
window.banMember = banMember;
$('addMemberBtn').addEventListener('click', () => {
    const pseudo = $('addMemberInput').value.trim();
    if (!pseudo) return;
    socket.emit('add-member', { groupId: currentChat.id, pseudo }, (res) => {
        if (res.success) {
            const group = groups.find(g => g.id === currentChat.id);
            if (group) { group.members = res.group.members; }
            showToast(`${pseudo} ajouté au groupe`);
            openManageGroupModal();
            renderConversations();
        } else showToast(res.error || 'Erreur');
    });
});

// ── Right Panel ────────────────────────────────────────────────
function openRightPanel() {
    if (!currentChat) return;
    const panel = $('rightPanel');
    const body  = $('rightPanelBody');
    body.innerHTML = '';
    if (currentChat.type === 'private') {
        $('rightPanelTitle').textContent = 'Profil';
        const user = allUsers.find(u => u.pseudo === currentChat.id);
        body.innerHTML = `
            <div class="rp-profile">
                <img src="${currentChat.avatar}" alt="">
                <h3>${escHtml(currentChat.name)}</h3>
                <p>${escHtml(user?.bio || 'Aucune bio')}</p>
            </div>
            <div class="rp-info-row"><i class="fas fa-circle" style="color:${user?.online ? 'var(--success)' : 'var(--text-light)'}"></i><span>${user?.online ? 'En ligne' : lastSeenText(user?.lastSeen)}</span></div>
            <div class="rp-info-row"><i class="fas fa-calendar"></i><span>Membre depuis ${user?.createdAt ? new Date(user.createdAt).toLocaleDateString('fr-FR') : '-'}</span></div>
        `;
    } else {
        $('rightPanelTitle').textContent = 'Informations du groupe';
        const group = groups.find(g => g.id === currentChat.id);
        body.innerHTML = `
            <div class="rp-profile">
                <img src="${currentChat.avatar}" alt="">
                <h3>${escHtml(currentChat.name)}</h3>
                <p>${escHtml(group?.description || 'Groupe DevChat')}</p>
                <p style="margin-top:6px;font-size:12px;color:var(--text-light)">${group?.isPublic ? '🌐 Groupe public' : '🔒 Groupe privé'}</p>
            </div>
            <div class="rp-info-row"><i class="fas fa-users"></i><span>${group?.members.length || 0} membres</span></div>
            <div class="rp-members-title">Membres</div>
        `;
        group?.members.forEach(pseudo => {
            const u = allUsers.find(u => u.pseudo === pseudo);
            const isAdmin = group.admins.includes(pseudo);
            const div = document.createElement('div');
            div.className = 'rp-member-item';
            div.innerHTML = `
                <img src="${u?.avatar || dicebear(pseudo)}" alt="">
                <div>
                    <div class="rp-member-name">${escHtml(pseudo)}</div>
                    ${isAdmin ? '<div class="rp-member-role">Admin</div>' : ''}
                </div>
            `;
            body.appendChild(div);
        });
    }
    panel.classList.add('open');
}
function closeRightPanel() { $('rightPanel').classList.remove('open'); }
window.closeRightPanel = closeRightPanel;

// ═══════════════════════════════════════════════════════════════
//  STATUSES
// ═══════════════════════════════════════════════════════════════
function renderMyStatuses() {
    const list = $('myStatusesList');
    const ownStatuses = statuses
        .filter(status => status.userPseudo === currentUser.pseudo && !isStatusExpired(status))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    list.innerHTML = '';
    if (!ownStatuses.length) {
        list.innerHTML = '<div class="empty-state"><i class="fas fa-circle-notch"></i><p>Aucun statut actif</p><small>Publiez un texte, une image ou une vidéo.</small></div>';
        return;
    }

    ownStatuses.forEach(status => {
        const div = document.createElement('div');
        div.className = 'my-status-item';
        const textThumb = `<div class="my-status-thumb status-text-thumb" style="background:${statusBackgroundStyle(status.background)}">${escHtml((status.text || 'Texte').slice(0, 24))}</div>`;
        div.innerHTML = `
            <img src="${currentUser.avatar}" class="my-status-avatar" alt="">
            ${status.mediaUrl
                ? (status.fileType?.startsWith('video/')
                    ? `<video src="${status.mediaUrl}" muted></video>`
                    : `<img src="${status.mediaUrl}" alt="">`)
                : textThumb
            }
            <div class="my-status-copy">
                <div class="my-status-title">${escHtml(status.text || 'Statut média')}</div>
                <div class="status-meta-sub">${formatTime(status.createdAt)} · ${status.likedByCount || 0} ❤️</div>
            </div>
            <button class="icon-btn my-status-menu" onclick="deleteStatus('${status.id}')"><i class="fas fa-ellipsis-v"></i></button>
        `;
        div.addEventListener('click', (e) => {
            if (e.target.closest('.my-status-menu')) return;
            openStatusViewer(currentUser.pseudo);
        });
        list.appendChild(div);
    });
}

function openStatusComposerModal() {
    $('statusTextInput').value = '';
    statusUpload = null;
    selectedStatusTheme = STATUS_THEMES[0].key;
    $('statusAudienceHint').textContent = `Visible: ${currentUser?.privacy?.status || 'mutual-contacts'}`;
    renderStatusThemePicker();
    updateStatusComposerPreview();
    renderMyStatuses();
    openModal('statusComposerModal');
}

function openStatusViewer(userPseudo) {
    const group = groupedStatuses().find(item => item.userPseudo === userPseudo);
    if (!group) return;
    activeStatusGroup = group.items;
    const firstUnseen = activeStatusGroup.findIndex(status => !status.viewed);
    activeStatusIndex = firstUnseen === -1 ? 0 : firstUnseen;
    openModal('statusViewerModal');
    renderActiveStatus();
}

function renderActiveStatus() {
    if (!activeStatusGroup.length) return closeModal('statusViewerModal');
    const status = activeStatusGroup[activeStatusIndex];
    if (!status) return;
    const contact = getRegisteredContacts().find(entry => entry.pseudo === status.userPseudo);
    $('statusProgressBars').innerHTML = activeStatusGroup.map((item, index) => `<span class="${index <= activeStatusIndex ? 'seen' : ''}"></span>`).join('');
    const viewerName = contact?.contactName || (status.userPseudo === currentUser?.pseudo ? 'Mon statut' : status.userPseudo);
    const viewerAvatar = status.userPseudo === currentUser?.pseudo
        ? currentUser.avatar
        : (allUsers.find(user => user.pseudo === status.userPseudo)?.avatar || contact?.avatar || dicebear(status.userPseudo));
    $('statusViewerAvatar').src = viewerAvatar;
    $('statusViewerName').textContent = viewerName;
    $('statusViewerSubtitle').textContent = `${formatTime(status.createdAt)}${status.userPseudo === currentUser?.pseudo ? ` · ${status.viewedByCount || 0} vues` : ''}`;

    const content = $('statusViewerContent');
    const caption = $('statusViewerCaption');
    if (status.mediaUrl) {
        content.classList.remove('status-text-card');
        content.innerHTML = status.fileType?.startsWith('video/')
            ? `<video src="${status.mediaUrl}" autoplay controls playsinline></video>`
            : `<img src="${status.mediaUrl}" alt="">`;
        caption.textContent = status.text || '';
        caption.style.display = status.text ? 'block' : 'none';
    } else {
        content.classList.add('status-text-card');
        content.style.background = statusBackgroundStyle(status.background);
        content.innerHTML = `<div class="status-viewer-text">${escHtml(status.text || 'Statut')}</div>`;
        caption.style.display = 'none';
    }
    if (status.mediaUrl) content.style.background = '';
    $('likeStatusBtn').innerHTML = `<i class="fas fa-eye"></i><span>${status.viewedByCount || 0} vues</span>`;
    $('repostStatusBtn').innerHTML = `${status.liked ? '<i class="fas fa-heart"></i>' : '<i class="far fa-heart"></i>'}<span>Booster</span>`;
    $('shareStatusBtn').innerHTML = `<i class="fas fa-share-alt"></i><span>Partager</span>`;

    socket.emit('view-status', { statusId: status.id }, (res) => {
        if (res?.success && res.status) {
            upsertStatus(res.status);
            const localIdx = activeStatusGroup.findIndex(item => item.id === res.status.id);
            if (localIdx !== -1) activeStatusGroup[localIdx] = res.status;
            renderStatusStrip();
        }
    });
}

$('likeStatusBtn').addEventListener('click', () => {
    const status = activeStatusGroup[activeStatusIndex];
    if (!status) return;
    const viewers = Array.isArray(status.seenBy) && status.seenBy.length
        ? status.seenBy.map(user => user.pseudo).join(', ')
        : 'Aucune vue pour le moment';
    showToast(viewers, 3500);
});

$('repostStatusBtn').addEventListener('click', () => {
    const status = activeStatusGroup[activeStatusIndex];
    if (!status) return;
    socket.emit('repost-status', { statusId: status.id }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        upsertStatus(res.status);
        renderMyStatuses();
        showToast('Statut repartagé');
    });
});

$('shareStatusBtn').addEventListener('click', async () => {
    const status = activeStatusGroup[activeStatusIndex];
    if (!status) return;
    const shareText = status.text || 'Statut DevChat';
    try {
        if (navigator.share) {
            await navigator.share({ title: 'Statut DevChat', text: shareText, url: status.mediaUrl || window.location.href });
        } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(`${shareText}${status.mediaUrl ? ` ${status.mediaUrl}` : ''}`.trim());
            showToast('Statut copié');
        } else {
            showToast('Partage indisponible');
        }
    } catch (err) {
        if (err?.name !== 'AbortError') showToast('Partage annulé');
    }
});

function deleteStatus(statusId) {
    if (!confirm('Supprimer ce statut ?')) return;
    socket.emit('delete-status', { statusId }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        statuses = statuses.filter(status => status.id !== statusId);
        renderMyStatuses();
        renderStatusStrip();
        showToast('Statut supprimé');
    });
}
window.deleteStatus = deleteStatus;

$('pickStatusMediaBtn').addEventListener('click', () => $('statusMediaInput').click());
$('statusThemePicker').addEventListener('click', (e) => {
    const button = e.target.closest('[data-theme]');
    if (!button) return;
    selectedStatusTheme = button.dataset.theme;
    renderStatusThemePicker();
    updateStatusComposerPreview();
});
$('statusTextInput').addEventListener('input', updateStatusComposerPreview);
$('statusMediaInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const fd = new FormData();
        fd.append('file', file);
        const data = await apiFetch('/api/upload', { method: 'POST', body: fd });
        statusUpload = data;
        $('statusComposerPreview').classList.remove('status-text-preview');
        $('statusComposerPreview').innerHTML = data.fileType?.startsWith('video/')
            ? `<video src="${data.fileUrl}" controls muted></video>`
            : `<img src="${data.fileUrl}" alt="">`;
    } catch (err) {
        showToast(err.message);
    }
});

$('publishTextStatusFab').addEventListener('click', () => {
    const text = $('statusTextInput').value.trim();
    socket.emit('create-status', {
        text,
        mediaUrl: statusUpload?.fileUrl || null,
        fileType: statusUpload?.fileType || null,
        fileName: statusUpload?.fileName || null,
        background: selectedStatusTheme
    }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        upsertStatus(res.status);
        renderMyStatuses();
        renderStatusStrip();
        $('statusTextInput').value = '';
        statusUpload = null;
        selectedStatusTheme = STATUS_THEMES[0].key;
        renderStatusThemePicker();
        updateStatusComposerPreview();
        $('statusMediaInput').value = '';
        showToast('Statut publié');
    });
});

$('publishStatusBtn').addEventListener('click', () => $('pickStatusMediaBtn').click());
$('statusComposerMoreBtn')?.addEventListener('click', () => showToast('Options de statut bientôt'));
$('statusViewerMoreBtn')?.addEventListener('click', () => showToast('Options de statut bientôt'));
$('statusViewerContent').addEventListener('click', (e) => {
    if (!activeStatusGroup.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if ((e.clientX - rect.left) < rect.width / 2) {
        activeStatusIndex = (activeStatusIndex - 1 + activeStatusGroup.length) % activeStatusGroup.length;
    } else {
        activeStatusIndex = (activeStatusIndex + 1) % activeStatusGroup.length;
    }
    renderActiveStatus();
});

async function scanQrFromSource(source) {
    const detector = ensureQrDetector();
    if (detector) {
        try {
            const results = await detector.detect(source);
            const match = results.find(item => item.rawValue);
            if (match?.rawValue) return match.rawValue;
        } catch (err) {
            // Fall through to jsQR local decoder.
        }
    }
    if (typeof jsQR !== 'function') throw new Error('Scan QR non supporté sur cet appareil');
    const imageData = getQrImageDataFromSource(source);
    const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
    return result?.data || '';
}

async function startQrScanning() {
    if (typeof jsQR !== 'function' && !ensureQrDetector()) {
        $('qrScannerHint').textContent = 'Le scan QR n’est pas disponible ici.';
        showToast('Scan QR non supporté sur cet appareil');
        return;
    }
    stopQrScanner();
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false
    });
    qrScannerStream = stream;
    $('qrScannerVideo').srcObject = stream;
    $('qrScannerHint').textContent = 'Scannez un QR de contact ou un lien d’invitation de groupe.';
    const loop = async () => {
        const video = $('qrScannerVideo');
        if (!video || video.readyState < 2) {
            qrScanRaf = requestAnimationFrame(loop);
            return;
        }
        try {
            const text = await scanQrFromSource(video);
            if (text) {
                applyScannedQrPayload(parseScannedQrPayload(text));
                return;
            }
        } catch (err) {
            // Ignore transient detection errors while streaming.
        }
        qrScanRaf = requestAnimationFrame(loop);
    };
    qrScanRaf = requestAnimationFrame(loop);
}

$('startQrScanBtn').addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
        $('qrScannerHint').textContent = 'Caméra indisponible sur cet appareil.';
        return showToast('Caméra indisponible');
    }
    try {
        await startQrScanning();
    } catch (err) {
        $('qrScannerHint').textContent = err.message || 'Impossible de démarrer la caméra.';
        showToast(err.message || 'Impossible de démarrer la caméra');
    }
});

$('qrImageInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
        const bitmap = await createImageBitmap(file);
        const text = await scanQrFromSource(bitmap);
        bitmap.close?.();
        if (!text) throw new Error('Aucun QR détecté dans cette image');
        applyScannedQrPayload(parseScannedQrPayload(text));
    } catch (err) {
        $('qrScannerHint').textContent = err.message || 'Lecture du QR impossible.';
        showToast(err.message || 'Lecture du QR impossible');
    } finally {
        e.target.value = '';
    }
});

// ═══════════════════════════════════════════════════════════════
//  SOCKET LISTENERS
// ═══════════════════════════════════════════════════════════════
function setupSocketListeners() {
    if (socketListenersInitialized) return;
    socketListenersInitialized = true;

    socket.on('new-message', (msg) => {
        upsertConversationMessage(msg);
        if (msg.type === 'private') {
            registerPrivateChat(
                msg.from === currentUser?.pseudo ? msg.to : msg.from
            );
        }
        if (msg.from !== currentUser?.pseudo) notifyIncomingMessage(msg);
        if (currentChat) {
            const relevant = (msg.type === 'private' && currentChat.type === 'private' &&
                (msg.from === currentChat.id || msg.to === currentChat.id)) ||
                (msg.type === 'group' && currentChat.type === 'group' && msg.groupId === currentChat.id);
            if (relevant) {
                if (msg.from !== currentUser.pseudo) {
                    markMessagesAsReadLocally([msg.id]);
                    if (shouldEmitReadReceipt(msg)) socket.emit('mark-read', { messageIds: [msg.id] });
                }
                renderMessages();
            }
        }
        renderConversations();
    });

    socket.on('message-expired', ({ messageId }) => {
        conversations = conversations.filter(message => message.id !== messageId);
        if (currentChat) renderMessages();
        renderConversations();
    });

    socket.on('message-reaction', ({ messageId, reactions }) => {
        const msg = conversations.find(m => m.id === messageId);
        if (msg) msg.reactions = reactions;
        if (currentChat) {
            const el = document.querySelector(`[data-msg-id="${messageId}"]`);
            if (el) {
                // re-render just that message
                const newEl = buildMessageEl(msg);
                el.replaceWith(newEl);
            }
        }
    });

    socket.on('message-deleted', ({ messageId }) => {
        const msg = conversations.find(m => m.id === messageId);
        if (msg) { msg.deleted = true; msg.content = ''; msg.fileUrl = null; }
        selectedMessageIds.delete(messageId);
        updateMessageSelectionUI();
        if (currentChat) {
            const el = document.querySelector(`[data-msg-id="${messageId}"]`);
            if (el && msg) el.replaceWith(buildMessageEl(msg));
        }
    });

    socket.on('message-edited', ({ message }) => {
        const msg = conversations.find(m => m.id === message?.id);
        if (msg && message) Object.assign(msg, message);
        if (currentChat && message) {
            const el = document.querySelector(`[data-msg-id="${message.id}"]`);
            if (el) el.replaceWith(buildMessageEl(message));
        }
        renderConversations();
    });

    socket.on('messages-read', ({ messageIds, by }) => {
        markMessagesAsReadLocally(messageIds, by);
        if (currentChat) renderMessages();
        renderConversations();
    });

    socket.on('group-created', (group) => {
        upsertGroup(group);
        if (group.isUpdatesChannel) {
            updateChannelInfo = { ...(updateChannelInfo || {}), ...group, joined: true };
            renderUpdateChannelPrompt();
        }
        renderConversations();
    });

    socket.on('group-updated', (group) => {
        upsertGroup(group);
        if (group.isUpdatesChannel) {
            updateChannelInfo = {
                id: group.id,
                name: group.name,
                description: group.description,
                avatar: group.avatar,
                joined: group.members.includes(currentUser?.pseudo)
            };
            renderUpdateChannelPrompt();
        }
        if (currentChat?.id === group.id) {
            $('currentChatStatus').textContent = `${group.members.length} membres`;
            refreshChatComposerState();
        }
        renderConversations();
    });

    socket.on('group-left', ({ groupId }) => {
        groups = groups.filter(g => g.id !== groupId);
        if (updateChannelInfo?.id === groupId) {
            updateChannelInfo = { ...updateChannelInfo, joined: false };
            renderUpdateChannelPrompt();
        }
        if (currentChat?.id === groupId) closeChatArea();
        renderConversations();
    });

    socket.on('you-were-banned', ({ groupId, groupName }) => {
        groups = groups.filter(g => g.id !== groupId);
        if (updateChannelInfo?.id === groupId) {
            updateChannelInfo = { ...updateChannelInfo, joined: false };
            renderUpdateChannelPrompt();
        }
        if (currentChat?.id === groupId) closeChatArea();
        renderConversations();
        showToast(`Vous avez été banni de "${groupName}"`);
    });

    socket.on('users-list', (users) => {
        allUsers = users;
        knownPrivateChats = knownPrivateChats.map(chat => ({
            ...chat,
            avatar: users.find(user => user.pseudo === chat.pseudo)?.avatar || chat.avatar
        }));
        renderStatusStrip();
        renderConversations();
        if (currentChat?.type === 'private') {
            const u = users.find(u => u.pseudo === currentChat.id);
            $('currentChatStatus').textContent = u?.presenceHidden ? 'Présence masquée' : (u?.online ? 'En ligne' : lastSeenText(u?.lastSeen));
            $('chatOnlineDot').classList.toggle('show', !!u?.online);
        }
    });

    socket.on('user-typing', ({ from, groupId, isTyping }) => {
        const relevant = currentChat && (
            (currentChat.type === 'private' && from === currentChat.id) ||
            (currentChat.type === 'group' && groupId === currentChat.id)
        );
        if (!relevant) return;
        clearTimeout(typingTimers[from]);
        if (isTyping) {
            $('typingText').textContent = `${from} est en train d'écrire...`;
            $('typingIndicator').style.display = 'flex';
            typingTimers[from] = setTimeout(() => $('typingIndicator').style.display = 'none', 3000);
        } else {
            $('typingIndicator').style.display = 'none';
        }
    });

    socket.on('system', ({ text }) => {
        const div = document.createElement('div');
        div.className = 'msg-system';
        div.textContent = text;
        $('messagesContainer').appendChild(div);
        $('messagesContainer').scrollTop = $('messagesContainer').scrollHeight;
        renderConversations();
    });

    socket.on('statuses-updated', (nextStatuses) => {
        statuses = nextStatuses || [];
        if ($('statusViewerModal').classList.contains('open') && activeStatusGroup.length) {
            const owner = activeStatusGroup[0]?.userPseudo;
            activeStatusGroup = statuses.filter(status => status.userPseudo === owner && !isStatusExpired(status));
            if (!activeStatusGroup.length) closeModal('statusViewerModal');
            else {
                activeStatusIndex = Math.min(activeStatusIndex, activeStatusGroup.length - 1);
                renderActiveStatus();
            }
        }
        renderStatusStrip();
        if ($('statusComposerModal').classList.contains('open')) renderMyStatuses();
    });

    socket.on('status-deleted', ({ statusId }) => {
        statuses = statuses.filter(status => status.id !== statusId);
        activeStatusGroup = activeStatusGroup.filter(status => status.id !== statusId);
        if (!activeStatusGroup.length) closeModal('statusViewerModal');
        else {
            activeStatusIndex = Math.min(activeStatusIndex, activeStatusGroup.length - 1);
            renderActiveStatus();
        }
        renderStatusStrip();
        if ($('statusComposerModal').classList.contains('open')) renderMyStatuses();
    });

    socket.on('incoming-call', ({ from, mode, avatar }) => {
        if (activeCall || pendingIncomingCall) {
            socket.emit('call-response', { to: from, accepted: false, mode, reason: 'Occupé' });
            return;
        }
        const user = allUsers.find(item => item.pseudo === from);
        pendingIncomingCall = {
            pseudo: from,
            name: user?.pseudo || from,
            avatar: avatar || user?.avatar || dicebear(from),
            mode: mode === 'video' ? 'video' : 'audio',
            status: `${mode === 'video' ? 'Appel vidéo' : 'Appel audio'} entrant`,
            startedAt: new Date().toISOString()
        };
        openCallModal();
    });

    socket.on('call-response', async ({ from, accepted, mode, reason }) => {
        if (!activeCall || activeCall.pseudo !== from) return;
        if (!accepted) {
            showToast(reason || 'Appel refusé');
            pushCallHistory({
                pseudo: from,
                avatar: activeCall.avatar,
                mode: activeCall.mode,
                direction: 'outgoing',
                status: reason || 'Refusé',
                startedAt: activeCall.startedAt || new Date().toISOString(),
                endedAt: new Date().toISOString(),
                durationMinutes: 0,
                joinedParticipants: [currentUser?.pseudo].filter(Boolean)
            });
            resetActiveCallState();
            return;
        }
        activeCall.status = mode === 'video' ? 'Connexion vidéo...' : 'Connexion audio...';
        updateCallControls();
        try {
            await startPeerOffer();
        } catch (err) {
            showToast('Échec de connexion de l’appel');
            endCurrentCall('Échec');
        }
    });

    socket.on('call-signal', async ({ from, data }) => {
        if (!activeCall || activeCall.pseudo !== from || !data) return;
        try {
            const pc = createPeerConnection(activeCall);
            if (data.type === 'offer' && data.sdp) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                socket.emit('call-signal', { to: from, data: { type: 'answer', sdp: answer } });
            } else if (data.type === 'answer' && data.sdp) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            } else if (data.type === 'ice' && data.candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        } catch (err) {
            showToast('Signal d’appel invalide');
            endCurrentCall('Échec');
        }
    });

    socket.on('call-ended', ({ from, reason }) => {
        const relatedCall = activeCall && activeCall.pseudo === from;
        const relatedPending = pendingIncomingCall && pendingIncomingCall.pseudo === from;
        if (!relatedCall && !relatedPending) return;
        if (activeCall) {
            const endedAt = new Date().toISOString();
            const durationMinutes = activeCall.connectedAt ? Math.max(1, Math.round((new Date(endedAt) - new Date(activeCall.connectedAt)) / 60000)) : 0;
            pushCallHistory({
                pseudo: activeCall.pseudo,
                avatar: activeCall.avatar,
                mode: activeCall.mode,
                direction: activeCall.direction,
                status: reason || 'Terminé',
                startedAt: activeCall.startedAt || endedAt,
                endedAt,
                durationMinutes,
                joinedParticipants: activeCall.joinedParticipants || [activeCall.pseudo]
            });
        }
        showToast(reason || 'Appel terminé');
        resetActiveCallState();
    });
}

// ═══════════════════════════════════════════════════════════════
//  MODAL HELPERS
// ═══════════════════════════════════════════════════════════════
function openModal(id) { $(id).classList.add('open'); $(id).style.display = 'flex'; }
function closeModal(id) {
    if (id === 'qrScannerModal') stopQrScanner();
    $(id).classList.remove('open');
    $(id).style.display = 'none';
}

document.querySelectorAll('.close-modal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const modalId = btn.dataset.modal;
        if (modalId) closeModal(modalId);
    });
});
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal.id);
    });
});

function openImageViewer(src) {
    $('imageViewerImg').src = src;
    $('imageViewer').classList.add('open');
    $('imageViewer').style.display = 'flex';
}
window.openImageViewer = openImageViewer;

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════
function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const isYesterday = new Date(now - 86400000).toDateString() === d.toDateString();
    if (isYesterday) return 'Hier';
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

function lastSeenText(iso) {
    if (!iso) return 'Hors ligne';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60000)     return 'Vu il y a quelques secondes';
    if (diff < 3600000)   return `Vu il y a ${Math.floor(diff/60000)} min`;
    if (diff < 86400000)  return `Vu aujourd'hui à ${d.toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' })}`;
    return `Vu le ${d.toLocaleDateString('fr-FR')}`;
}

function dicebear(seed) {
    return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(seed)}&backgroundColor=2aabee`;
}

function showToast(msg, duration = 2500) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

function pruneExpiredState() {
    const beforeMessages = conversations.length;
    const beforeStatuses = statuses.length;
    conversations = conversations.filter(message => !isMessageExpired(message));
    statuses = statuses.filter(status => !isStatusExpired(status));

    if (beforeMessages !== conversations.length) {
        if (currentChat) renderMessages();
        renderConversations();
    }
    if (beforeStatuses !== statuses.length) {
        renderStatusStrip();
        if ($('statusComposerModal').classList.contains('open')) renderMyStatuses();
    }
}

setInterval(pruneExpiredState, 5000);

if ('serviceWorker' in navigator) {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        navigator.serviceWorker.getRegistrations().then(registrations => registrations.forEach(registration => registration.unregister()));
        if ('caches' in window) caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
    } else {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type !== 'open-chat') return;
        const { chatType, chatId } = event.data;
        if (!chatType || !chatId) return;

        if (chatType === 'group') {
            const group = groups.find(item => item.id === chatId);
            if (group) openChat({ type: 'group', id: group.id, name: group.name, avatar: group.avatar });
        } else {
            const user = allUsers.find(item => item.pseudo === chatId);
            openChat({
                type: 'private',
                id: chatId,
                name: chatId,
                avatar: user?.avatar || dicebear(chatId)
            });
        }
    });
}

// ═══════════════════════════════════════════════════════════════
//  RESPONSIVE
// ═══════════════════════════════════════════════════════════════
window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
        $('sidebar').classList.remove('hidden');
    }
});

// ═══════════════════════════════════════════════════════════════
//  AUTO-RECONNEXION — restaure la session sans reload
// ═══════════════════════════════════════════════════════════════
function setupReconnectHandler() {
    let reconnectBanner = null;

    function showReconnectBanner() {
        if (reconnectBanner) return;
        reconnectBanner = document.createElement('div');
        reconnectBanner.id = 'reconnectBanner';
        reconnectBanner.style.cssText = `
            position:fixed;top:0;left:0;right:0;z-index:99999;
            background:#e53935;color:#fff;text-align:center;
            padding:10px;font-size:13px;font-weight:600;
            display:flex;align-items:center;justify-content:center;gap:8px;
        `;
        reconnectBanner.innerHTML = `<i class="fas fa-wifi"></i> Reconnexion en cours...`;
        document.body.appendChild(reconnectBanner);
    }

    function hideReconnectBanner() {
        if (reconnectBanner) {
            reconnectBanner.remove();
            reconnectBanner = null;
        }
    }

    socket.on('disconnect', (reason) => {
        console.log('[Socket] Déconnecté:', reason);
        // Ne pas montrer la bannière si c'est une déconnexion volontaire (logout)
        if (reason === 'io client disconnect') return;
        showReconnectBanner();
    });

    socket.on('connect', () => {
        console.log('[Socket] Connecté:', socket.id);
        hideReconnectBanner();

        // Si on était déjà connecté (reconnexion), restaurer la session
        if (currentUser) {
            console.log('[Socket] Restauration session pour:', currentUser.pseudo);
            restoreSessionWithToken((res) => {
                currentUser   = res.user;
                groups        = res.groups   || groups;
                allUsers      = res.users    || allUsers;
                statuses      = res.statuses || statuses;
                updateChannelInfo = res.updateChannel || updateChannelInfo;
                authSessionToken = res.sessionToken || authSessionToken;
                persistSessionAuth({ pseudo: res.user?.pseudo, token: authSessionToken });
                (res.messages || []).forEach(m => {
                    if (!conversations.find(x => x.id === m.id)) conversations.push(m);
                });
                updateSidebarUser();
                renderStatusStrip();
                renderUpdateChannelPrompt();
                renderConversations();
                refreshActusPage();
                if (currentChat) renderMessages();
                showToast('✓ Reconnecté');
            });
            return;
        }

        if (!currentUser && $('authScreen').style.display !== 'none') {
            restoreSessionWithToken((res) => {
                onAuthSuccess(res);
                showToast('Session restaurée');
            });
        }
    });

    socket.on('connect_error', (err) => {
        console.warn('[Socket] Erreur connexion:', err.message);
        showReconnectBanner();
    });
}

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION PAR ONGLETS (WhatsApp style)
// ═══════════════════════════════════════════════════════════════
function switchTab(pageId, btn) {
    // Pages
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    const page = $(pageId);
    if (page) page.classList.add('active');
    // Buttons
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Topbar title
    const titles = {
        pageDiscussions: 'DevChat',
        pageActus:       'Actus',
        pageAppels:      'Appels',
        pageParametres:  'Paramètres'
    };
    const topbar = $('topbarTitle');
    if (topbar) topbar.textContent = titles[pageId] || 'DevChat';
    if ($('mobileSearchBar')) $('mobileSearchBar').style.display = 'none';
    if ($('appTopbar')) $('appTopbar').style.display = 'flex';
    if ($('mobileSearch')) $('mobileSearch').value = '';
    if ($('mobileSearchResultsPanel')) $('mobileSearchResultsPanel').style.display = 'none';
    if ($('conversationsListMobile')) $('conversationsListMobile').style.display = 'flex';
    // Page-specific refresh
    if (pageId === 'pageDiscussions') {
        renderConversations();
    }
    if (pageId === 'pageActus')      refreshActusPage();
    if (pageId === 'pageParametres') initSettingsPage();
}
window.switchTab = switchTab;

// ═══════════════════════════════════════════════════════════════
//  INIT MOBILE UI
// ═══════════════════════════════════════════════════════════════
function initMobileUI() {
    if (window.__devchatMobileUIInitialized) return;
    window.__devchatMobileUIInitialized = true;

    // Topbar search
    const searchBtn = $('topbarSearchBtn');
    const searchBar = $('mobileSearchBar');
    const searchBack= $('mobileSearchBack');
    const searchInp = $('mobileSearch');
    if (searchBtn) searchBtn.addEventListener('click', () => {
        searchBar.style.display = 'flex';
        $('appTopbar').style.display = 'none';
        searchInp.focus();
    });
    if (searchBack) searchBack.addEventListener('click', () => {
        searchBar.style.display = 'none';
        $('appTopbar').style.display = 'flex';
        searchInp.value = '';
        $('mobileSearchResultsPanel').style.display = 'none';
        $('conversationsListMobile').style.display  = 'flex';
    });
    if (searchInp) {
        searchInp.addEventListener('input', e => {
            const q = e.target.value.trim();
            if (!q) {
                $('mobileSearchResultsPanel').style.display = 'none';
                $('conversationsListMobile').style.display  = 'flex';
                return;
            }
            const results = filteredRegisteredContacts(q);
            $('mobileSearchResultsPanel').style.display  = 'block';
            $('conversationsListMobile').style.display   = 'none';
            const list = $('mobileSearchResultsList');
            list.innerHTML = '';
            if (!results?.length) { list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-gray)">Aucun contact enregistré</div>'; return; }
            results.forEach(u => {
                const d = document.createElement('div');
                d.className = 'search-result-item';
                d.innerHTML = `<img src="${u.avatar||dicebear(u.contactName||u.pseudo)}" alt=""><div><div class="sr-name">${escHtml(u.contactName || u.pseudo)}</div><div class="sr-sub">${escHtml(u.phoneNumber || '')}</div><div class="sr-sub">${u.presenceHidden ? 'Présence masquée' : (u.online?'En ligne':lastSeenText(u.lastSeen))}</div></div>`;
                d.addEventListener('click', () => {
                    searchBar.style.display = 'none';
                    $('appTopbar').style.display = 'flex';
                    searchInp.value = '';
                    $('mobileSearchResultsPanel').style.display = 'none';
                    $('conversationsListMobile').style.display  = 'flex';
                    openChat({ type:'private', id:u.pseudo, name:u.contactName || u.pseudo, avatar:u.avatar||dicebear(u.contactName||u.pseudo) });
                });
                list.appendChild(d);
            });
        });
    }

    // Topbar more menu
    const moreBtn = $('topbarMoreBtn');
    const moreMenu= $('topbarCtxMenu');
    if (moreBtn) moreBtn.addEventListener('click', e => { e.stopPropagation(); moreMenu.classList.toggle('open'); });

    // FAB new chat → contacts modal
    const fab = $('fabNewChat');
    if (fab) fab.addEventListener('click', () => {
        switchTab('pageDiscussions', document.querySelector('[data-tab="pageDiscussions"]'));
        openContactsModal();
    });

    // FAB status
    const fabSt = $('fabStatus');
    if (fabSt) fabSt.addEventListener('click', () => {
        openStatusComposerModal();
    });

    // FAB call
    const fabCall = $('fabCall');
    if (fabCall) fabCall.addEventListener('click', () => {
        if (!currentChat || currentChat.type !== 'private') {
            switchTab('pageDiscussions', document.querySelector('[data-tab="pageDiscussions"]'));
            showToast('Ouvrez un chat privé pour appeler');
            return;
        }
        startCall('audio');
    });

    // Logout mobile
    const logoutMobile = $('logoutBtnMobile');
    if (logoutMobile) logoutMobile.addEventListener('click', () => {
        if (confirm('Se déconnecter ?')) {
            const token = authSessionToken;
            authSessionToken = null;
            clearSessionAuth();
            socket.emit('logout', { sessionToken: token }, () => {
                socket.disconnect();
                location.reload();
            });
        }
    });

    // Mobile menu btn (opens drawer)
    const mobileMenuBtn = $('mobileMenuBtn');
    if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleDrawer);

    // Camera btn
    const camBtn = $('topbarCameraBtn');
    if (camBtn) camBtn.addEventListener('click', () => openStatusComposerModal());

    // Call create link
    const callLink = $('callCreateLinkBtn');
    if (callLink) callLink.addEventListener('click', () => {
        if (!currentChat || currentChat.type !== 'private') {
            showToast('Ouvrez un chat privé puis lancez un appel');
            return;
        }
        startCall('video');
    });

    // Admin btn in menu
    const adminBtn = $('adminMenuBtn');
    if (adminBtn && currentUser?.isAdmin) { adminBtn.style.display = 'flex'; }

    // Settings admin row
    const sAdminBtn = $('settingsAdminBtn');
    if (sAdminBtn && currentUser?.isAdmin) {
        sAdminBtn.style.display = 'flex';
        sAdminBtn.addEventListener('click', () => { if (typeof openAdminModal === 'function') openAdminModal(); });
    }

    // Settings rows handlers
    const sp = $('settingsPrivacyBtn');
    if (sp) sp.addEventListener('click', () => openPrivacyModal());
    const sn = $('settingsNotifBtn');
    if (sn) sn.addEventListener('click', () => showToast('Paramètres de notifications — bientôt'));
    const st = $('settingsThemeBtn');
    if (st) st.addEventListener('click', () => openModal('settingsThemeModal'));
    const ss = $('settingsStorageBtn');
    if (ss) ss.addEventListener('click', () => showToast('Stockage et données — bientôt'));
    const sh = $('settingsHelpBtn');
    if (sh) sh.addEventListener('click', () => showToast('Centre d\'aide — bientôt'));

    // Settings profile banner → profile modal
    const banner = $('settingsProfileBanner');
    if (banner) banner.addEventListener('click', () => openDrawerSection('profile'));

    // Theme modal
    initThemeModal();
    // Actus page
    initActusPage();
    renderCallsHistory();
}

// ═══════════════════════════════════════════════════════════════
//  SETTINGS PAGE
// ═══════════════════════════════════════════════════════════════
function initSettingsPage() {
    if (!currentUser) return;
    const av = $('settingsAvatar'); if (av) av.src = currentUser.avatar;
    const nm = $('settingsName');   if (nm) nm.textContent = currentUser.pseudo;
    const ph = $('settingsPhone');  if (ph) ph.textContent = currentUser.phoneNumber || ((currentUser.phoneCountryCode || '') + ' ' + (currentUser.phoneLocalNumber || '')).trim() || 'Non renseigné';
    const bi = $('settingsBio');    if (bi) bi.textContent = currentUser.bio || '';
    const dot= $('settingsOnlineDot'); if (dot) dot.style.display = currentUser.online ? 'block' : 'none';
    if (currentUser.isAdmin) {
        const adminRow = $('settingsAdminBtn');
        if (adminRow) { adminRow.style.display = 'flex'; adminRow.onclick = () => { if (typeof openAdminModal==='function') openAdminModal(); }; }
    }
}

// ═══════════════════════════════════════════════════════════════
//  ACTUS PAGE
// ═══════════════════════════════════════════════════════════════
function initActusPage() {
    const myAv = $('actusMyAvatar');
    if (myAv && currentUser) myAv.src = currentUser.avatar;
    const myItem = $('actusMyItem');
    if (myItem && !myItem.dataset.boundStatusOpen) {
        myItem.dataset.boundStatusOpen = 'true';
        myItem.addEventListener('click', () => {
            openStatusComposerModal();
        });
    }
    refreshActusPage();
}

function refreshActusPage() {
    renderActusFriends();
    renderActusChannels();
    updateActusBadge();
}

function updateActusBadge() {
    const badge = $('tabBadgeActus');
    if (!badge || !currentUser) return;

    const unseenContacts = new Set();
    statuses.forEach(status => {
        if (status.userPseudo === currentUser.pseudo) return;
        if (!status.viewed) unseenContacts.add(status.userPseudo);
    });

    badge.textContent = unseenContacts.size > 99 ? '99+' : String(unseenContacts.size);
    badge.style.display = unseenContacts.size > 0 ? 'block' : 'none';
}

function renderActusStatusSection(title, entries, tone = 'recent') {
    if (!entries.length) return '';
    return `
        <div class="actus-status-section">
            <div class="actus-section-label ${tone === 'seen' ? 'is-seen' : ''}">${title}</div>
            <div class="actus-status-stack">
                ${entries.map(({ pseudo, statuses: sts }) => {
                    const user = allUsers.find(u => u.pseudo === pseudo);
                    const contact = getRegisteredContacts().find(entry => entry.pseudo === pseudo);
                    const allSeen = sts.every(s => s.viewed);
                    const latest = sts[0];
                    return `
                        <div class="actus-friend-item ${allSeen ? 'is-seen' : 'is-fresh'}" data-status-owner="${escHtml(pseudo)}">
                            <div class="actus-friend-ring ${allSeen ? 'seen' : 'unseen'}">
                                <img src="${user?.avatar || contact?.avatar || dicebear(pseudo)}" alt="">
                            </div>
                            <div class="actus-friend-info">
                                <div class="actus-friend-name">${escHtml(contact?.contactName || pseudo)}</div>
                                <div class="actus-friend-time">${timeAgo(latest.createdAt)}</div>
                                <div class="actus-friend-meta">${sts.length} statut${sts.length > 1 ? 's' : ''} · ${allSeen ? 'vus' : 'nouveaux'}</div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderActusFriends() {
    const list = $('actusFriendsList');
    if (!list) return;

    const friendStatuses = new Map();

    statuses.forEach(s => {
        if (s.userPseudo === currentUser?.pseudo) return;
        if (!friendStatuses.has(s.userPseudo)) friendStatuses.set(s.userPseudo, []);
        friendStatuses.get(s.userPseudo).push(s);
    });

    if (!friendStatuses.size) {
        list.innerHTML = '<div class="actus-empty-state"><i class="fas fa-circle-notch"></i><p>Aucun statut de vos contacts</p><small>Les statuts sont visibles uniquement entre contacts mutuels</small></div>';
        return;
    }
    const recentEntries = [];
    const seenEntries = [];
    friendStatuses.forEach((sts, pseudo) => {
        const sortedStatuses = [...sts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const allSeen = sortedStatuses.every(s => s.viewed);
        (allSeen ? seenEntries : recentEntries).push({ pseudo, statuses: sortedStatuses });
    });
    recentEntries.sort((a, b) => new Date(b.statuses[0].createdAt) - new Date(a.statuses[0].createdAt));
    seenEntries.sort((a, b) => new Date(b.statuses[0].createdAt) - new Date(a.statuses[0].createdAt));

    list.innerHTML = [
        renderActusStatusSection('Récentes', recentEntries, 'recent'),
        renderActusStatusSection('Déjà vues', seenEntries, 'seen')
    ].filter(Boolean).join('');

    list.querySelectorAll('[data-status-owner]').forEach(node => {
        node.addEventListener('click', () => openStatusViewer(node.dataset.statusOwner));
    });
}

function renderActusChannels() {
    const list = $('actusChannelsList');
    if (!list) return;
    const channelGroups = groups.filter(g => g.isUpdatesChannel);
    if (!channelGroups.length) {
        list.innerHTML = '<div class="actus-empty-state"><i class="fas fa-broadcast-tower"></i><p>Aucune chaîne</p></div>';
        return;
    }
    list.innerHTML = '';
    channelGroups.forEach(ch => {
        const lastMsg = conversations.filter(m => m.type==='group' && m.groupId===ch.id).sort((a,b)=>new Date(b.date)-new Date(a.date))[0];
        const div = document.createElement('div');
        div.className = 'actus-channel-item';
        div.innerHTML = `
            <img src="${ch.avatar||dicebear(ch.name)}" class="actus-channel-av" alt="">
            <div>
                <div class="actus-channel-name">${escHtml(ch.name)}</div>
                <div class="actus-channel-sub">${lastMsg ? escHtml(lastMsg.content?.slice(0,50)||'📎') : 'Aucun message'}</div>
            </div>
            <span style="font-size:11px;color:var(--text-light);margin-left:auto">${lastMsg?formatTime(lastMsg.date):''}</span>
        `;
        div.addEventListener('click', () => openChat({ type:'group', id:ch.id, name:ch.name, avatar:ch.avatar||dicebear(ch.name) }));
        list.appendChild(div);
    });
}

// ═══════════════════════════════════════════════════════════════
//  THEME MODAL
// ═══════════════════════════════════════════════════════════════
function initThemeModal() {
    if (window.__devchatThemeModalInitialized) return;
    window.__devchatThemeModalInitialized = true;

    const ACCENTS = ['#2aabee','#25d366','#ff9800','#e53935','#9c27b0','#00bcd4','#f06292'];
    const container = $('accentColors');
    if (container) {
        ACCENTS.forEach(c => {
            const s = document.createElement('div');
            s.className = 'accent-swatch' + (c === '#2aabee' ? ' active' : '');
            s.style.background = c;
            s.addEventListener('click', () => {
                document.querySelectorAll('.accent-swatch').forEach(x => x.classList.remove('active'));
                s.classList.add('active');
                document.documentElement.style.setProperty('--primary', c);
                localStorage.setItem('devchat_accent', c);
                showToast('Couleur appliquée');
            });
            container.appendChild(s);
        });
    }
    const fontRange = $('fontSizeRange');
    const fontVal   = $('fontSizeVal');
    if (fontRange) {
        fontRange.addEventListener('input', () => {
            const v = fontRange.value;
            document.body.style.fontSize = v + 'px';
            if (fontVal) fontVal.textContent = v + 'px';
            localStorage.setItem('devchat_font_size', v);
        });
    }

    applyThemeSettings();
}

function setTheme(theme, btn) {
    document.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (theme === 'dark')  { document.body.classList.remove('theme-light'); }
    if (theme === 'light') { document.body.classList.add('theme-light'); }
    if (theme === 'auto')  {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.classList.toggle('theme-light', !prefersDark);
    }
    localStorage.setItem('devchat_theme', theme);
    showToast('Thème appliqué');
}
window.setTheme = setTheme;

function applyThemeSettings() {
    const savedTheme = localStorage.getItem('devchat_theme') || 'dark';
    const savedAccent = localStorage.getItem('devchat_accent');
    const savedFontSize = localStorage.getItem('devchat_font_size');
    const themeBtn = document.querySelector(`.theme-option[data-theme="${savedTheme}"]`);

    document.querySelectorAll('.theme-option').forEach(option => option.classList.remove('active'));
    if (themeBtn) themeBtn.classList.add('active');

    if (savedTheme === 'light') document.body.classList.add('theme-light');
    else if (savedTheme === 'dark') document.body.classList.remove('theme-light');
    else {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.classList.toggle('theme-light', !prefersDark);
    }

    if (savedAccent) {
        document.documentElement.style.setProperty('--primary', savedAccent);
        document.querySelectorAll('.accent-swatch').forEach(swatch => {
            swatch.classList.toggle('active', swatch.style.background === savedAccent);
        });
    }

    if (savedFontSize) {
        document.body.style.fontSize = savedFontSize + 'px';
        if ($('fontSizeRange')) $('fontSizeRange').value = savedFontSize;
        if ($('fontSizeVal')) $('fontSizeVal').textContent = savedFontSize + 'px';
    }
}

// Apply saved theme on load
(function() {
    const saved = localStorage.getItem('devchat_theme');
    if (saved === 'light') document.body.classList.add('theme-light');
})();

function bootstrapStoredSession() {
    if (!readStoredSession()) return;
    const restore = () => restoreSessionWithToken((res) => {
        onAuthSuccess(res);
    });
    if (socket.connected) restore();
    else socket.once('connect', restore);
}

bootstrapStoredSession();

// ═══════════════════════════════════════════════════════════════
//  openDrawerSection — make sure 'statuses' opens status composer
// ═══════════════════════════════════════════════════════════════
const _origOpenDrawerSection = typeof openDrawerSection === 'function' ? openDrawerSection : null;
function openDrawerSection(section) {
    // Close drawer first
    const drawer = $('drawer'), overlay = $('drawerOverlay');
    if (drawer)  drawer.classList.remove('open');
    if (overlay) overlay.classList.remove('show');
    $('topbarCtxMenu')?.classList.remove('open');

    if (section === 'statuses') {
        openStatusComposerModal();
        return;
    }
    if (section === 'profile') { openProfileModal(); return; }
    if (section === 'explore') { openExploreModal(); return; }
    if (section === 'newgroup'){ openModal('newGroupModal'); return; }
    if (section === 'secret')  { showToast('Ouvrez un chat → menu → Chat secret'); return; }
}
window.openDrawerSection = openDrawerSection;

// openAdminModal wrapper
function openAdminModal() {
    openProfileModal();
    // Admin stats are shown inside profile modal
    setTimeout(() => {
        if (currentUser?.isAdmin) requestAppStats();
    }, 200);
}
window.openAdminModal = openAdminModal;

// ═══════════════════════════════════════════════════════════════
//  TIME AGO helper (for actus)ss
// ═══════════════════════════════════════════════════════════════
function timeAgo(iso) {
    if (!iso) return '';
    const d    = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60000)    return 'À l\'instant';
    if (diff < 3600000)  return `Il y a ${Math.floor(diff/60000)} min`;
    if (diff < 86400000) return `Il y a ${Math.floor(diff/3600000)}h`;
    return d.toLocaleDateString('fr-FR');
}

// Close topbar ctx menu on outside click
document.addEventListener('click', () => {
    $('topbarCtxMenu')?.classList.remove('open');
});
