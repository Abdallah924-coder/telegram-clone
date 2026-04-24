// ═══════════════════════════════════════════════════════════════
//  DevChat - Client Script
// ═══════════════════════════════════════════════════════════════
const socket = io({ transports: ['websocket', 'polling'] });

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
    if (!$('sendBtn') || !$('voiceBtn') || !$('messageInput')) return;
    const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    if (isReadonlyOfficialChannel()) {
        $('sendBtn').style.display = 'none';
        $('voiceBtn').style.display = 'none';
        return;
    }
    const hasText = !!$('messageInput').value.trim();
    $('sendBtn').style.display = hasText || isRecording ? 'inline-flex' : 'none';
    $('voiceBtn').style.display = !canRecord || hasText ? 'none' : 'inline-flex';
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
        if (typeof onSuccess === 'function') onSuccess();
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
}

function initCountrySelect(id, defaultCode = '+242') {
    const select = $(id);
    if (!select) return;
    select.innerHTML = COUNTRY_CODES.map(country => `<option value="${country.code}">${country.label}</option>`).join('');
    select.value = defaultCode;
}

function initCountrySelectors() {
    ['loginCountryCode', 'regCountryCode', 'resetCountryCode', 'profileCountryCode', 'contactCountryCode']
        .forEach(id => initCountrySelect(id));
}

initCountrySelectors();

// Avatar preview for registration
$('regAvatarPreview').addEventListener('click', () => $('regAvatarFile').click());
$('regAvatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const fd = new FormData(); fd.append('avatar', file);
        const data = await apiFetch('/api/upload-avatar', { method: 'POST', body: fd });
        regAvatarUrl = data.avatarUrl;
        $('regAvatarPreview').innerHTML = `<img src="${regAvatarUrl}" alt="">`;
    } catch (err) {
        showAuthError('registerError', err.message);
    }
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
        if (res.success) { onAuthSuccess(res); }
        else showAuthError('loginError', res.error);
    });
});
$('loginPassword').addEventListener('keypress', e => { if (e.key === 'Enter') $('loginBtn').click(); });

// ── Register ───────────────────────────────────────────────────
$('registerBtn').addEventListener('click', async () => {
    const pseudo = $('regPseudo').value.trim();
    const countryCode = $('regCountryCode').value;
    const phoneNumber = $('regPhoneNumber').value.trim();
    const pw1    = $('regPassword').value;
    const pw2    = $('regPassword2').value;
    if (!pseudo || !pw1 || !phoneNumber) return showAuthError('registerError', 'Remplissez tous les champs');
    if (pw1 !== pw2)     return showAuthError('registerError', 'Mots de passe différents');
    if (pw1.length < 4)  return showAuthError('registerError', 'Mot de passe trop court (min 4 caractères)');
    $('registerBtn').classList.add('loading');
    socket.emit('auth', { pseudo, countryCode, phoneNumber, password: pw1, isRegister: true, avatar: regAvatarUrl }, (res) => {
        $('registerBtn').classList.remove('loading');
        if (res.success) { onAuthSuccess(res); }
        else showAuthError('registerError', res.error);
    });
});

// ── Reset ──────────────────────────────────────────────────────
$('resetBtn').addEventListener('click', () => {
    const pseudo = $('resetPseudo').value.trim();
    const countryCode = $('resetCountryCode').value;
    const phoneNumber = $('resetPhoneNumber').value.trim();
    const newPw  = $('resetNewPw').value;
    if ((!pseudo && !phoneNumber) || !newPw) return showAuthError('resetError', 'Ajoutez un numero ou un pseudo existant');
    socket.emit('reset-password', { pseudo, countryCode, phoneNumber, newPassword: newPw }, (res) => {
        if (res.success) {
            $('resetError').textContent = '';
            $('resetSuccess').textContent = 'Mot de passe modifié ! Connectez-vous.';
            setTimeout(() => showPanel('loginPanel'), 1500);
        } else showAuthError('resetError', res.error);
    });
});

