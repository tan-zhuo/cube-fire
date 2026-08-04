// lan.js — 无服务器局域网联机层
// 通过 WebRTC DataChannel 直连浏览器：房主页面运行 GameHost（权威游戏逻辑）。
// 建连方式有两种：
//   1. 房间码（默认）：借助 PeerJS 公共信令云自动交换 SDP，访客输入 6 位房间码
//      直接加入；信令只在握手瞬间使用，游戏数据始终 P2P 直连（局域网内不出网）
//   2. 邀请码/应答码（离线后备）：手动复制粘贴信令，完全无需互联网
(function () {
'use strict';

// ---------- 邀请码/应答码编解码（base64(utf8(json))） ----------
function encodeCode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function decodeCode(str) {
    try {
        const bin = atob(str.trim());
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
        return null;
    }
}

// ---------- 传输层：给 game.js 提供与 WebSocket 相同的接口 ----------
function makeTransportShell() {
    return {
        readyState: 1, // WebSocket.OPEN
        binaryType: 'arraybuffer',
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send() {}
    };
}

// 房主本地回环：直接与页面内的 GameHost 互通，零延迟
function createLoopbackTransport() {
    const t = makeTransportShell();
    const conn = window.GameHost.addConnection(data => {
        setTimeout(() => { if (t.onmessage) t.onmessage({ data }); }, 0);
    });
    t.send = data => { setTimeout(() => conn.deliver(data), 0); };
    setTimeout(() => { if (t.onopen) t.onopen(); }, 0);
    return t;
}

// 访客：把已打开的 DataChannel 包装成 WebSocket 风格接口
function createChannelTransport(dc) {
    const t = makeTransportShell();
    dc.binaryType = 'arraybuffer';
    dc.onmessage = e => { if (t.onmessage) t.onmessage({ data: e.data }); };
    dc.onclose = () => {
        t.readyState = 3; // WebSocket.CLOSED
        if (t.onclose) t.onclose();
    };
    dc.onerror = err => { if (t.onerror) t.onerror(err); };
    t.send = data => { if (dc.readyState === 'open') dc.send(data); };
    setTimeout(() => { if (t.onopen) t.onopen(); }, 0);
    return t;
}

// ---------- WebRTC 手动信令 ----------
// 纯局域网直连不需要 STUN/TURN 服务器
function waitIceComplete(pc, timeoutMs = 2500) {
    return new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timer = setTimeout(resolve, timeoutMs);
        pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') {
                clearTimeout(timer);
                resolve();
            }
        });
    });
}

// WebRTC 配置：公网部署（如 Vercel 静态托管）时，跨网络直连需要 STUN
// 获取公网候选地址并写入邀请码/应答码；局域网直连不受影响
const RTC_CONFIG = {
    iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
};

// 房主：生成一份邀请码（每个访客一份）
async function hostCreateInvite() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('game');
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceComplete(pc);
    return { pc, dc, code: encodeCode({ t: 'offer', sdp: pc.localDescription.sdp }) };
}

