// ── AMC main.js ──

const SIGNALING_URL = 'https://spending-prospect-amazing-fundamental.trycloudflare.com';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// ── STATE ──
let myUsername = '';
let myTag = '';
let currentRoom = null;
let savedRooms = [];
let friends = [];
let socket = null;
let peers = {};
let localStream = null;
let messageExpiry = 86400;
let roomCryptoKey = null;
let members = [];

// ── SECURITY ──
(function lockConsole() {
  const noop = () => {};
  try {
    window.console.log = noop;
    window.console.warn = noop;
    window.console.error = noop;
    window.console.info = noop;
    window.console.debug = noop;
    window.console.table = noop;
    window.console.dir = noop;
  } catch(e) {}
})();

document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && ['I','J','C','K'].includes(e.key.toUpperCase())) || (e.ctrlKey && e.key === 'U')) {
    e.preventDefault(); e.stopPropagation(); return false;
  }
});

// ── CRYPTO ──
async function deriveKey(roomCode) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(roomCode), { name: 'PBKDF2' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('amc-v1-salt-' + roomCode), iterations: 310000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptMessage(obj) {
  if (!roomCryptoKey) return null;
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, roomCryptoKey, enc.encode(JSON.stringify(obj)));
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0); combined.set(new Uint8Array(encrypted), iv.length);
  return btoa(String.fromCharCode(...combined));
}

async function decryptMessage(b64) {
  if (!roomCryptoKey) return null;
  try {
    const combined = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, roomCryptoKey, data);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch(e) { return null; }
}

// ── UTILS ──
function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'AMC-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] % chars.length)];
  return code;
}

function genTagSuffix() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] % chars.length)];
  return s;
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}

