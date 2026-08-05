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
function waitIceComplete(pc, timeoutMs = 4000) {
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
// 谷歌 STUN 在部分网络（尤其国内）不可达且静默失败；混合多家提高候选收集成功率。
// 同局域网若路由器禁 mDNS 多播，浏览器的 .local 本地候选无法互相解析，
// 此时必须依赖 STUN 反射候选 + NAT 回环才能连通——这是"同一WiFi却加不进去"的主因
// TURN 中继兜底：AP 隔离（商场/公司/访客 WiFi 禁止设备互连）时 P2P 完全不通，
// 只能经公网中继转发。浏览器候选优先级 host > srflx > relay，直连可用时不会走中继。
// 用的是 metered.ca 公开演示中继，属尽力而为；可用 localStorage('cubefire-ice')
// 注入自建 ICE 服务器列表（JSON 数组）覆盖，'cubefire-force-relay'='1' 强制走中继（诊断用）
let ICE_SERVERS = [
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
        urls: ['turn:a.relay.metered.ca:80', 'turn:a.relay.metered.ca:443', 'turns:a.relay.metered.ca:443?transport=tcp'],
        username: 'e8dd65b92c62d3e36cafb807',
        credential: 'uWdWNmkhvyqTEswO'
    }
];
let FORCE_RELAY = false;
try {
    const customIce = JSON.parse(localStorage.getItem('cubefire-ice') || 'null');
    if (Array.isArray(customIce) && customIce.length) ICE_SERVERS = customIce;
    FORCE_RELAY = localStorage.getItem('cubefire-force-relay') === '1';
} catch (e) {}
const RTC_CONFIG = Object.assign(
    { iceServers: ICE_SERVERS },
    FORCE_RELAY ? { iceTransportPolicy: 'relay' } : {}
);
// PeerJS 实例统一配置（信令走 PeerJS 云，ICE 用上面的 STUN+TURN 组合）
const PEER_OPTS = { debug: 0, config: Object.assign(
    { iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 },
    FORCE_RELAY ? { iceTransportPolicy: 'relay' } : {}
) };

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
        throw new Error(I18N.t('lb.invalidAnswer'));
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
}

// 访客：粘贴邀请码，生成应答码
async function guestAcceptInvite(code) {
    const payload = decodeCode(code);
    if (!payload || payload.t !== 'offer' || !payload.sdp) {
        throw new Error(I18N.t('lb.invalidInvite'));
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

// 构建标记：连接自检中显示，便于确认双方设备是否都在最新版本（排除缓存旧版）
const CF_BUILD = '2026-08-05.2';

// ---------- 连接自检：逐环节检测信令云 / STUN / TURN，定位加入失败原因 ----------
async function runConnectivityTest() {
    const el = $('connTestResult');
    if (!el) return;
    el.classList.remove('hidden');
    const btn = $('connTestButton');
    if (btn) btn.disabled = true;
    const mark = ok => ok ? '[OK] ' : '[X] ';
    el.textContent = I18N.t('diag.testing');

    // 1. 信令云（房间码/房间列表全靠它）
    const signalOk = await new Promise(resolve => {
        let p = null;
        const timer = setTimeout(() => { try { if (p) p.destroy(); } catch (e) {} resolve(false); }, 8000);
        try {
            p = new Peer(PEER_OPTS);
            p.on('open', () => { clearTimeout(timer); try { p.destroy(); } catch (e) {} resolve(true); });
            p.on('error', () => { clearTimeout(timer); try { p.destroy(); } catch (e) {} resolve(false); });
        } catch (e) { clearTimeout(timer); resolve(false); }
    });

    // 2/3. 一次 ICE 收集，统计 STUN 反射候选与 TURN 中继候选
    const cand = await new Promise(resolve => {
        let srflx = 0, relay = 0;
        try {
            const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
            pc.createDataChannel('t');
            const finish = () => { try { pc.close(); } catch (e) {} resolve({ srflx, relay }); };
            const timer = setTimeout(finish, 8000);
            pc.onicecandidate = e => {
                if (!e.candidate) { clearTimeout(timer); finish(); return; }
                if (e.candidate.type === 'srflx') srflx++;
                if (e.candidate.type === 'relay') relay++;
            };
            pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); finish(); });
        } catch (e) { resolve({ srflx: 0, relay: 0 }); }
    });

    const lines = [
        mark(signalOk) + I18N.t('diag.signal'),
        mark(cand.srflx > 0) + I18N.t('diag.stun'),
        mark(cand.relay > 0) + I18N.t('diag.turn'),
    ];
    if (!signalOk) lines.push(I18N.t('diag.hintSignal'));
    else if (!cand.srflx && !cand.relay) lines.push(I18N.t('diag.hintIce'));
    else if (!cand.relay) lines.push(I18N.t('diag.hintNoRelay'));
    else lines.push(I18N.t('diag.hintOk'));
    lines.push(I18N.t('diag.build') + ': ' + CF_BUILD);
    el.textContent = lines.join('\n');
    if (btn) btn.disabled = false;
}

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
        else out.push({ code: r.code, hostName: r.hostName, mapName: r.mapName, mapId: r.mapId, teamMode: r.teamMode, mode: r.mode, players: r.players });
    });
    return out.sort((a, b) => b.players - a.players);
}