// 房主：接受访客的应答码，完成连接
async function hostAcceptAnswer(pc, code) {
    const payload = decodeCode(code);
    if (!payload || payload.t !== 'answer' || !payload.sdp) {
        throw new Error('无效的应答码');
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
}

// 访客：粘贴邀请码，生成应答码
async function guestAcceptInvite(code) {
    const payload = decodeCode(code);
    if (!payload || payload.t !== 'offer' || !payload.sdp) {
        throw new Error('无效的邀请码');
    }
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dcPromise = new Promise(resolve => {
        pc.ondatachannel = e => resolve(e.channel);
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIceComplete(pc);
    return { pc, dcPromise, code: encodeCode({ t: 'answer', sdp: pc.localDescription.sdp }) };
}

// 房主：把访客的 DataChannel 接入 GameHost
function attachChannelToHost(dc) {
    dc.binaryType = 'arraybuffer';
    const conn = window.GameHost.addConnection(data => {
        if (dc.readyState === 'open') dc.send(data);
    });
    dc.onmessage = e => conn.deliver(e.data);
    dc.onclose = () => conn.close();
}

// ---------- 房间码信令（PeerJS 公共信令云） ----------
// 房间码只用于握手时定位房主，游戏数据不经过信令服务器
const ROOM_PREFIX = 'cubefire-v1-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去除 0/O/1/I/L 等易混淆字符

function randomRoomCode(len = 6) {
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    let s = '';
    for (let i = 0; i < len; i++) s += CODE_CHARS[arr[i] % CODE_CHARS.length];
    return s;
}

let hostPeer = null;   // 房主的 PeerJS 实例
let guestPeer = null;  // 访客的 PeerJS 实例

// ---------- 房间列表：选举制目录节点 ----------
// 所有页面竞争认领固定的 LOBBY_ID，抢到的浏览器临时兼任"房间目录"：
// 房主向它心跳注册房间信息，访客向它拉取列表。目录页面关闭后 ID 释放，
// 下一个访问者自动当选补位，房主靠周期心跳在新目录上重新注册，几秒内自愈。
const LOBBY_ID = 'cubefire-v1-lobby';
const ROOM_TTL_MS = 25000;      // 超过该时长未心跳的房间从列表剔除
const HEARTBEAT_MS = 8000;      // 房主心跳周期

const Lobby = {
    peer: null,        // 当选目录节点时的 Peer（ID = LOBBY_ID）
    rooms: null,       // 目录节点的房间表 Map<code, room>
    clientPeer: null,  // 非房主页面访问目录用的匿名 Peer
    conn: null,        // 作为客户端与目录的持久连接
    connecting: null,  // 建连中的 Promise（防并发）
    listWaiters: [],   // 等待列表回复的 resolve 队列
};

function lobbyLocalList() {
    const now = Date.now();
    const out = [];
    Lobby.rooms.forEach((r, code) => {
        if (now - r.updatedAt > ROOM_TTL_MS) Lobby.rooms.delete(code);
        else out.push({ code: r.code, hostName: r.hostName, mapName: r.mapName, teamMode: r.teamMode, players: r.players });
    });
    return out.sort((a, b) => b.players - a.players);
}

function lobbyHandleMessage(msg, reply) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'register' && msg.room && typeof msg.room.code === 'string' && msg.room.code.length === 6) {
        Lobby.rooms.set(msg.room.code, {
            code: msg.room.code,
            hostName: String(msg.room.hostName || '无名房主').slice(0, 15),
            mapName: String(msg.room.mapName || '未知地图').slice(0, 20),
            teamMode: !!msg.room.teamMode,
            players: Math.max(0, Math.min(99, msg.room.players | 0)),
            updatedAt: Date.now()
        });
    } else if (msg.t === 'unregister' && typeof msg.code === 'string') {
        Lobby.rooms.delete(msg.code);
    } else if (msg.t === 'list') {
        reply({ t: 'rooms', rooms: lobbyLocalList() });
    }
}

// 竞选目录节点；resolve(true) 当选 / resolve(false) 落选
function lobbyTryBecomeDirector() {
    return new Promise(resolve => {
        if (!window.Peer) return resolve(false);
        let settled = false;
        const done = won => { if (!settled) { settled = true; resolve(won); } };
        const peer = new Peer(LOBBY_ID, { debug: 0 });
        peer.on('open', () => {
            Lobby.peer = peer;
            Lobby.rooms = Lobby.rooms || new Map();
            peer.on('connection', conn => {
                conn.on('data', msg => lobbyHandleMessage(msg, d => { if (conn.open) conn.send(d); }));
            });
            peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
            done(true);
        });
        peer.on('error', err => {
            if (Lobby.peer !== peer) {
                try { peer.destroy(); } catch (e) {}
                done(false);
            }
        });
        setTimeout(() => done(Lobby.peer === peer), 8000);
    });
}

// 拿一个可向目录发起连接的 Peer：房主复用游戏房间的 Peer，其他页面用匿名 Peer
function lobbyGetPeer() {
    if (hostPeer && !hostPeer.destroyed && hostPeer.open) return Promise.resolve(hostPeer);
    if (Lobby.clientPeer && !Lobby.clientPeer.destroyed && Lobby.clientPeer.open) {
        return Promise.resolve(Lobby.clientPeer);
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const peer = new Peer({ debug: 0 });
        peer.on('open', () => {
            if (settled) return;
            settled = true;
            Lobby.clientPeer = peer;
            resolve(peer);
        });
        peer.on('error', err => {
            if (!settled) { settled = true; reject(err); }
        });
    });
}