function formatExpiry(deleteAt) {
  const diff = Math.max(0, deleteAt - Date.now());
  if (diff === 0) return 'deleted';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `deletes in ${h}h ${m}m`;
  return `deletes in ${m}m`;
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

function initials(name) { return (name || '?').charAt(0).toUpperCase(); }

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function saveData() {
  try {
    localStorage.setItem('amc_username', myUsername);
    localStorage.setItem('amc_tag', myTag);
    localStorage.setItem('amc_rooms', JSON.stringify(savedRooms));
    localStorage.setItem('amc_friends', JSON.stringify(friends));
  } catch(e) {}
}

function loadData() {
  try {
    myUsername = localStorage.getItem('amc_username') || '';
    myTag = localStorage.getItem('amc_tag') || '';
    const r = localStorage.getItem('amc_rooms');
    if (r) savedRooms = JSON.parse(r);
    const f = localStorage.getItem('amc_friends');
    if (f) friends = JSON.parse(f);
  } catch(e) {}
}

// ── CINEMATIC INTRO ──
function runIntro(onDone) {
  const lines = ['intro-1','intro-2','intro-3','intro-4'];
  let i = 0;
  function showNext() {
    if (i >= lines.length) { onDone(); return; }
    const el = $(lines[i]);
    el.classList.add('intro-anim-in');
    const isLast = i === lines.length - 1;
    setTimeout(() => {
      if (isLast) { onDone(); return; }
      el.classList.remove('intro-anim-in');
      el.classList.add('intro-anim-out');
      setTimeout(() => { el.classList.remove('intro-anim-out'); i++; showNext(); }, 500);
    }, isLast ? 1400 : 1600);
  }
  showNext();
}

// ── ONBOARDING ──
function init() {
  loadData();
  if (myUsername) { goHome(); return; }
  showScreen('screen-intro');
  runIntro(() => {
    showScreen('screen-onboarding');
    setTimeout(() => $('ob-username-input').focus(), 100);
  });
  $('ob-continue-btn').addEventListener('click', submitUsername);
  $('ob-username-input').addEventListener('keydown', e => { if (e.key === 'Enter') submitUsername(); });
}

function submitUsername() {
  const val = $('ob-username-input').value.trim();
  if (!val) { $('ob-error').textContent = 'Please enter a username.'; return; }
  if (val.length < 2) { $('ob-error').textContent = 'At least 2 characters.'; return; }
  if (!/^[a-zA-Z0-9_]+$/.test(val)) { $('ob-error').textContent = 'Letters, numbers and underscores only.'; return; }
  myUsername = val;
  myTag = val + '#' + genTagSuffix();
  saveData();
  goHome();
}

// ── HOME ──
function goHome() {
  showScreen('screen-home');
  $('home-avatar').textContent = initials(myUsername);
  $('home-username-label').textContent = myUsername;
  $('home-tag-label').textContent = myTag;
  renderRoomList();
  renderFriendList();
}

function renderRoomList() {
  const list = $('home-rooms-list');
  if (!savedRooms.length) { list.innerHTML = '<div class="home-list-empty">No rooms yet.</div>'; return; }
  list.innerHTML = savedRooms.map((r, i) => `
    <div class="home-list-item" data-index="${i}">
      <div><div class="home-list-item-name">${escapeHtml(r.name)}</div><div class="home-list-item-sub">${r.code}</div></div>
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </div>
  `).join('');
  list.querySelectorAll('.home-list-item').forEach(el => {
    el.addEventListener('click', () => enterRoom(savedRooms[el.dataset.index]));
  });
}

function renderFriendList() {
  const list = $('home-friends-list');
  if (!friends.length) { list.innerHTML = '<div class="home-list-empty">No friends yet. Add someone with their AMC tag.</div>'; return; }
  list.innerHTML = friends.map((f, i) => `
    <div class="home-list-item" data-index="${i}">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="avatar small">${initials(f.username)}</div>
        <div><div class="home-list-item-name">${escapeHtml(f.username)}</div><div class="home-list-item-sub">${f.tag}</div></div>
      </div>
      <div style="font-size:11px;" class="${f.online ? 'friend-online' : 'friend-offline'}">${f.online ? 'online' : 'offline'}</div>
    </div>
  `).join('');
}

// ── CREATE ROOM ──
$('btn-create-room').addEventListener('click', () => { $('modal-create').classList.remove('hidden'); setTimeout(() => $('create-room-name').focus(), 50); });
$('modal-create-cancel').addEventListener('click', () => $('modal-create').classList.add('hidden'));
$('create-room-ttl').addEventListener('change', () => { $('custom-ttl-wrap').classList.toggle('hidden', $('create-room-ttl').value !== 'custom'); });
$('modal-create-confirm').addEventListener('click', () => {
  const name = $('create-room-name').value.trim();
  if (!name) { $('create-room-name').focus(); return; }
  let ttl = parseInt($('create-room-ttl').value);
  if ($('create-room-ttl').value === 'custom') { ttl = parseInt($('create-room-ttl-custom').value) * 3600; if (!ttl || ttl < 3600) ttl = 3600; }
  const room = { name, code: genCode(), ttl, createdAt: Date.now() };
  savedRooms.push(room); saveData();
  $('modal-create').classList.add('hidden');
  $('create-room-name').value = '';
  enterRoom(room);
});

// ── JOIN ROOM ──
$('btn-join-room').addEventListener('click', () => { $('modal-join').classList.remove('hidden'); setTimeout(() => $('join-room-code').focus(), 50); });
$('modal-join-cancel').addEventListener('click', () => { $('modal-join').classList.add('hidden'); $('join-error').classList.add('hidden'); });
$('modal-join-confirm').addEventListener('click', () => {
  const code = $('join-room-code').value.trim().toUpperCase();
  if (!code.startsWith('AMC-') || code.length < 8) { $('join-error').classList.remove('hidden'); return; }
  const existing = savedRooms.find(r => r.code === code);
  if (existing) { $('modal-join').classList.add('hidden'); enterRoom(existing); return; }
  const room = { name: code, code, ttl: 86400, createdAt: Date.now(), joined: true };
  savedRooms.push(room); saveData();
  $('modal-join').classList.add('hidden');
  $('join-room-code').value = '';
  enterRoom(room);
});

// ── ADD FRIEND ──
$('btn-add-friend').addEventListener('click', () => { $('my-tag-display').textContent = myTag; $('modal-friend').classList.remove('hidden'); setTimeout(() => $('friend-tag-input').focus(), 50); });
$('modal-friend-cancel').addEventListener('click', () => { $('modal-friend').classList.add('hidden'); $('friend-error').classList.add('hidden'); });
$('modal-friend-confirm').addEventListener('click', () => {
  const tag = $('friend-tag-input').value.trim();
  const tagReg = /^[a-zA-Z0-9_]+#[A-Z0-9]{5,6}$/;
  if (!tagReg.test(tag)) { $('friend-error').classList.remove('hidden'); return; }
  if (tag === myTag) { $('friend-error').textContent = "That's your own tag!"; $('friend-error').classList.remove('hidden'); return; }
  if (friends.find(f => f.tag === tag)) { $('friend-error').textContent = 'Already added.'; $('friend-error').classList.remove('hidden'); return; }
  friends.push({ username: tag.split('#')[0], tag, online: false, addedAt: Date.now() });
  saveData();
  $('modal-friend').classList.add('hidden');
  $('friend-tag-input').value = '';
  $('friend-error').classList.add('hidden');
  renderFriendList();
});

// ── ENTER ROOM ──
async function enterRoom(room) {
  currentRoom = room;
  messageExpiry = room.ttl;
  roomCryptoKey = await deriveKey(room.code);
  $('sidebar-room-name').textContent = room.name;
  $('sidebar-room-code').textContent = room.code;
  $('chat-topbar-room').textContent = room.name;
  $('chat-avatar').textContent = initials(myUsername);
  $('chat-username-label').textContent = myUsername;
  const h = room.ttl >= 3600 ? (room.ttl/3600) + 'h' : room.ttl + 's';
  $('chat-topbar-ttl').textContent = `Messages delete after ${h}`;
  $('chat-messages').innerHTML = '';
  addSystemMessage(`You joined ${room.name} · ${room.code}`);
  showScreen('screen-chat');
  connectSocket(room.code);
}

$('btn-leave').addEventListener('click', () => { disconnectSocket(); endCall(); roomCryptoKey = null; goHome(); });

$('btn-copy-code').addEventListener('click', () => {
  if (!currentRoom) return;
  navigator.clipboard.writeText(currentRoom.code).catch(() => {});
  $('btn-copy-code').style.color = 'var(--success)';
  setTimeout(() => $('btn-copy-code').style.color = '', 1500);
});

// ── SOCKET + WEBRTC ──
function connectSocket(roomCode) {
  members = [{ name: myUsername }];
  renderMembers();

  if (typeof io === 'undefined') {
    addSystemMessage('Could not connect to server. Check your connection.');
    return;
  }

  socket = io(SIGNALING_URL, { transports: ['websocket'], reconnection: true });

  socket.on('connect', () => {
    socket.emit('join', { room: roomCode, username: myUsername, tag: myTag });
  });

  socket.on('existing-peers', async (peerList) => {
    for (const peer of peerList) {
      addMember(peer.peerId, peer.username);
      await createPeerConnection(peer.peerId, true);
    }
  });

  socket.on('peer-joined', async ({ peerId, username }) => {
    addSystemMessage(`${username} joined`);
    addMember(peerId, username);
  });

  socket.on('signal', async ({ from, signal }) => {
    if (!peers[from]) await createPeerConnection(from, false);
    const pc = peers[from].pc;
    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, signal: pc.localDescription });
    } else if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(signal)); } catch(e) {}
    }
  });

  socket.on('peer-left', ({ peerId }) => {
    const info = peers[peerId];
    if (info) {
      addSystemMessage(`${info.username || 'Someone'} left`);
      if (info.pc) info.pc.close();
      delete peers[peerId];
    }
    removeMember(peerId);
  });

  socket.on('disconnect', () => addSystemMessage('Disconnected. Reconnecting...'));
  socket.on('connect_error', () => addSystemMessage('Could not reach server. Is it running?'));
}