function showAuthError(id, msg) { $(id).textContent = msg; setTimeout(() => $(id).textContent = '', 3500); }
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
    seedKnownPrivateChats();

    updateSidebarUser();
    setupSocketListeners();
    playAuthLaunch().then(() => {
        $('authScreen').style.display = 'none';
        $('mainScreen').style.display = 'flex';
        renderStatusStrip();
        renderUpdateChannelPrompt();
        renderConversations();
        if (currentUser.needsPhoneSetup) {
            showToast('Ajoutez votre numero principal dans le profil pour activer les statuts prives');
        }
    });
}

function updateSidebarUser() {
    $('sidebarUserAvatar').src = currentUser.avatar;
    $('drawerAvatar').src      = currentUser.avatar;
    $('drawerPseudo').textContent = currentUser.pseudo;
}

function formatPhoneNumber(value) {
    if (!value) return 'Non renseigné';
    return value;
}

function renderUpdateChannelPrompt() {
    const prompt = $('updateChannelPrompt');
    if (!updateChannelInfo || updateChannelInfo.joined) {
        prompt.style.display = 'none';
        return;
    }
    prompt.style.display = 'flex';
}

$('joinUpdateChannelBtn').addEventListener('click', () => {
    socket.emit('join-update-channel', (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        if (res.group) upsertGroup(res.group);
        updateChannelInfo = res.updateChannel || updateChannelInfo;
        renderUpdateChannelPrompt();
        renderConversations();
        showToast('Canal de mises a jour rejoint');
    });
});