// 与目录建立（或复用）连接；目录不存在时先竞选，落选说明别人刚当选再连一次
function lobbyEnsure() {
    if (Lobby.peer && !Lobby.peer.destroyed) return Promise.resolve('director');
    if (Lobby.conn && Lobby.conn.open) return Promise.resolve('client');
    if (Lobby.connecting) return Lobby.connecting;

    const openConn = peer => new Promise((resolve, reject) => {
        let settled = false;
        const conn = peer.connect(LOBBY_ID, { serialization: 'json' });
        const onPeerError = err => {
            if (!settled && err.type === 'peer-unavailable') {
                settled = true;
                cleanup();
                reject({ noDirectory: true });
            }
        };
        const cleanup = () => {
            clearTimeout(timer);
            if (peer.off) peer.off('error', onPeerError);
        };
        const timer = setTimeout(() => {
            if (!settled) { settled = true; cleanup(); reject(new Error('目录连接超时')); }
        }, 6000);
        peer.on('error', onPeerError);
        conn.on('open', () => {
            if (settled) { try { conn.close(); } catch (e) {} return; }
            settled = true;
            cleanup();
            conn.on('data', d => {
                if (d && d.t === 'rooms') {
                    const waiters = Lobby.listWaiters.splice(0);
                    waiters.forEach(w => w(d.rooms || []));
                }
            });
            conn.on('close', () => { if (Lobby.conn === conn) Lobby.conn = null; });
            conn.on('error', () => { if (Lobby.conn === conn) Lobby.conn = null; });
            Lobby.conn = conn;
            resolve('client');
        });
    });

    Lobby.connecting = (async () => {
        try {
            const peer = await lobbyGetPeer();
            try {
                return await openConn(peer);
            } catch (e) {
                if (!e || !e.noDirectory) throw e;
                if (await lobbyTryBecomeDirector()) return 'director';
                return await openConn(peer); // 竞选落败，连接新目录
            }
        } finally {
            Lobby.connecting = null;
        }
    })();
    return Lobby.connecting;
}

// 房主：注册/心跳房间信息
async function lobbyRegisterRoom(room) {
    const role = await lobbyEnsure();
    if (role === 'director') {
        lobbyHandleMessage({ t: 'register', room }, () => {});
    } else if (Lobby.conn && Lobby.conn.open) {
        Lobby.conn.send({ t: 'register', room });
    }
}

// 访客：拉取房间列表
async function lobbyFetchRooms() {
    const role = await lobbyEnsure();
    if (role === 'director') return lobbyLocalList();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const i = Lobby.listWaiters.indexOf(done);
            if (i >= 0) Lobby.listWaiters.splice(i, 1);
            reject(new Error('获取列表超时'));
        }, 5000);
        const done = rooms => { clearTimeout(timer); resolve(rooms); };
        Lobby.listWaiters.push(done);
        if (Lobby.conn && Lobby.conn.open) Lobby.conn.send({ t: 'list' });
        else { clearTimeout(timer); reject(new Error('目录连接不可用')); }
    });
}

// ---------- 最近加入的房间（localStorage） ----------
const RECENT_KEY = 'cubefire.recentRooms';

function loadRecentRooms() {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT_KEY));
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function saveRecentRoom(code) {
    try {
        const list = loadRecentRooms().filter(r => r && r.code !== code);
        list.unshift({ code, at: Date.now() });
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5)));
    } catch (e) {}
}

// 房主房间信息（注册到房间列表用），startAsHost 时填充
let hostRoomInfo = null;
let heartbeatTimer = null;

// 房主：注册房间码，等待访客直连
// 房间码持久化在 localStorage：同一浏览器每次开房用同一个码，方便朋友"最近的房间"一键重连
const HOST_CODE_KEY = 'cubefire.hostCode';