async function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[peerId] = { pc, username: getMemberUsername(peerId), dataChannel: null };

  if (isInitiator) {
    const dc = pc.createDataChannel('amc', { ordered: true });
    setupDataChannel(dc, peerId);
    peers[peerId].dataChannel = dc;
  } else {
    pc.ondatachannel = (e) => { setupDataChannel(e.channel, peerId); peers[peerId].dataChannel = e.channel; };
  }

  if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (e) => { $('remote-video').srcObject = e.streams[0]; $('remote-audio').srcObject = e.streams[0]; };

  pc.onicecandidate = (e) => { if (e.candidate && socket) socket.emit('signal', { to: peerId, signal: e.candidate }); };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') addSystemMessage(`Connected to ${peers[peerId]?.username || 'peer'}`);
  };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, signal: pc.localDescription });
  }

  return pc;
}

function setupDataChannel(dc, peerId) {
  dc.onmessage = async (e) => {
    const data = await decryptMessage(e.data);
    if (!data) return;
    if (data.type === 'chat') addMessage(data.msg);
  };
}

function disconnectSocket() {
  Object.values(peers).forEach(p => { if (p.pc) p.pc.close(); });
  peers = {}; members = [];
  if (socket) { socket.disconnect(); socket = null; }
}

// ── MEMBERS ──
function addMember(peerId, username) {
  if (!members.find(m => m.peerId === peerId)) { members.push({ peerId, name: username }); renderMembers(); }
}

