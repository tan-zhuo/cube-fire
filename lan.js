// lan.js — 无服务器局域网联机层
// 通过 WebRTC DataChannel 直连浏览器：房主页面运行 GameHost（权威游戏逻辑），
// 其他玩家用"邀请码/应答码"手动信令建立 P2P 连接，无需任何服务器。
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

// 房主：生成一份邀请码（每个访客一份）
async function hostCreateInvite() {
    const pc = new RTCPeerConnection();
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
    const pc = new RTCPeerConnection();
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
    if (!requireNickname()) return;
    isHost = true;
    window.GameHost.start();
    window.createGameTransport = createLoopbackTransport;
    window.game.joinGame();
    // 显示游戏内"邀请玩家"按钮
    $('inviteToggle').classList.remove('hidden');
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

    // 模式选择
    $('createRoomButton').addEventListener('click', startAsHost);
    $('joinRoomButton').addEventListener('click', () => {
        $('modeButtons').classList.add('hidden');
        $('guestPanel').classList.remove('hidden');
    });
    $('guestBackButton').addEventListener('click', () => {
        $('guestPanel').classList.add('hidden');
        $('modeButtons').classList.remove('hidden');
    });

    // 访客
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

    // file:// 打开时没有可连的 WebSocket 服务器，隐藏"连接服务器"入口
    if (window.location.protocol === 'file:') {
        $('joinButton').classList.add('hidden');
        const hint = $('serverModeHint');
        if (hint) hint.classList.add('hidden');
    }
});
})();