function hostStartRoomService() {
    const codeEl = $('roomCodeDisplay');
    const statusEl = $('roomServiceStatus');
    if (!window.Peer) {
        codeEl.textContent = '不可用';
        statusEl.textContent = '房间码服务加载失败（可能无网络），请使用下方手动邀请码';
        return;
    }
    let saved = null;
    try { saved = localStorage.getItem(HOST_CODE_KEY); } catch (e) {}
    if (saved && !/^[A-Z2-9]{6}$/.test(saved)) saved = null;

    let attempts = 0;
    const tryStart = () => {
        // 首次尝试复用上次的房间码；被占用（撞码/多开）则换新码
        const code = (attempts === 0 && saved) ? saved : randomRoomCode();
        attempts++;
        const peer = new Peer(ROOM_PREFIX + code, { debug: 0 });
        peer.on('open', () => {
            hostPeer = peer;
            codeEl.textContent = code;
            statusEl.textContent = '把房间码告诉朋友即可加入；游戏数据 P2P 直连';
            try { localStorage.setItem(HOST_CODE_KEY, code); } catch (e) {}
            if (hostRoomInfo) hostRoomInfo.code = code;
            // 公开房间：立即注册并开始心跳（同时驱动目录换代后的重新注册）
            if (hostRoomInfo && hostRoomInfo.isPublic) {
                const beat = () => {
                    lobbyRegisterRoom({
                        code,
                        hostName: hostRoomInfo.hostName,
                        mapName: hostRoomInfo.mapName,
                        teamMode: hostRoomInfo.teamMode,
                        players: window.GameHost.connectionCount
                    }).catch(() => {});
                };
                beat();
                heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
            }
        });
        peer.on('connection', conn => {
            conn.on('open', () => {
                try { if (conn.dataChannel) conn.dataChannel.binaryType = 'arraybuffer'; } catch (e) {}
                const gconn = window.GameHost.addConnection(data => {
                    if (conn.open) conn.send(data);
                });
                conn.on('data', d => gconn.deliver(d));
                conn.on('close', () => { gconn.close(); updateInviteCount(); });
                statusEl.textContent = '新玩家已通过房间码加入';
                updateInviteCount();
            });
        });
        peer.on('disconnected', () => {
            // 与信令云断开只影响新玩家加入，已建立的对局不受影响；尝试重连
            try { peer.reconnect(); } catch (e) {}
        });
        peer.on('error', err => {
            if (err.type === 'unavailable-id' && attempts < 4) {
                try { peer.destroy(); } catch (e) {}
                tryStart(); // 房间码撞车（或本机多开），换一个重试
            } else if (!hostPeer) {
                codeEl.textContent = '不可用';
                statusEl.textContent = '无法连接房间码服务（纯离线局域网？），请使用下方手动邀请码';
            }
        });
    };
    tryStart();
}

// 访客：把 PeerJS DataConnection 包装成 WebSocket 风格接口
function createPeerConnTransport(conn) {
    const t = makeTransportShell();
    try { if (conn.dataChannel) conn.dataChannel.binaryType = 'arraybuffer'; } catch (e) {}
    conn.on('data', d => { if (t.onmessage) t.onmessage({ data: d }); });
    conn.on('close', () => {
        t.readyState = 3;
        if (t.onclose) t.onclose();
    });
    conn.on('error', err => { if (t.onerror) t.onerror(err); });
    t.send = data => { if (conn.open) conn.send(data); };
    setTimeout(() => { if (t.onopen) t.onopen(); }, 0);
    return t;
}

// 访客：凭房间码直接加入
function guestJoinByCode() {
    const statusEl = $('guestStatus');
    if (!requireNickname()) return;
    const code = $('roomCodeInput').value.trim().toUpperCase().replace(/\s/g, '');
    if (code.length !== 6) {
        showError(statusEl, '请输入 6 位房间码');
        return;
    }
    if (!window.Peer) {
        showError(statusEl, '房间码服务加载失败（可能无网络），请使用下方手动邀请码');
        return;
    }
    const btn = $('joinByCodeButton');
    btn.disabled = true;
    statusEl.style.color = '';
    statusEl.textContent = '正在连接房间...';
    let settled = false;
    const fail = msg => {
        if (settled) return;
        settled = true;
        btn.disabled = false;
        showError(statusEl, msg);
        try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
        guestPeer = null;
    };
    const timer = setTimeout(() => fail('连接超时，请核对房间码后重试'), 15000);

    try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
    const peer = new Peer({ debug: 0 });
    guestPeer = peer;
    peer.on('open', () => {
        // raw 序列化：数据原样走 DataChannel，与游戏二进制/JSON 协议完全一致
        const conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: 'raw' });
        conn.on('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            saveRecentRoom(code);
            statusEl.textContent = '连接成功，正在进入游戏...';
            window.createGameTransport = () => createPeerConnTransport(conn);
            window.game.joinGame();
        });
        conn.on('error', () => fail('连接房间失败，请重试'));
    });
    peer.on('error', err => {
        clearTimeout(timer);
        if (err.type === 'peer-unavailable') {
            fail('找不到该房间，请核对房间码（区分是否已过期）');
        } else if (err.type === 'network' || err.type === 'server-error') {
            fail('无法连接房间码服务（纯离线局域网？），请使用下方手动邀请码');
        } else {
            fail('连接失败: ' + (err.type || err.message || '未知错误'));
        }
    });
}