function removeMember(peerId) {
  members = members.filter(m => m.peerId !== peerId);
  renderMembers();
}

function getMemberUsername(peerId) {
  const m = members.find(m => m.peerId === peerId);
  return m ? m.name : peerId;
}

function renderMembers() {
  $('sidebar-members').innerHTML = members.map(m => `
    <div class="sidebar-member">
      <div class="online-dot"></div>
      <div class="avatar small">${initials(m.name)}</div>
      <span class="sidebar-member-name">${escapeHtml(m.name)}</span>
    </div>
  `).join('');
}

// ── MESSAGES ──
const messages = [];

function addMessage(msg) {
  messages.push(msg);
  renderMessage(msg);
  scheduleDelete(msg);
  const el = $('chat-messages');
  el.scrollTop = el.scrollHeight;
}

function renderMessage(msg) {
  const isSelf = msg.from === myUsername;
  const div = document.createElement('div');
  div.className = `msg ${isSelf ? 'self' : ''}`;
  div.id = `msg-${msg.id}`;
  let content = '';
  if (msg.file) {
    if (msg.file.type && msg.file.type.startsWith('image/')) {
      content = `<div class="msg-bubble"><img src="${msg.file.data}" alt="${escapeHtml(msg.file.name)}" /></div>`;
    } else {
      content = `<div class="msg-file" onclick="downloadFile('${msg.id}')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1V9M4 6L7 9L10 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M2 11H12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        <div><div class="msg-file-name">${escapeHtml(msg.file.name)}</div><div class="msg-file-size">${formatBytes(msg.file.size)}</div></div>
      </div>`;
    }
  } else {
    content = `<div class="msg-bubble">${escapeHtml(msg.text)}</div>`;
  }
  div.innerHTML = `
    <div class="avatar small">${initials(msg.from)}</div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-username">${escapeHtml(msg.from)}</span><span class="msg-time">${formatTime(msg.ts)}</span></div>
      ${content}
      <div class="msg-expiry" id="expiry-${msg.id}">${formatExpiry(msg.deleteAt)}</div>
    </div>`;
  $('chat-messages').appendChild(div);
}