function lobbyHandleMessage(msg, reply) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'register' && msg.room && typeof msg.room.code === 'string' && msg.room.code.length === 6) {
        Lobby.rooms.set(msg.room.code, {
            code: msg.room.code,
            hostName: String(msg.room.hostName || '').slice(0, 15),
            mapName: String(msg.room.mapName || '').slice(0, 20),
            mapId: String(msg.room.mapId || '').slice(0, 16),
            teamMode: !!msg.room.teamMode,
            mode: String(msg.room.mode || '').slice(0, 10),
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
        const peer = new Peer(LOBBY_ID, PEER_OPTS);
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
        const peer = new Peer(PEER_OPTS);
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
            if (!settled) { settled = true; cleanup(); reject(new Error(I18N.t('lb.dirTimeout'))); }
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
            reject(new Error(I18N.t('lb.listTimeout')));
        }, 5000);
        const done = rooms => { clearTimeout(timer); resolve(rooms); };
        Lobby.listWaiters.push(done);
        if (Lobby.conn && Lobby.conn.open) Lobby.conn.send({ t: 'list' });
        else { clearTimeout(timer); reject(new Error(I18N.t('lb.dirUnavailable'))); }
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
let hostKeepaliveTimer = null;

// 房主：注册房间码，等待访客直连
// 房间码持久化在 localStorage：同一浏览器每次开房用同一个码，方便朋友"最近的房间"一键重连
const HOST_CODE_KEY = 'cubefire.hostCode';

function hostStartRoomService() {
    const codeEl = $('roomCodeDisplay');
    const statusEl = $('roomServiceStatus');
    if (!window.Peer) {
        codeEl.textContent = I18N.t('lb.unavailable');
        statusEl.textContent = I18N.t('lb.peerLoadFail');
        return;
    }
    let saved = null;
    try { saved = localStorage.getItem(HOST_CODE_KEY); } catch (e) {}
    if (saved && !/^[A-Z2-9]{6}$/.test(saved)) saved = null;

    let attempts = 0;
    let healRetries = 0;
    const tryStart = (preserveCode) => {
        // 首次尝试复用上次的房间码；被占用（撞码/多开）则换新码
        // preserveCode=true 表示信令自愈重建：坚持抢回原码（朋友手里的码不作废）
        const code = ((attempts === 0 || preserveCode) && saved) ? saved : randomRoomCode();
        attempts++;
        const peer = new Peer(ROOM_PREFIX + code, PEER_OPTS);
        peer.on('open', () => {
            hostPeer = peer;
            healRetries = 0;
            window.__cfHostPeer = peer; // 调试/诊断句柄
            codeEl.textContent = code;
            statusEl.textContent = I18N.t('lb.shareCode');
            try { localStorage.setItem(HOST_CODE_KEY, code); } catch (e) {}
            if (hostRoomInfo) hostRoomInfo.code = code;
            // 公开房间：立即注册并开始心跳（同时驱动目录换代后的重新注册）
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            if (hostRoomInfo && hostRoomInfo.isPublic) {
                const beat = () => {
                    lobbyRegisterRoom({
                        code,
                        hostName: hostRoomInfo.hostName,
                        mapName: hostRoomInfo.mapName,
                        mapId: hostRoomInfo.mapId,
                        teamMode: hostRoomInfo.teamMode,
                        mode: hostRoomInfo.mode,
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
                statusEl.textContent = I18N.t('lb.guestJoined');
                updateInviteCount();
            });
        });
        peer.on('disconnected', () => {
            // 与信令云断开只影响新玩家加入，已建立的对局不受影响；尝试重连
            try { peer.reconnect(); } catch (e) {}
        });
        peer.on('error', err => {
            if (err.type === 'unavailable-id') {
                try { peer.destroy(); } catch (e) {}
                if (preserveCode && healRetries < 2) {
                    // 自愈重建撞码：先试着抢回原码（服务器可能残留旧会话）
                    healRetries++;
                    setTimeout(() => tryStart(true), 5000);
                } else if (attempts < 8) {
                    // 原码抢不回（信令云占用释放很慢）或初次开房撞码：
                    // 果断换新码，尽快恢复"可被加入"状态；新码会随心跳更新到房间列表
                    saved = null;
                    tryStart();
                }
            } else if (!hostPeer) {
                codeEl.textContent = I18N.t('lb.unavailable');
                statusEl.textContent = I18N.t('lb.peerConnFail');
            }
        });
    };
    tryStart();

    // 信令保活：PeerJS 掉线会让新玩家凭码加入失败（已建立的对局不受影响）。
    // 每 8s 体检一次：断开先 reconnect；实例被销毁则用原码整体重建
    if (hostKeepaliveTimer) clearInterval(hostKeepaliveTimer);
    hostKeepaliveTimer = setInterval(() => {
        if (!hostPeer) return;
        if (hostPeer.destroyed) {
            try { saved = localStorage.getItem(HOST_CODE_KEY); } catch (e) {}
            hostPeer = null;
            attempts = 0;
            healRetries = 0;
            tryStart(true);
        } else if (hostPeer.disconnected) {
            try { hostPeer.reconnect(); } catch (e) {}
        }
    }, 8000);
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

// 凭房间码建立连接并进入游戏（核心逻辑，供输码加入与快速开战复用）
// cb: { status(msg), fail(msg), success() }
function joinRoomWithCode(code, cb) {
    if (!window.Peer) {
        cb.fail(I18N.t('lb.peerLoadFail'));
        return;
    }
    const MAX_TRIES = 3;
    let settled = false;
    let tries = 0;
    let iceFails = 0; // ICE failed 次数：≥2 说明 P2P 被网络拦截（AP 隔离等）
    const fail = msg => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        cb.fail(msg);
        try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
        guestPeer = null;
    };
    const overallTimer = setTimeout(() => fail(I18N.t('lb.connTimeout')), 30000);
    // 单次失败先重试再报错：信令云抖动/首轮打洞失败很常见，换个实例重连大多能成
    const retryOr = msgFn => {
        if (settled) return;
        try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
        guestPeer = null;
        if (tries < MAX_TRIES) {
            cb.status(I18N.t('lb.retrying', { n: tries }));
            setTimeout(attempt, 400);
        } else {
            fail(msgFn());
        }
    };
    const attempt = () => {
        if (settled) return;
        tries++;
        try { if (guestPeer) guestPeer.destroy(); } catch (e) {}
        const peer = new Peer(PEER_OPTS);
        guestPeer = peer;
        // 单次尝试 9s 上限：信令或打洞卡住时尽快进入下一轮
        const attemptTimer = setTimeout(() => retryOr(() => I18N.t('lb.connTimeout')), 9000);
        peer.on('open', () => {
            // raw 序列化：数据原样走 DataChannel，与游戏二进制/JSON 协议完全一致
            const conn = peer.connect(ROOM_PREFIX + code, { reliable: true, serialization: 'raw' });
            // ICE 失败快速检测：mDNS 被禁/STUN 全挂时 state 会进 failed，立即重试
            const iceWatch = setInterval(() => {
                if (settled || guestPeer !== peer) { clearInterval(iceWatch); return; }
                const pc = conn.peerConnection;
                if (pc && (pc.iceConnectionState === 'failed' || pc.connectionState === 'failed')) {
                    clearInterval(iceWatch);
                    clearTimeout(attemptTimer);
                    iceFails++;
                    retryOr(() => I18N.t(iceFails >= 2 ? 'lb.iceFail' : 'lb.connFail'));
                }
            }, 500);
            conn.on('open', () => {
                if (settled) return;
                settled = true;
                clearInterval(iceWatch);
                clearTimeout(attemptTimer);
                clearTimeout(overallTimer);
                saveRecentRoom(code);
                cb.success();
                window.createGameTransport = () => createPeerConnTransport(conn);
                window.game.joinGame();
            });
            conn.on('error', () => {
                clearInterval(iceWatch);
                clearTimeout(attemptTimer);
                retryOr(() => I18N.t('lb.connFail'));
            });
        });
        peer.on('error', err => {
            if (settled) return;
            clearTimeout(attemptTimer);
            if (err.type === 'peer-unavailable') {
                // 房间确实不存在（码错/已过期），重试无意义直接报错
                fail(I18N.t('lb.roomNotFound'));
            } else if (err.type === 'network' || err.type === 'server-error') {
                retryOr(() => I18N.t('lb.peerConnFail'));
            } else {
                retryOr(() => I18N.t('lb.connFailPrefix') + (err.type || err.message || I18N.t('lb.unknownErr')));
            }
        });
    };
    attempt();
}

// 访客：凭房间码直接加入（输码入口）
function guestJoinByCode() {
    const statusEl = $('guestStatus');
    if (!requireNickname()) return;
    const code = $('roomCodeInput').value.trim().toUpperCase().replace(/\s/g, '');
    if (code.length !== 6) {
        showError(statusEl, I18N.t('lb.need6'));
        return;
    }
    const btn = $('joinByCodeButton');
    btn.disabled = true;
    statusEl.style.color = '';
    statusEl.textContent = I18N.t('lb.connecting');
    joinRoomWithCode(code, {
        status(msg) { statusEl.textContent = msg; },
        fail(msg) { btn.disabled = false; showError(statusEl, msg); },
        success() { statusEl.textContent = I18N.t('lb.connected'); }
    });
}

// 快速开战：自动加入人最多的公开房，没有就开新房带机器人
async function quickPlay() {
    if (!requireNickname()) return;
    const btn = $('quickPlayButton');
    if (btn) btn.disabled = true;
    const done = () => { if (btn) btn.disabled = false; };
    const fallbackHost = () => {
        window.showToast(I18N.t('lb.qpNone'), 'info');
        startAsHost();
        setTimeout(() => {
            for (let i = 0; i < 3; i++) window.GameHost.addBot();
        }, 400);
        done();
    };
    if (!window.Peer) { fallbackHost(); return; }
    window.showToast(I18N.t('lb.qpSearching'), 'info');
    let rooms = [];
    try { rooms = await lobbyFetchRooms(); } catch (e) {}
    rooms = (rooms || []).sort((a, b) => (b.players || 0) - (a.players || 0));
    if (!rooms.length) { fallbackHost(); return; }
    const target = rooms[0];
    joinRoomWithCode(target.code, {
        status() {},
        fail() { window.showToast(I18N.t('lb.qpFail'), 'warn'); fallbackHost(); },
        success() { done(); }
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
        window.showToast(I18N.t('g.needNick'), 'warn');
        $('nicknameInput').focus();
        return null;
    }
    return nickname;
}

async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
        const old = btn.textContent;
        btn.textContent = I18N.t('lb.copied');
        setTimeout(() => { btn.textContent = old; }, 1500);
    } catch (e) {
        // 剪贴板不可用时回退为手动复制
        window.showToast(I18N.t('lb.copyFail'), 'warn');
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
    const modeVal = teamModeSelect ? teamModeSelect.value : 'ffa';
    hostRoomInfo = {
        hostName: nickname,
        mapName: (mapSelect && mapSelect.selectedOptions[0]) ? mapSelect.selectedOptions[0].textContent : I18N.t('map.classic'),
        mapId: mapSelect ? mapSelect.value : 'classic',
        teamMode: modeVal === 'team',
        mode: modeVal,
        isPublic: !visibilitySelect || visibilitySelect.value === 'public'
    };
    window.GameHost.start({
        mapId: mapSelect ? mapSelect.value : undefined,
        teamMode: modeVal === 'team',
        infectMode: modeVal === 'infect'
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
    statusEl.textContent = I18N.t('lb.genInviteBusy');
    try {
        // 丢弃上一份未完成的邀请
        if (pendingInvite && pendingInvite.dc.readyState !== 'open') {
            try { pendingInvite.pc.close(); } catch (e) {}
        }
        pendingInvite = await hostCreateInvite();
        pendingInvite.dc.onopen = () => {
            attachChannelToHost(pendingInvite.dc);
            pendingInvite = null;
            statusEl.textContent = I18N.t('lb.guestConnected');
            updateInviteCount();
        };
        $('inviteCodeOutput').value = pendingInvite.code;
        $('inviteExchange').classList.remove('hidden');
        statusEl.textContent = I18N.t('lb.sendInvite');
    } catch (e) {
        showError(statusEl, I18N.t('lb.genInviteFail') + e.message);
    }
}

async function hostConfirmAnswer() {
    const statusEl = $('inviteStatus');
    if (!pendingInvite) {
        showError(statusEl, I18N.t('lb.genFirst'));
        return;
    }
    const code = $('answerCodeInput').value.trim();
    if (!code) {
        showError(statusEl, I18N.t('lb.pasteAnswer'));
        return;
    }
    try {
        await hostAcceptAnswer(pendingInvite.pc, code);
        statusEl.style.color = '';
        statusEl.textContent = I18N.t('lb.establishing');
        $('answerCodeInput').value = '';
    } catch (e) {
        showError(statusEl, I18N.t('lb.answerInvalid') + e.message);
    }
}

function updateInviteCount() {
    const el = $('inviteCount');
    if (el) el.textContent = I18N.t('lb.online', { n: window.GameHost.connectionCount });
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
        showError(statusEl, I18N.t('lb.pasteInviteFirst'));
        return;
    }
    statusEl.style.color = '';
    statusEl.textContent = I18N.t('lb.genAnswerBusy');
    try {
        const result = await guestAcceptInvite(code);
        guestPc = result.pc;
        $('answerCodeOutput').value = result.code;
        $('guestAnswerArea').classList.remove('hidden');
        statusEl.textContent = I18N.t('lb.sendAnswer');

        const dc = await result.dcPromise;
        const enterGame = () => {
            statusEl.textContent = I18N.t('lb.connected');
            window.createGameTransport = () => createChannelTransport(dc);
            window.game.joinGame();
        };
        if (dc.readyState === 'open') enterGame();
        else dc.onopen = enterGame;
    } catch (e) {
        showError(statusEl, e.message || I18N.t('lb.connFailShort'));
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
    label.textContent = I18N.t('lb.recent');
    wrap.appendChild(label);
    list.slice(0, 3).forEach(r => {
        const chip = document.createElement('button');
        chip.className = 'recent-chip';
        chip.type = 'button';
        chip.textContent = r.code;
        chip.title = I18N.t('lb.joinRoomTitle') + r.code;
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
        empty.textContent = I18N.t('lb.noRooms');
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
        const modeName = ({ team: I18N.t('mode.team'), infect: I18N.t('mode.infect') })[r.mode] || (r.teamMode ? I18N.t('mode.team') : I18N.t('mode.ffa'));
        const mapLabel = r.mapId ? I18N.t('map.' + r.mapId) : (r.mapName || I18N.t('lb.unknownMap'));
        meta.textContent = I18N.t('lb.roomMeta', { map: mapLabel === 'map.' + r.mapId ? r.mapName : mapLabel, mode: modeName, players: r.players });
        const go = document.createElement('span');
        go.className = 'room-go';
        go.textContent = I18N.t('lb.joinArrow');
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
        if (listEl) renderRoomListError(I18N.t('lb.dirDown'));
        return;
    }
    lobbyFetchRooms()
        .then(rooms => {
            // 面板已经关闭就不再渲染
            if (!$('guestPanel').classList.contains('hidden')) renderRoomList(rooms);
        })
        .catch(() => renderRoomListError(I18N.t('lb.listFail')));
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
        // 卡通积木块：圆角 + 粗描边 + 顶缘高光（与游戏内地形一致）
        const R = 6;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
        ctx.beginPath();
        ctx.ellipse(px + S / 2 + 3, py + S + 2, S * 0.55, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#4552a8';
        ctx.beginPath();
        ctx.roundRect(px, py + S - EX - R, S, EX + R, R);
        ctx.fill();
        ctx.fillStyle = '#6b7fdd';
        ctx.beginPath();
        ctx.roundRect(px, py - EX, S, S, R);
        ctx.fill();
        ctx.strokeStyle = '#2b3472';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(px + 1, py - EX + 1, S - 2, S + EX - 2, R);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px + R, py - EX + 2.5);
        ctx.lineTo(px + S - R, py - EX + 2.5);
        ctx.stroke();
    }

    function drawFighter(f, t, aimAngle) {
        const size = 22;
        // 脚影
        ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.beginPath();
        ctx.ellipse(f.x, f.y + size * 0.62, size * 0.6, size * 0.26, 0, 0, Math.PI * 2);
        ctx.fill();
        // 身体（卡通：圆角 + 粗描边 + 大眼睛）
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(aimAngle);
        const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
        g.addColorStop(0, '#ffffff44');
        g.addColorStop(1, '#00000033');
        ctx.fillStyle = f.color;
        ctx.beginPath();
        ctx.roundRect(-size / 2, -size / 2, size, size, 5);
        ctx.fill();
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.roundRect(-size / 2, -size / 2, size, size, 5);
        ctx.fill();
        ctx.strokeStyle = '#232842';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = '#e8edf5';
        ctx.fillRect(size / 2 - 2, -2.5, 10, 5);
        // 眼睛
        const eyeX = size * 0.14, eyeY = size * 0.2, eyeR = size * 0.17;
        for (const sy of [-1, 1]) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#232842';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(eyeX, sy * eyeY, eyeR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#232842';
            ctx.beginPath();
            ctx.arc(eyeX + eyeR * 0.42, sy * eyeY, eyeR * 0.5, 0, Math.PI * 2);
            ctx.fill();
        }
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
            const localized = I18N.t('map.' + m.id);
            opt.textContent = localized === 'map.' + m.id ? m.name : localized;
            mapSelect.appendChild(opt);
        });
    }

    // 模式选择
    $('quickPlayButton').addEventListener('click', quickPlay);
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
    const connTestBtn = $('connTestButton');
    if (connTestBtn) connTestBtn.addEventListener('click', runConnectivityTest);
    $('refreshRoomsButton').addEventListener('click', () => {
        renderRoomListError(I18N.t('lb.refreshing'));
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