// ---------- 大厅 UI ----------
const $ = id => document.getElementById(id);

let isHost = false;
let pendingInvite = null; // 房主当前待确认的邀请 { pc, dc }
let guestPc = null;       // 访客的 RTCPeerConnection（防止被GC）

function showError(el, msg) {
    el.textContent = msg;
    el.style.color = '#e74c3c';
}

function requireNickname() {
    const nickname = $('nicknameInput').value.trim();
    if (!nickname) {
        alert('请输入昵称！');
        return null;
    }
    return nickname;
}

async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = old; }, 1500);
    } catch (e) {
        // 剪贴板不可用时回退为选中文本
        alert('自动复制失败，请手动全选复制');
    }
}

// --- 房主流程 ---
function startAsHost() {
    const nickname = requireNickname();
    if (!nickname) return;
    isHost = true;
    // 读取大厅选择的地图与对战模式
    const mapSelect = $('mapSelect');
    const teamModeSelect = $('teamModeSelect');
    const visibilitySelect = $('roomVisibilitySelect');
    const teamMode = teamModeSelect ? teamModeSelect.value === 'team' : false;
    hostRoomInfo = {
        hostName: nickname,
        mapName: (mapSelect && mapSelect.selectedOptions[0]) ? mapSelect.selectedOptions[0].textContent : '经典竞技场',
        teamMode,
        isPublic: !visibilitySelect || visibilitySelect.value === 'public'
    };
    window.GameHost.start({
        mapId: mapSelect ? mapSelect.value : undefined,
        teamMode
    });
    window.createGameTransport = createLoopbackTransport;
    window.game.joinGame();
    // 显示游戏内"邀请玩家"按钮，并注册房间码
    $('inviteToggle').classList.remove('hidden');
    hostStartRoomService();
}

async function hostGenerateInvite() {
    const statusEl = $('inviteStatus');
    statusEl.style.color = '';
    statusEl.textContent = '正在生成邀请码...';
    try {
        // 丢弃上一份未完成的邀请
        if (pendingInvite && pendingInvite.dc.readyState !== 'open') {
            try { pendingInvite.pc.close(); } catch (e) {}
        }
        pendingInvite = await hostCreateInvite();
        pendingInvite.dc.onopen = () => {
            attachChannelToHost(pendingInvite.dc);
            pendingInvite = null;
            statusEl.textContent = '新玩家已连接，可继续生成下一份邀请码';
            updateInviteCount();
        };
        $('inviteCodeOutput').value = pendingInvite.code;
        $('inviteExchange').classList.remove('hidden');
        statusEl.textContent = '把邀请码发给对方，等待对方回传应答码';
    } catch (e) {
        showError(statusEl, '生成邀请码失败: ' + e.message);
    }
}

async function hostConfirmAnswer() {
    const statusEl = $('inviteStatus');
    if (!pendingInvite) {
        showError(statusEl, '请先生成邀请码');
        return;
    }
    const code = $('answerCodeInput').value.trim();
    if (!code) {
        showError(statusEl, '请粘贴对方的应答码');
        return;
    }
    try {
        await hostAcceptAnswer(pendingInvite.pc, code);
        statusEl.style.color = '';
        statusEl.textContent = '正在建立连接...';
        $('answerCodeInput').value = '';
    } catch (e) {
        showError(statusEl, '应答码无效或连接失败: ' + e.message);
    }
}

function updateInviteCount() {
    const el = $('inviteCount');
    if (el) el.textContent = `当前在线玩家: ${window.GameHost.connectionCount}`;
}

function refreshBotCount() {
    const el = $('botCountLabel');
    if (el) el.textContent = window.GameHost.botCount;
}