function playAuthLaunch() {
    const launch = $('authLaunch');
    launch.classList.add('active');
    return new Promise(resolve => {
        setTimeout(() => {
            launch.classList.remove('active');
            resolve();
        }, 1250);
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
    updateSidebarUser();
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
    ownItem.className = 'status-item';
    ownItem.innerHTML = `
        <div class="status-avatar-wrap own">
            <img src="${currentUser.avatar}" alt="">
        </div>
        <div class="status-name">${ownGroup ? 'Mon statut' : 'Ajouter'}</div>
    `;
    ownItem.addEventListener('click', openStatusComposerModal);
    strip.appendChild(ownItem);

    groupedStatuses()
        .filter(group => group.userPseudo !== currentUser.pseudo)
        .forEach(group => {
            const user = allUsers.find(item => item.pseudo === group.userPseudo);
            const allViewed = group.items.every(item => item.viewed);
            const div = document.createElement('div');
            div.className = 'status-item';
            div.innerHTML = `
                <div class="status-avatar-wrap ${allViewed ? 'viewed' : ''}">
                    <img src="${user?.avatar || dicebear(group.userPseudo)}" alt="">
                </div>
                <div class="status-name">${escHtml(group.userPseudo)}</div>
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
    sorted.forEach(entry => {
        const name = entry.type === 'group'
            ? (groups.find(g => g.id === entry.id)?.name || entry.id)
            : entry.id;

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
            <div class="conv-content">
                <div class="conv-top">
                    <span class="conv-name">${escHtml(name)}</span>
                    <span class="conv-time">${lastTime}</span>
                </div>
                <div class="conv-bottom">
                    <span class="conv-last">${isOwn && !unread ? '<i class="fas fa-check-double conv-sent-icon"></i> ' : ''}${escHtml(lastTxt)}</span>
                    ${unread > 0 ? `<span class="conv-badge">${unread}</span>` : ''}
                </div>
            </div>
        `;
        div.addEventListener('click', () => {
            openChat({ type: entry.type, id: entry.id, name, avatar });
        });
        list.appendChild(div);
        displayed++;
    });

    if (displayed === 0) {
        list.innerHTML = `<div class="empty-state"><i class="fas fa-comments"></i><p>Aucune conversation</p><small>Recherchez un utilisateur pour commencer</small></div>`;
    }
}

// ═══════════════════════════════════════════════════════════════
//  OPEN CHAT
// ═══════════════════════════════════════════════════════════════
function openChat(chat) {
    if (chat.type === 'private') registerPrivateChat(chat.id, chat.avatar);
    currentChat = chat;
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
        $('currentChatStatus').textContent = user?.online ? 'En ligne' : lastSeenText(user?.lastSeen);
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
        socket.emit('mark-read', { messageIds: unread });
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
        if (isImg) {
            const img = document.createElement('img');
            img.className = 'msg-img'; img.src = msg.fileUrl; img.alt = 'Image';
            img.addEventListener('click', () => openImageViewer(msg.fileUrl));
            bubble.appendChild(img);
            if (msg.content) bubble.appendChild(document.createTextNode(msg.content));
        } else if (isAudio) {
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = msg.fileUrl;
            bubble.appendChild(audio);
            if (msg.content) bubble.appendChild(document.createTextNode(msg.content));
        } else {
            const fileDiv = document.createElement('div');
            fileDiv.className = 'msg-file';
            fileDiv.innerHTML = `<i class="fas fa-file"></i><a href="${msg.fileUrl}" download="${escHtml(msg.fileName || 'fichier')}">${escHtml(msg.fileName || 'Fichier')}</a>`;
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
    if (isOwn && !msg.deleted) {
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
    showToast('Envoi en cours...');
    let d;
    try {
        const fd = new FormData(); fd.append('file', file);
        d = await apiFetch('/api/upload', { method: 'POST', body: fd });
    } catch (err) {
        showToast(err.message);
        return;
    }
    await sendUploadedMessageFile(d);
    $('fileInput').value = '';
    showToast('Fichier envoyé ✓');
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

$('voiceBtn').addEventListener('click', async () => {
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
        $('voiceBtn').classList.add('recording');
        $('voiceBtn').innerHTML = '<i class="fas fa-stop"></i>';
        $('messageInput').placeholder = 'Enregistrement vocal...';
        updateComposerActionButtons();

        mediaRecorder.addEventListener('dataavailable', (event) => {
            if (event.data?.size) chunks.push(event.data);
        });

        mediaRecorder.addEventListener('stop', async () => {
            isRecording = false;
            $('voiceBtn').classList.remove('recording');
            $('voiceBtn').innerHTML = '<i class="fas fa-microphone"></i>';
            $('messageInput').placeholder = isReadonlyOfficialChannel() ? 'Canal officiel en lecture seule' : 'Message...';
            stopVoiceStream();
            const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
            mediaRecorder = null;
            updateComposerActionButtons();
            if (!blob.size) return;

            try {
                showToast('Envoi de la note vocale...');
                const file = new File([blob], `note-vocale-${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
                const fd = new FormData();
                fd.append('file', file);
                const uploaded = await apiFetch('/api/upload', { method: 'POST', body: fd });
                await sendUploadedMessageFile(uploaded);
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
        $('voiceBtn').classList.remove('recording');
        $('voiceBtn').innerHTML = '<i class="fas fa-microphone"></i>';
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
        socket.emit('search-users', q, (results) => {
            $('searchResultsPanel').style.display  = 'block';
            $('conversationsList').style.display   = 'none';
            const list = $('searchResultsList');
            list.innerHTML = '';
            if (!results.length) {
                list.innerHTML = `<div class="empty-state" style="padding:24px"><i class="fas fa-user-slash"></i><p>Aucun utilisateur trouvé</p></div>`;
                return;
            }
            results.forEach(u => {
                const div = document.createElement('div');
                div.className = 'search-result-item';
                const alreadyInContacts = currentUser?.contacts?.includes(u.phoneNumber);
                div.innerHTML = `
                    <img src="${u.avatar}" class="ri-avatar" alt="">
                    <div class="ri-info">
                        <div class="ri-name">${escHtml(u.pseudo)}</div>
                        <div class="ri-sub">${escHtml(formatPhoneNumber(u.phoneNumber))}</div>
                        <div class="ri-sub">${u.online ? 'En ligne' : lastSeenText(u.lastSeen)}</div>
                    </div>
                    ${u.phoneNumber
                        ? `<button class="btn-secondary search-add-contact-btn" ${alreadyInContacts ? 'disabled' : ''}>${alreadyInContacts ? 'Ajouté' : 'Ajouter'}</button>`
                        : ''
                    }
                `;
                const addBtn = div.querySelector('.search-add-contact-btn');
                if (addBtn && !alreadyInContacts) {
                    addBtn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        addContactByPhone(u.phoneNumber, () => {
                            addBtn.textContent = 'Ajouté';
                            addBtn.disabled = true;
                        });
                    });
                }
                div.addEventListener('click', () => {
                    $('sidebarSearch').value = '';
                    $('searchResultsPanel').style.display = 'none';
                    $('conversationsList').style.display  = 'block';
                    openChat({ type: 'private', id: u.pseudo, name: u.pseudo, avatar: u.avatar });
                });
                list.appendChild(div);
            });
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
    $('drawer').classList.add('open');
    $('drawerOverlay').classList.add('show');
});
$('drawerOverlay').addEventListener('click', closeDrawer);
function closeDrawer() {
    $('drawer').classList.remove('open');
    $('drawerOverlay').classList.remove('show');
}

function openDrawerSection(section) {
    closeDrawer();
    if (section === 'profile') openProfileModal();
    else if (section === 'explore') openExploreModal();
    else if (section === 'newgroup') openModal('newGroupModal');
    else if (section === 'secret') showToast('Choisissez un contact puis "Chat secret"');
}

$('logoutBtn').addEventListener('click', () => {
    authSessionToken = null;
    socket.disconnect();
    location.reload();
});

// ── Header buttons ─────────────────────────────────────────────
$('newChatBtn').addEventListener('click', () => {
    $('sidebarSearch').focus();
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
    closeChatArea();
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
        socket.emit('search-users', q, (results) => {
            const dd = $('memberSearchDropdown');
            dd.innerHTML = '';
            if (!results.length) { dd.style.display = 'none'; return; }
            dd.style.display = 'block';
            results.filter(u => !selectedMembers.find(m => m.pseudo === u.pseudo)).forEach(u => {
                const div = document.createElement('div');
                div.className = 'msd-item';
                div.innerHTML = `<img src="${u.avatar}" alt=""><span>${escHtml(u.pseudo)}</span>`;
                div.addEventListener('click', () => {
                    selectedMembers.push(u);
                    $('memberSearchInput').value = '';
                    dd.style.display = 'none';
                    renderSelectedMembers();
                });
                dd.appendChild(div);
            });
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
        const fd = new FormData();
        fd.append('avatar', file);
        const data = await apiFetch('/api/upload-avatar', { method: 'POST', body: fd });
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
function joinPublicGroup(groupId, name, avatar) {
    socket.emit('join-public-group', { groupId }, (res) => {
        if (res.success) {
            upsertGroup(res.group);
            closeModal('exploreModal');
            openChat({ type: 'group', id: groupId, name, avatar });
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
    const contacts = currentUser?.contacts || [];
    list.innerHTML = '';

    if (!contacts.length) {
        list.innerHTML = '<div class="empty-state" style="height:auto;padding:12px"><small>Aucun contact enregistré pour les statuts.</small></div>';
        return;
    }

    contacts.forEach(phone => {
        const item = document.createElement('div');
        item.className = 'contact-item';
        item.innerHTML = `
            <div>
                <strong>${escHtml(formatPhoneNumber(phone))}</strong>
                <div class="status-meta-sub">Contact autorisé pour les statuts</div>
            </div>
            <button class="btn-secondary" onclick="removeContact('${phone}')">Retirer</button>
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

function openProfileModal() {
    $('profileAvatar').src = currentUser.avatar;
    $('profilePseudo').textContent = currentUser.pseudo;
    $('profileBio').value = currentUser.bio || '';
    $('profileCountryCode').value = currentUser.phoneCountryCode || '+242';
    $('profilePhoneNumber').value = currentUser.phoneLocalNumber || '';
    $('profilePhoneHint').textContent = currentUser.phoneNumber
        ? `Numero actuel: ${formatPhoneNumber(currentUser.phoneNumber)}`
        : 'Ajoutez votre numero pour activer les statuts prives.';
    $('contactCountryCode').value = '+242';
    $('contactPhoneNumber').value = '';
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
$('changeAvatarBtn').addEventListener('click', () => $('profileAvatarFile').click());
$('profileAvatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const fd = new FormData(); fd.append('avatar', file);
        const data = await apiFetch('/api/upload-avatar', { method: 'POST', body: fd });
        $('profileAvatar').src = data.avatarUrl;
        currentUser.avatar = data.avatarUrl;
    } catch (err) {
        showToast(err.message);
    }
});
$('saveProfileBtn').addEventListener('click', () => {
    socket.emit('update-profile', {
        avatar: currentUser.avatar,
        bio: $('profileBio').value,
        countryCode: $('profileCountryCode').value,
        phoneNumber: $('profilePhoneNumber').value.trim()
    }, (res) => {
        if (res.success) {
            currentUser = res.user;
            updateSidebarUser();
            closeModal('profileModal');
            showToast('Profil mis à jour ✓');
        } else showToast(res?.error || 'Erreur');
    });
});

$('addContactBtn').addEventListener('click', () => {
    socket.emit('add-contact', {
        countryCode: $('contactCountryCode').value,
        phoneNumber: $('contactPhoneNumber').value.trim()
    }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        syncCurrentUser(res.user);
        $('contactPhoneNumber').value = '';
        renderContactsList();
        renderStatusStrip();
        showToast('Contact ajouté');
    });
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

// ── Manage Group ───────────────────────────────────────────────
function openManageGroupModal() {
    if (!currentChat || currentChat.type !== 'group') return;
    const group = groups.find(g => g.id === currentChat.id);
    if (!group) return;
    manageGroupAvatarUrl = group.avatar;
    $('manageGroupAvatarPreview').innerHTML = `<img src="${group.avatar}" alt="">`;
    $('manageGroupName').value = group.name || '';
    $('manageGroupDesc').value = group.description || '';
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
        const fd = new FormData();
        fd.append('avatar', file);
        const data = await apiFetch('/api/upload-avatar', { method: 'POST', body: fd });
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
        avatar: manageGroupAvatarUrl
    }, (res) => {
        if (!res?.success) return showToast(res?.error || 'Erreur');
        upsertGroup(res.group);
        currentChat.name = res.group.name;
        currentChat.avatar = res.group.avatar;
        $('currentChatName').textContent = res.group.name;
        $('chatAvatar').src = res.group.avatar;
        renderConversations();
        showToast('Profil du groupe mis à jour');
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
            <div class="rp-info-row"><i class="fas fa-circle" style="color:${user?.online ? 'var(--success)' : 'var(--text3)'}"></i><span>${user?.online ? 'En ligne' : lastSeenText(user?.lastSeen)}</span></div>
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
                <p style="margin-top:6px;font-size:12px;color:var(--text3)">${group?.isPublic ? '🌐 Groupe public' : '🔒 Groupe privé'}</p>
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
        list.innerHTML = '<div class="empty-state"><i class="fas fa-circle-notch"></i><p>Aucun statut actif</p></div>';
        return;
    }

    ownStatuses.forEach(status => {
        const div = document.createElement('div');
        div.className = 'my-status-item';
        const textThumb = `<div class="my-status-thumb status-text-thumb" style="background:${statusBackgroundStyle(status.background)}">${escHtml((status.text || 'Texte').slice(0, 24))}</div>`;
        div.innerHTML = `
            ${status.mediaUrl
                ? (status.fileType?.startsWith('video/')
                    ? `<video src="${status.mediaUrl}" muted></video>`
                    : `<img src="${status.mediaUrl}" alt="">`)
                : textThumb
            }
            <div style="flex:1">
                <div>${escHtml(status.text || 'Statut média')}</div>
                <div class="status-meta-sub">${formatTime(status.createdAt)} · ${status.viewedByCount || 0} vues · Contacts mutuels</div>
            </div>
            <button onclick="deleteStatus('${status.id}')"><i class="fas fa-trash"></i></button>
        `;
        list.appendChild(div);
    });
}

function openStatusComposerModal() {
    $('statusTextInput').value = '';
    statusUpload = null;
    selectedStatusTheme = STATUS_THEMES[0].key;
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

    $('statusViewerTitle').innerHTML = `<i class="fas fa-circle-notch"></i> ${escHtml(status.userPseudo)}`;
    $('statusViewerMeta').innerHTML = `
        <div class="status-meta-title">${escHtml(status.userPseudo)}</div>
        <div class="status-meta-sub">Publié le ${new Date(status.createdAt).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
        <div class="status-meta-sub">Audience: contacts mutuels</div>
        ${status.seenBy?.length ? `<div class="status-meta-sub">Vu par: ${status.seenBy.map(user => escHtml(user.pseudo)).join(', ')}</div>` : ''}
    `;

    const content = $('statusViewerContent');
    if (status.mediaUrl) {
        content.classList.remove('status-text-card');
        content.innerHTML = status.fileType?.startsWith('video/')
            ? `<video src="${status.mediaUrl}" controls autoplay></video>`
            : `<img src="${status.mediaUrl}" alt="">`;
        if (status.text) {
            const text = document.createElement('div');
            text.className = 'status-viewer-text';
            text.style.marginTop = '16px';
            text.textContent = status.text;
            content.appendChild(text);
        }
    } else {
        content.classList.add('status-text-card');
        content.style.background = statusBackgroundStyle(status.background);
        content.innerHTML = `<div class="status-viewer-text">${escHtml(status.text || 'Statut')}</div>`;
    }
    if (status.mediaUrl) content.style.background = '';

    socket.emit('view-status', { statusId: status.id }, (res) => {
        if (res?.success && res.status) {
            upsertStatus(res.status);
            const localIdx = activeStatusGroup.findIndex(item => item.id === res.status.id);
            if (localIdx !== -1) activeStatusGroup[localIdx] = res.status;
            renderStatusStrip();
        }
    });
}

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

$('publishStatusBtn').addEventListener('click', () => {
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

$('prevStatusBtn').addEventListener('click', () => {
    if (!activeStatusGroup.length) return;
    activeStatusIndex = (activeStatusIndex - 1 + activeStatusGroup.length) % activeStatusGroup.length;
    renderActiveStatus();
});

$('nextStatusBtn').addEventListener('click', () => {
    if (!activeStatusGroup.length) return;
    activeStatusIndex = (activeStatusIndex + 1) % activeStatusGroup.length;
    renderActiveStatus();
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
                    socket.emit('mark-read', { messageIds: [msg.id] });
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
            $('currentChatStatus').textContent = u?.online ? 'En ligne' : lastSeenText(u?.lastSeen);
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
}

// ═══════════════════════════════════════════════════════════════
//  MODAL HELPERS
// ═══════════════════════════════════════════════════════════════
function openModal(id) { $(id).classList.add('open'); $(id).style.display = 'flex'; }
function closeModal(id) { $(id).classList.remove('open'); $(id).style.display = 'none'; }

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