function scheduleDelete(msg) {
  const delay = msg.deleteAt - Date.now();
  if (delay <= 0) { deleteMessage(msg.id); return; }
  setTimeout(() => deleteMessage(msg.id), delay);
  const interval = setInterval(() => {
    const el = $(`expiry-${msg.id}`);
    if (!el) { clearInterval(interval); return; }
    el.textContent = formatExpiry(msg.deleteAt);
  }, 60000);
}

function deleteMessage(id) {
  const el = $(`msg-${id}`);
  if (el) { el.style.opacity = '0.25'; el.style.transition = 'opacity 0.5s'; setTimeout(() => el.remove(), 500); }
  const i = messages.findIndex(m => m.id === id);
  if (i !== -1) messages.splice(i, 1);
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  $('chat-messages').appendChild(div);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

// ── SEND ──
$('chat-send-btn').addEventListener('click', sendMessage);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

async function sendMessage() {
  const text = $('chat-input').value.trim();
  if (!text) return;
  $('chat-input').value = '';
  const msg = { id: Date.now() + Math.random().toString(36).slice(2), from: myUsername, text, ts: Date.now(), deleteAt: Date.now() + (messageExpiry * 1000) };
  addMessage(msg);
  const encrypted = await encryptMessage({ type: 'chat', msg });
  if (encrypted) Object.values(peers).forEach(p => { if (p.dataChannel && p.dataChannel.readyState === 'open') p.dataChannel.send(encrypted); });
}

// ── FILE ATTACH ──
$('file-input').addEventListener('change', e => {
  Array.from(e.target.files).forEach(file => {
    const reader = new FileReader();
    reader.onload = async ev => {
      const msg = { id: Date.now() + Math.random().toString(36).slice(2), from: myUsername, file: { name: file.name, size: file.size, type: file.type, data: ev.target.result }, ts: Date.now(), deleteAt: Date.now() + (messageExpiry * 1000) };
      addMessage(msg);
      const encrypted = await encryptMessage({ type: 'chat', msg });
      if (encrypted) Object.values(peers).forEach(p => { if (p.dataChannel && p.dataChannel.readyState === 'open') p.dataChannel.send(encrypted); });
    };
    reader.readAsDataURL(file);
  });
  e.target.value = '';
});

window.downloadFile = function(id) {
  const msg = messages.find(m => m.id === id);
  if (!msg || !msg.file) return;
  const a = document.createElement('a'); a.href = msg.file.data; a.download = msg.file.name; a.click();
};

// ── VOICE / VIDEO ──
$('btn-voice').addEventListener('click', () => startCall(false));
$('btn-video').addEventListener('click', () => startCall(true));
$('btn-end-call').addEventListener('click', endCall);
$('btn-mute').addEventListener('click', toggleMute);
$('btn-cam-toggle').addEventListener('click', toggleCam);

async function startCall(withVideo) {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
    $('local-video').srcObject = localStream;
    localStream.getTracks().forEach(track => { Object.values(peers).forEach(p => { if (p.pc) p.pc.addTrack(track, localStream); }); });
    $('call-overlay').classList.remove('hidden');
    addSystemMessage(withVideo ? 'Video call started' : 'Voice call started');
  } catch(err) { addSystemMessage('Could not access camera/microphone'); }
}

function endCall() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  $('local-video').srcObject = null; $('remote-video').srcObject = null;
  $('call-overlay').classList.add('hidden');
}

function toggleMute() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  if (t) { t.enabled = !t.enabled; $('btn-mute').textContent = t.enabled ? 'Mute' : 'Unmute'; }
}

function toggleCam() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0];
  if (t) { t.enabled = !t.enabled; $('btn-cam-toggle').textContent = t.enabled ? 'Cam off' : 'Cam on'; }
}

// ── INIT ──
init();