// --- 访客流程 ---
async function guestGenerateAnswer() {
    const statusEl = $('guestStatus');
    if (!requireNickname()) return;
    const code = $('inviteCodeInput').value.trim();
    if (!code) {
        showError(statusEl, '请先粘贴房主的邀请码');
        return;
    }
    statusEl.style.color = '';
    statusEl.textContent = '正在生成应答码...';
    try {
        const result = await guestAcceptInvite(code);
        guestPc = result.pc;
        $('answerCodeOutput').value = result.code;
        $('guestAnswerArea').classList.remove('hidden');
        statusEl.textContent = '把应答码发给房主，等待房主确认...';

        const dc = await result.dcPromise;
        const enterGame = () => {
            statusEl.textContent = '连接成功，正在进入游戏...';
            window.createGameTransport = () => createChannelTransport(dc);
            window.game.joinGame();
        };
        if (dc.readyState === 'open') enterGame();
        else dc.onopen = enterGame;
    } catch (e) {
        showError(statusEl, e.message || '连接失败');
    }
}


// ---------- 访客大厅：房间列表与最近房间 ----------
let roomPollTimer = null;

function renderRecentRooms() {
    const wrap = $('recentRooms');
    if (!wrap) return;
    wrap.innerHTML = '';
    const list = loadRecentRooms();
    if (!list.length) return;
    const label = document.createElement('span');
    label.className = 'recent-label';
    label.textContent = '最近:';
    wrap.appendChild(label);
    list.slice(0, 3).forEach(r => {
        const chip = document.createElement('button');
        chip.className = 'recent-chip';
        chip.type = 'button';
        chip.textContent = r.code;
        chip.title = '加入房间 ' + r.code;
        chip.addEventListener('click', () => {
            $('roomCodeInput').value = r.code;
            guestJoinByCode();
        });
        wrap.appendChild(chip);
    });
}

function renderRoomList(rooms) {
    const listEl = $('roomList');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!rooms || !rooms.length) {
        const empty = document.createElement('div');
        empty.className = 'room-list-empty';
        empty.textContent = '暂无公开房间 — 可以直接输入房间码加入';
        listEl.appendChild(empty);
        return;
    }
    rooms.forEach(r => {
        const row = document.createElement('button');
        row.className = 'room-item';
        row.type = 'button';
        const host = document.createElement('span');
        host.className = 'room-host';
        host.textContent = r.hostName;
        const meta = document.createElement('span');
        meta.className = 'room-meta';
        meta.textContent = `${r.mapName} · ${r.teamMode ? '红蓝对抗' : '个人混战'} · ${r.players}人`;
        const go = document.createElement('span');
        go.className = 'room-go';
        go.textContent = '加入 →';
        row.append(host, meta, go);
        row.addEventListener('click', () => {
            $('roomCodeInput').value = r.code;
            guestJoinByCode();
        });
        listEl.appendChild(row);
    });
}

function refreshRoomList() {
    const listEl = $('roomList');
    if (!listEl || !window.Peer) {
        if (listEl) renderRoomListError('房间列表服务不可用（可能无网络）');
        return;
    }
    lobbyFetchRooms()
        .then(rooms => {
            // 面板已经关闭就不再渲染
            if (!$('guestPanel').classList.contains('hidden')) renderRoomList(rooms);
        })
        .catch(() => renderRoomListError('获取房间列表失败，稍后自动重试'));
}

function renderRoomListError(msg) {
    const listEl = $('roomList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'room-list-empty';
    empty.textContent = msg;
    listEl.appendChild(empty);
}

function startRoomPolling() {
    stopRoomPolling();
    refreshRoomList();
    roomPollTimer = setInterval(() => {
        // 进入游戏或返回模式选择后停止轮询
        const modal = $('loginModal');
        if (modal.classList.contains('hidden') || $('guestPanel').classList.contains('hidden')) {
            stopRoomPolling();
            return;
        }
        refreshRoomList();
    }, 6000);
}

function stopRoomPolling() {
    if (roomPollTimer) {
        clearInterval(roomPollTimer);
        roomPollTimer = null;
    }
}

// ---------- 首页 2.5D 动态战斗背景 ----------
function startLandingFx() {
    const cv = document.getElementById('landingFx');
    const modal = document.getElementById('loginModal');
    if (!cv || !modal) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = cv.getContext('2d');
    const fit = () => { cv.width = window.innerWidth; cv.height = window.innerHeight; };
    fit();
    window.addEventListener('resize', fit);

    const EX = 13;  // 挤出高度
    const S = 46;   // 方块边长
    // 掩体布局（相对坐标）
    const blocks = [
        [0.07, 0.68], [0.14, 0.68], [0.14, 0.56], [0.27, 0.24],
        [0.68, 0.20], [0.76, 0.20], [0.62, 0.76], [0.87, 0.58],
        [0.44, 0.85], [0.21, 0.40], [0.55, 0.10], [0.91, 0.34]
    ];
    // 两名交火的立方战士
    const fighters = [
        { cx: 0.22, cy: 0.42, r1: 0.05, r2: 0.09, sp: 0.00045, ph: 0, color: '#e74c3c', flashAt: -1e9, x: 0, y: 0 },
        { cx: 0.76, cy: 0.62, r1: 0.06, r2: 0.08, sp: 0.00058, ph: 2.2, color: '#38bdf8', flashAt: -1e9, x: 0, y: 0 }
    ];
    const bullets = [];
    let nextShot = 0;
    let turn = 0;
    let lastT = 0;

    function drawBlock(px, py) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
        ctx.fillRect(px + 5, py + S - 2, S, 7);
        ctx.fillStyle = '#151f38';
        ctx.fillRect(px, py + S - EX, S, EX);
        ctx.fillStyle = '#26365a';
        ctx.fillRect(px, py - EX, S, S);
        ctx.strokeStyle = '#3b5382';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py - EX + 0.5, S - 1, S - 1);
    }

    function drawFighter(f, t, aimAngle) {
        const size = 22;
        // 脚影
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.beginPath();
        ctx.ellipse(f.x, f.y + size * 0.62, size * 0.6, size * 0.26, 0, 0, Math.PI * 2);
        ctx.fill();
        // 身体
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(aimAngle);
        const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
        g.addColorStop(0, '#ffffff55');
        g.addColorStop(1, '#00000044');
        ctx.fillStyle = f.color;
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.fillStyle = g;
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(-size / 2, -size / 2, size, size);
        ctx.fillStyle = '#e8edf5';
        ctx.fillRect(size / 2 - 2, -2.5, 10, 5);
        // 枪口闪光
        if (t - f.flashAt < 90) {
            const fg = ctx.createRadialGradient(size / 2 + 10, 0, 1, size / 2 + 10, 0, 16);
            fg.addColorStop(0, 'rgba(255, 224, 130, 0.9)');
            fg.addColorStop(1, 'rgba(255, 224, 130, 0)');
            ctx.fillStyle = fg;
            ctx.beginPath();
            ctx.arc(size / 2 + 10, 0, 16, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function frame(t) {
        if (modal.classList.contains('hidden')) return; // 进入游戏后停止
        const dt = Math.min(50, t - lastT || 16);
        lastT = t;
        const W = cv.width, H = cv.height;
        ctx.clearRect(0, 0, W, H);

        blocks.forEach(b => drawBlock(b[0] * W, b[1] * H));

        // 战士游走（双椭圆轨道叠加，像在掩体间穿梭）
        fighters.forEach(f => {
            f.x = (f.cx + Math.cos(t * f.sp + f.ph) * f.r1 + Math.cos(t * f.sp * 1.7) * 0.015) * W;
            f.y = (f.cy + Math.sin(t * f.sp * 1.3 + f.ph) * f.r2) * H;
        });
        const [a, b] = fighters;
        const angAB = Math.atan2(b.y - a.y, b.x - a.x);
        drawFighter(a, t, angAB);
        drawFighter(b, t, angAB + Math.PI);

        // 轮流开火
        if (t >= nextShot) {
            nextShot = t + 500 + Math.random() * 700;
            const from = fighters[turn % 2];
            const to = fighters[(turn + 1) % 2];
            turn++;
            const ang = Math.atan2(to.y - from.y, to.x - from.x) + (Math.random() - 0.5) * 0.12;
            from.flashAt = t;
            bullets.push({
                x: from.x + Math.cos(ang) * 20,
                y: from.y + Math.sin(ang) * 20,
                vx: Math.cos(ang) * 0.62,
                vy: Math.sin(ang) * 0.62,
                life: 900
            });
        }

        // 曳光弹
        for (let i = bullets.length - 1; i >= 0; i--) {
            const bl = bullets[i];
            bl.x += bl.vx * dt;
            bl.y += bl.vy * dt;
            bl.life -= dt;
            if (bl.life <= 0 || bl.x < -50 || bl.x > W + 50 || bl.y < -50 || bl.y > H + 50) {
                bullets.splice(i, 1);
                continue;
            }
            const tail = 26;
            const grad = ctx.createLinearGradient(bl.x - bl.vx * tail, bl.y - bl.vy * tail, bl.x, bl.y);
            grad.addColorStop(0, 'rgba(255, 196, 87, 0)');
            grad.addColorStop(1, 'rgba(255, 224, 130, 0.95)');
            ctx.strokeStyle = grad;
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(bl.x - bl.vx * tail, bl.y - bl.vy * tail);
            ctx.lineTo(bl.x, bl.y);
            ctx.stroke();
        }

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}

// ---------- 事件绑定 ----------
document.addEventListener('DOMContentLoaded', () => {
    startLandingFx();

    // 填充地图下拉（地图定义在 host-core.js，保持单一来源）
    const mapSelect = $('mapSelect');
    if (mapSelect && window.GameHost && window.GameHost.getMaps) {
        window.GameHost.getMaps().forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            mapSelect.appendChild(opt);
        });
    }

    // 模式选择
    $('createRoomButton').addEventListener('click', startAsHost);
    $('joinRoomButton').addEventListener('click', () => {
        $('modeButtons').classList.add('hidden');
        $('hostOptions').classList.add('hidden'); // 地图/模式是房主设置，访客用不到
        $('guestPanel').classList.remove('hidden');
        renderRecentRooms();
        startRoomPolling();
    });
    $('guestBackButton').addEventListener('click', () => {
        stopRoomPolling();
        $('guestPanel').classList.add('hidden');
        $('hostOptions').classList.remove('hidden');
        $('modeButtons').classList.remove('hidden');
    });
    $('refreshRoomsButton').addEventListener('click', () => {
        renderRoomListError('正在刷新...');
        refreshRoomList();
    });

    // 访客：房间码直接加入
    $('joinByCodeButton').addEventListener('click', guestJoinByCode);
    $('roomCodeInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') guestJoinByCode();
    });
    $('roomCodeInput').addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    $('manualJoinToggle').addEventListener('click', () =>
        $('manualJoinArea').classList.toggle('hidden'));

    // 访客：手动邀请码（离线后备）
    $('genAnswerButton').addEventListener('click', guestGenerateAnswer);
    $('copyAnswerButton').addEventListener('click', () =>
        copyText($('answerCodeOutput').value, $('copyAnswerButton')));

    // 房主对战设置面板
    $('inviteToggle').addEventListener('click', () => {
        $('invitePanel').classList.toggle('hidden');
        updateInviteCount();
        refreshBotCount();
    });
    $('botPlus').addEventListener('click', () => {
        window.GameHost.addBot();
        refreshBotCount();
    });
    $('botMinus').addEventListener('click', () => {
        window.GameHost.removeBot();
        refreshBotCount();
    });
    $('copyRoomCodeButton').addEventListener('click', () =>
        copyText($('roomCodeDisplay').textContent.trim(), $('copyRoomCodeButton')));
    $('manualInviteToggle').addEventListener('click', () =>
        $('manualInviteArea').classList.toggle('hidden'));
    $('genInviteButton').addEventListener('click', hostGenerateInvite);
    $('copyInviteButton').addEventListener('click', () =>
        copyText($('inviteCodeOutput').value, $('copyInviteButton')));
    $('confirmAnswerButton').addEventListener('click', hostConfirmAnswer);
    $('closeInviteButton').addEventListener('click', () =>
        $('invitePanel').classList.add('hidden'));

    // 聊天室折叠/展开
    const chatHeader = document.querySelector('#chatroom .chat-header');
    if (chatHeader) {
        chatHeader.addEventListener('click', () => {
            document.getElementById('chatroom').classList.toggle('collapsed');
        });
    }

    // 页面关闭时尽力清理：释放目录节点 ID（加速换代）、注销公开房间
    window.addEventListener('beforeunload', () => {
        try {
            if (hostRoomInfo && hostRoomInfo.isPublic && hostRoomInfo.code &&
                Lobby.conn && Lobby.conn.open) {
                Lobby.conn.send({ t: 'unregister', code: hostRoomInfo.code });
            }
        } catch (e) {}
        try { if (Lobby.peer) Lobby.peer.destroy(); } catch (e) {}
    });

    // "连接服务器"模式只在由游戏服务器（server.js，端口38080）提供页面时可用；
    // file:// 直开或静态托管（如 Vercel）没有可连的 WebSocket 服务器，隐藏该入口
    if (window.location.port !== '38080') {
        $('joinButton').classList.add('hidden');
        const hint = $('serverModeHint');
        if (hint) hint.classList.add('hidden');
    }
});
})();
