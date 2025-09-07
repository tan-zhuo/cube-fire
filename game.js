// 二进制协议类型常量（客户端/服务端一致）
const MESSAGE_TYPES = {
    // 客户端发送
    JOIN: 1,
    MOVE: 2,
    SHOOT: 3,
    MELEE: 4,
    RESPAWN: 5,
    CHAT: 6,
    PING: 7,
    
    // 服务器发送
    JOINED: 10,
    PLAYER_JOINED: 11,
    PLAYER_LEFT: 12,
    GAME_STATE: 13,
    PLAYER_MOVE: 14,
    PLAYER_HIT: 16,
    BULLET_HIT_WALL: 17,
    PLAYER_RESPAWN: 18,
    GAME_UPDATE: 19,
    INCREMENTAL_UPDATE: 20,
    GAME_END: 21,
    NEW_GAME_START: 22,
    GAME_STARTED: 23,
    MELEE_ATTACK: 24,
    KILL_FEED: 25,
    POWERUP_SPAWNED: 26,
    POWERUP_PICKED_UP: 27,
    CHAT_MESSAGE: 28,
    PONG: 29,
    CONNECTED: 30,
    ERROR: 31
};

// 客户端二进制编码器/解码器
class BinaryEncoder {
    constructor() {
        this.buffer = null;
        this.view = null;
        this.offset = 0;
    }
    init(size = 1024) {
        this.buffer = new ArrayBuffer(size);
        this.view = new DataView(this.buffer);
        this.offset = 0;
        return this;
    }
    writeUint8(value) {
        this.view.setUint8(this.offset, value);
        this.offset += 1;
        return this;
    }
    writeUint16(value) {
        this.view.setUint16(this.offset, value, true);
        this.offset += 2;
        return this;
    }
    writeUint32(value) {
        this.view.setUint32(this.offset, value, true);
        this.offset += 4;
        return this;
    }
    writeFloat32(value) {
        this.view.setFloat32(this.offset, value, true);
        this.offset += 4;
        return this;
    }
    writeString(str) {
        const enc = new TextEncoder();
        const bytes = enc.encode(str);
        this.writeUint16(bytes.length);
        new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
        this.offset += bytes.length;
        return this;
    }
    getBuffer() {
        return this.buffer.slice(0, this.offset);
    }
}

class BinaryDecoder {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.offset = 0;
    }
    readUint8() {
        const v = this.view.getUint8(this.offset);
        this.offset += 1;
        return v;
    }
    readUint16() {
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
    }
    readUint32() {
        const v = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return v;
    }
    readInt16() {
        const v = this.view.getInt16(this.offset, true);
        this.offset += 2;
        return v;
    }
    readFloat32() {
        const v = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return v;
    }
    readString() {
        const len = this.readUint16();
        const bytes = new Uint8Array(this.view.buffer, this.offset, len);
        this.offset += len;
        const dec = new TextDecoder();
        return dec.decode(bytes);
    }
}

// 粒子类
class Particle {
    constructor(x, y, vx, vy, color, life, size = 2) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.color = color;
        this.life = life;
        this.maxLife = life;
        this.size = size;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.life--;
        this.vx *= 0.98; // 阻力
        this.vy *= 0.98;
    }

    draw(ctx) {
        const alpha = this.life / this.maxLife;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    isDead() {
        return this.life <= 0;
    }
}

// 刀挥动效果类
class KnifeSwingEffect {
    constructor(x, y, targetX, targetY, duration = 500) {
        this.x = x;
        this.y = y;
        this.targetX = targetX;
        this.targetY = targetY;
        this.duration = duration;
        this.startTime = Date.now();
        this.angle = Math.atan2(targetY - y, targetX - x);
        this.swingAngle = 0;
        this.maxSwingAngle = Math.PI / 2; // 90度挥动范围
        this.knifeLength = 50; // 刀的长度与攻击范围匹配
    }

    update() {
        const elapsed = Date.now() - this.startTime;
        const progress = Math.min(elapsed / this.duration, 1);
        
        // 挥动动画：从-45度到+45度，使用缓动函数
        const easeProgress = 1 - Math.pow(1 - progress, 3); // 缓出效果
        this.swingAngle = (easeProgress - 0.5) * this.maxSwingAngle * 2;
        
        return progress >= 1;
    }

    draw(ctx) {
        const elapsed = Date.now() - this.startTime;
        const progress = Math.min(elapsed / this.duration, 1);
        const alpha = 1 - progress * 0.7; // 保持一些透明度
        
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle + this.swingAngle);
        
        // 绘制刀身阴影
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(2, 2);
        ctx.lineTo(this.knifeLength + 2, 2);
        ctx.stroke();
        
        // 绘制刀身
        ctx.strokeStyle = '#c0c0c0';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(this.knifeLength, 0);
        ctx.stroke();
        
        // 绘制刀刃（更明显的刀刃效果）
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(8, -3);
        ctx.lineTo(this.knifeLength - 5, -3);
        ctx.moveTo(8, 3);
        ctx.lineTo(this.knifeLength - 5, 3);
        ctx.stroke();
        
        // 绘制刀柄
        ctx.strokeStyle = '#8b4513';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.lineTo(0, 0);
        ctx.stroke();
        
        // 绘制刀柄装饰
        ctx.strokeStyle = '#654321';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-6, -2);
        ctx.lineTo(-2, -2);
        ctx.moveTo(-6, 2);
        ctx.lineTo(-2, 2);
        ctx.stroke();
        
        // 绘制挥动轨迹（与实际攻击范围匹配）
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 3;
        ctx.globalAlpha = alpha * 0.6;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(0, 0, this.knifeLength, -this.maxSwingAngle, this.maxSwingAngle);
        ctx.stroke();
        
        // 绘制挥动轨迹的发光效果
        ctx.strokeStyle = '#ff8888';
        ctx.lineWidth = 1;
        ctx.globalAlpha = alpha * 0.3;
        ctx.beginPath();
        ctx.arc(0, 0, this.knifeLength + 5, -this.maxSwingAngle, this.maxSwingAngle);
        ctx.stroke();
        
        ctx.restore();
    }

    isDead() {
        return Date.now() - this.startTime >= this.duration;
    }
}

// 特效类
class Effect {
    constructor(x, y, type, duration = 1000) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.duration = duration;
        this.startTime = Date.now();
        this.particles = [];
        this.createParticles();
    }

    createParticles() {
        switch (this.type) {
            case 'shoot':
                for (let i = 0; i < 8; i++) {
                    const angle = (Math.PI * 2 * i) / 8;
                    const speed = 2 + Math.random() * 3;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#f39c12', 30, 2
                    ));
                }
                break;
            case 'hit':
                for (let i = 0; i < 12; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 1 + Math.random() * 4;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#e74c3c', 40, 3
                    ));
                }
                break;
            case 'powerup':
                for (let i = 0; i < 15; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 1 + Math.random() * 2;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#9b59b6', 60, 2
                    ));
                }
                break;
            case 'melee':
                // 近战攻击特效 - 扇形冲击波
                for (let i = 0; i < 20; i++) {
                    const angle = (Math.PI * 2 * i) / 20;
                    const speed = 3 + Math.random() * 4;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#e74c3c', 40, 3
                    ));
                }
                // 添加中心爆炸
                for (let i = 0; i < 8; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 1 + Math.random() * 2;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#f39c12', 30, 2
                    ));
                }
                break;
                
            case 'wallHit':
                // 子弹击中墙体的灰色爆炸粒子
                for (let i = 0; i < 10; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 0.5 + Math.random() * 3;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#888888', 30, 1 + Math.random() * 2
                    ));
                }
                // 添加火花效果
                for (let i = 0; i < 5; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 2 + Math.random() * 4;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#ffaa00', 20, 1
                    ));
                }
                break;
        }
    }

    update() {
        this.particles = this.particles.filter(particle => {
            particle.update();
            return !particle.isDead();
        });
    }


    draw(ctx) {
        this.particles.forEach(particle => particle.draw(ctx));
    }

    isDead() {
        return Date.now() - this.startTime > this.duration || this.particles.length === 0;
    }
}

class GameClient {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        
        // 双缓冲系统
        this.backBuffer = document.createElement('canvas');
        this.backBuffer.width = this.canvas.width;
        this.backBuffer.height = this.canvas.height;
        this.backCtx = this.backBuffer.getContext('2d');
        this.ws = null;
        this.playerId = null;
        this.gameConfig = null;
        this.players = new Map();
        this.bullets = [];
        this.powerups = [];
        this.terrain = [];
        this.particles = [];
        this.effects = [];
        this.meleeIndicators = [];
        this.knifeSwingEffects = [];
        this.keys = {};
        this.mouse = { x: 0, y: 0 };
        this.lastUpdate = 0;
        
        // 添加移动数据发送频率限制
        this.lastMoveUpdate = 0;
        this.moveUpdateInterval = 1000 / 60; // 60fps发送频率，与服务器同步
        
        // 添加插值平滑参数
        this.interpolationFactor = 0.1; // 插值系数，用于平滑其他玩家的移动
        this.lastServerTime = 0;
        
        this.setupCanvas();
        this.setupEventListeners();
        this.setupUI();
        
        // 初始化缩放比例
        this.scale = 1;
        this.scaleX = 1;
        this.scaleY = 1;

        // FPS 与网络统计
        const nowPerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        this.frames = 0;
        this.fps = 0;
        this.lastFpsTime = nowPerf;
        this.msgsDownCount = 0; // 每秒收到的消息包数
        this.msgsUpCount = 0;   // 每秒发送的消息包数
        this.downRate = 0;      // 显示值：下行消息包/s
        this.upRate = 0;        // 显示值：上行消息包/s
        this.lastRateTime = nowPerf;
        this.pingMs = null;
        this.networkQuality = 'good';
        this.pingTimer = null;
    }

    setupCanvas() {
        // 使用固定大小，与服务器配置一致
        this.canvas.width = 1200;
        this.canvas.height = 800;
        
        // 更新双缓冲区尺寸
        this.backBuffer.width = this.canvas.width;
        this.backBuffer.height = this.canvas.height;
        
        // 计算缩放比例
        this.updateScale();
        
        // 监听窗口大小变化
        window.addEventListener('resize', () => {
            // 保持固定大小，但可以调整显示比例
            this.canvas.width = 1200;
            this.canvas.height = 800;
            // 更新双缓冲区尺寸
            this.backBuffer.width = this.canvas.width;
            this.backBuffer.height = this.canvas.height;
            this.updateScale();
        });
    }
    
    updateScale() {
        // 计算画布的实际显示尺寸与原始尺寸的比例，考虑设备像素比
        const canvasRect = this.canvas.getBoundingClientRect();
        const devicePixelRatio = window.devicePixelRatio || 1;
        
        // 计算基础缩放比例
        this.scaleX = canvasRect.width / 1200;
        this.scaleY = canvasRect.height / 800;
        this.scale = Math.min(this.scaleX, this.scaleY);
        
        // 不需要再乘以devicePixelRatio，因为getBoundingClientRect已经是CSS像素
        console.log(`屏幕信息: devicePixelRatio=${devicePixelRatio}, scaleX=${this.scaleX.toFixed(3)}, scaleY=${this.scaleY.toFixed(3)}`);
    }

    setupEventListeners() {
        // 键盘事件
        document.addEventListener('keydown', (e) => {
            this.keys[e.key.toLowerCase()] = true;
            
            // 复活键
            if (e.code === 'Space') {
                e.preventDefault();
                this.respawn();
            }
        });

        document.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
        });

        // 鼠标事件
        this.canvas.addEventListener('mousemove', (e) => {
            // 确保缩放比例是最新的
            this.updateScale();
            
            const rect = this.canvas.getBoundingClientRect();
            // 将鼠标坐标转换为游戏世界坐标（1200x800）
            // 使用CSS像素计算，不需要考虑devicePixelRatio
            this.mouse.x = ((e.clientX - rect.left) / rect.width) * 1200;
            this.mouse.y = ((e.clientY - rect.top) / rect.height) * 800;
            
            // 确保坐标在有效范围内
            this.mouse.x = Math.max(0, Math.min(1200, this.mouse.x));
            this.mouse.y = Math.max(0, Math.min(800, this.mouse.y));
        });

        this.canvas.addEventListener('click', (e) => {
            if (this.playerId && this.players.get(this.playerId)?.isAlive) {
                this.shoot();
            }
        });

        // 右键近战攻击
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault(); // 阻止右键菜单
            if (this.playerId && this.players.get(this.playerId)?.isAlive) {
                this.meleeAttack();
            }
        });

        // 登录表单
        document.getElementById('joinButton').addEventListener('click', () => {
            this.joinGame();
        });

        document.getElementById('nicknameInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.joinGame();
            }
        });

        // 聊天发送
        const chatSendBtn = document.getElementById('chatSend');
        if (chatSendBtn) {
            chatSendBtn.addEventListener('click', () => this.sendChatMessage());
        }
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') this.sendChatMessage();
            });
        }
    }

    setupUI() {
        // 隐藏登录界面，显示游戏界面
        this.hideLogin = () => {
            document.getElementById('loginModal').classList.add('hidden');
            document.getElementById('ui').classList.remove('hidden');
            document.getElementById('scoreboard').classList.remove('hidden');
            document.getElementById('instructions').classList.remove('hidden');
            document.getElementById('chatroom').classList.remove('hidden');
            const ns = document.getElementById('networkStatus');
            if (ns) ns.classList.remove('hidden');
        };
    }

    joinGame() {
        const nickname = document.getElementById('nicknameInput').value.trim();
        if (!nickname) {
            alert('请输入昵称！');
            return;
        }

        // 连接WebSocket服务器（自动检测当前主机地址）
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        const port = '38080';
        this.ws = new WebSocket(`${protocol}//${host}:${port}`);
        this.ws.binaryType = 'arraybuffer';

        // 包装send以统计上行消息数
        const _origSend = this.ws.send.bind(this.ws);
        this.ws.send = (data) => { try { this.msgsUpCount++; } catch(e) {} return _origSend(data); };

        this.ws.onopen = () => {
            console.log('连接到服务器');
            // 发送二进制JOIN
            const enc = new BinaryEncoder().init(256);
            enc.writeUint8(MESSAGE_TYPES.JOIN);
            enc.writeString(nickname);
            enc.writeUint32(Date.now() >>> 0);
            this.ws.send(enc.getBuffer());

            // 定时发送ping（JSON），用于测量RTT与网络质量
            if (this.pingTimer) clearInterval(this.pingTimer);
            this.pingTimer = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    const ts = Date.now();
                    this.ws.send(JSON.stringify({ type: 'ping', timestamp: ts }));
                }
            }, 2000);
        };

        this.ws.onmessage = (event) => {
            // 统计下行消息包
            this.msgsDownCount++;
            if (typeof event.data === 'string') {
                try {
                    const message = JSON.parse(event.data);
                    if (message && message.type === 'compressed' && message.data) {
                        // 使用pako解压（服务端使用gzip）
                        try {
                            const binary = atob(message.data);
                            const len = binary.length;
                            const bytes = new Uint8Array(len);
                            for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
                            // 优先使用ungzip，失败时回退inflate
                            let inflated;
                            try {
                                inflated = pako.ungzip(bytes);
                            } catch (gzErr) {
                                inflated = pako.inflate(bytes);
                            }
                            const text = (inflated instanceof Uint8Array)
                                ? new TextDecoder().decode(inflated)
                                : String(inflated);
                            const original = JSON.parse(text);
                            if (original && original.type === 'batch' && Array.isArray(original.messages)) {
                                original.messages.forEach(m => this.handleMessage(m));
                            } else {
                                this.handleMessage(original);
                            }
                        } catch (e) {
                            console.error('解压失败:', e);
                        }
                    } else if (message && message.type === 'batch' && Array.isArray(message.messages)) {
                        message.messages.forEach(m => this.handleMessage(m));
                    } else {
                        this.handleMessage(message);
                    }
                } catch (e) {
                    console.error('JSON消息解析失败:', e);
                }
            } else if (event.data instanceof ArrayBuffer) {
                this.handleBinaryMessage(event.data);
            } else if (event.data && event.data.arrayBuffer) {
                // 兼容Blob
                event.data.arrayBuffer().then(buf => this.handleBinaryMessage(buf));
            }
        };

        this.ws.onclose = () => {
            console.log('与服务器断开连接');
            if (this.pingTimer) clearInterval(this.pingTimer);
            alert('与服务器断开连接，请刷新页面重试');
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket错误:', error);
            alert('连接服务器失败，请确保服务器正在运行');
        };
    }

    sendChatMessage() {
        try {
            const input = document.getElementById('chatInput');
            if (!input) return;
            const text = (input.value || '').trim();
            if (!text) return;
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                alert('尚未连接到服务器，无法发送消息');
                return;
            }
            // 使用JSON发送聊天消息，服务器会广播为二进制或JSON
            this.ws.send(JSON.stringify({ type: 'chatMessage', content: text }));
            input.value = '';
        } catch (e) {
            console.error('发送聊天消息失败:', e);
        }
    }

    addChatMessage(playerName, content) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const msg = document.createElement('div');
        msg.className = 'chat-message';
        const sender = document.createElement('span');
        sender.className = 'sender';
        sender.textContent = playerName || '系统';
        const text = document.createElement('span');
        text.className = 'content';
        text.textContent = content || '';
        msg.appendChild(sender);
        msg.appendChild(document.createTextNode(': '));
        msg.appendChild(text);
        container.appendChild(msg);
        // 滚动到底部
        container.scrollTop = container.scrollHeight;
    }

    handleMessage(message) {
        switch (message.type) {
            // ...

            case 'chatMessage':
                this.addChatMessage(message.playerName, message.content);
                break;

            case 'pong': {
                // 服务器返回pong（JSON），更新RTT与网络质量
                const now = Date.now();
                const sentTs = message.timestamp || now;
                this.pingMs = Math.max(0, now - sentTs);
                this.networkQuality = message.networkQuality || (this.pingMs <= 60 ? 'excellent' : this.pingMs <= 120 ? 'good' : this.pingMs <= 200 ? 'medium' : 'poor');
                break;
            }
        }
    }

    handleBinaryMessage(buffer) {
        try {
            const decoder = new BinaryDecoder(buffer);
            const msgType = decoder.readUint8();
            this._handleBinaryMessageBody(decoder, msgType);
        } catch (e) {
            console.error('解析二进制消息失败:', e);
        }
    }

    _handleBinaryMessageBody(decoder, msgType) {
            if (msgType === MESSAGE_TYPES.JOINED) {
                const playerId = decoder.readUint32();
                const gameConfigJson = decoder.readString();
                try {
                    this.gameConfig = JSON.parse(gameConfigJson);
                } catch (e) {
                    console.error('解析gameConfig失败:', e);
                }
                this.playerId = playerId;
                this.hideLogin();
                this.startGameLoop();
                return;
            }
            // 完整状态（GAME_STATE） 或 全量更新（GAME_UPDATE）
            if (msgType === MESSAGE_TYPES.GAME_STATE || msgType === MESSAGE_TYPES.GAME_UPDATE) {
                const isSnapshot = msgType === MESSAGE_TYPES.GAME_STATE;
                // 玩家
                const playerCount = decoder.readUint16();
                const players = [];
                const nowForBuffs = Date.now();
                const defaultBuffMs = (this.gameConfig && this.gameConfig.POWERUP_DURATION) ? this.gameConfig.POWERUP_DURATION : 15000;
                for (let i = 0; i < playerCount; i++) {
                    const id = decoder.readUint32();
                    let nickname = '';
                    if (isSnapshot) {
                        nickname = decoder.readString();
                    }
                    const x = decoder.readFloat32();
                    const y = decoder.readFloat32();
                    const angle = decoder.readFloat32();
                    const health = decoder.readUint8();
                    const score = decoder.readUint16();
                    const isAlive = decoder.readUint8() === 1;
                    const color = decoder.readString();
                    const shieldActive = decoder.readUint8() === 1;
                    const rapidActive = decoder.readUint8() === 1;
                    const damageActive = decoder.readUint8() === 1;

                    // 若非快照且未提供昵称，则尝试复用已有昵称
                    if (!isSnapshot) {
                        const exist = this.players.get(id);
                        nickname = exist?.nickname || `Player ${id}`;
                    }

                    players.push({
                        id, nickname, x, y, angle, health, score, isAlive, color,
                        powerups: {
                            shield: { active: shieldActive, endTime: shieldActive ? nowForBuffs + defaultBuffMs : 0 },
                            rapidFire: { active: rapidActive, endTime: rapidActive ? nowForBuffs + defaultBuffMs : 0 },
                            damageBoost: { active: damageActive, endTime: damageActive ? nowForBuffs + defaultBuffMs : 0 }
                        }
                    });
                }

                // 子弹
                const bulletCount = decoder.readUint16();
                const bullets = [];
                for (let i = 0; i < bulletCount; i++) {
                    const id = decoder.readString();
                    const x = decoder.readFloat32();
                    const y = decoder.readFloat32();
                    const vx = decoder.readFloat32();
                    const vy = decoder.readFloat32();
                    const ownerId = decoder.readUint32();
                    const damage = decoder.readUint8();
                    bullets.push({ id, x, y, vx, vy, ownerId, damage });
                }

                // 道具
                const powerupCount = decoder.readUint16();
                const powerups = [];
                for (let i = 0; i < powerupCount; i++) {
                    const id = decoder.readUint32();
                    let type, color, icon;
                    if (isSnapshot) {
                        type = decoder.readString();
                    } else {
                        const typeId = decoder.readUint8();
                        type = this.getPowerupTypeById(typeId);
                    }
                    const x = decoder.readFloat32();
                    const y = decoder.readFloat32();
                    if (isSnapshot) {
                        color = decoder.readString();
                        icon = decoder.readString();
                    }
                    powerups.push({ id, type, x, y, color, icon });
                }

                // 地形（仅快照）
                let terrain = this.terrain;
                if (isSnapshot) {
                    const terrainCount = decoder.readUint16();
                    terrain = [];
                    for (let i = 0; i < terrainCount; i++) {
                        const id = decoder.readUint32();
                        const x = decoder.readFloat32();
                        const y = decoder.readFloat32();
                        const width = decoder.readFloat32();
                        const height = decoder.readFloat32();
                        const type = decoder.readString();
                        terrain.push({ id, x, y, width, height, type });
                    }
                }

                // 剩余时间（仅GAME_UPDATE）
                if (!isSnapshot) {
                    const remainingTime = decoder.readUint32();
                    this.updateGameTimer(remainingTime);
                }

                // 应用状态
                if (isSnapshot) {
                    this.players.clear();
                    players.forEach(p => this.players.set(p.id, p));
                    this.updateScoreboard();
                } else {
                    this.updatePlayersFromServer(players);
                }
                this.bullets = bullets;
                // 为道具补充颜色/图标以保持一致视觉
                // 道具统一中性显示（灰色+问号），隐藏具体类型
                this.powerups = powerups.map(p => ({ ...p, color: '#95a5a6', icon: '?' }));
                if (isSnapshot) this.terrain = terrain;
                return;
            }

            // 增量更新（二进制）
            if (msgType === MESSAGE_TYPES.INCREMENTAL_UPDATE) {
                const timestamp = decoder.readUint32();
                const remainingTime = decoder.readUint32();
                const isGameEnded = decoder.readUint8() === 1;
                // section-based TLV until 0xFF
                while (true) {
                    const section = decoder.readUint8();
                    if (section === 0xFF) break;
                    if (section === 0x10) { // newPlayers
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readUint32();
                            const nickname = decoder.readString();
                            const x = decoder.readUint16();
                            const y = decoder.readUint16();
                            const angle100 = decoder.readUint16();
                            const health = decoder.readUint8();
                            const score = decoder.readUint16();
                            const isAlive = decoder.readUint8() === 1;
                            const color = decoder.readString();
                            this.players.set(id, {
                                id,
                                nickname,
                                x,
                                y,
                                angle: angle100 / 100,
                                health,
                                score,
                                isAlive,
                                color,
                                powerups: { shield: {active:false}, rapidFire:{active:false}, damageBoost:{active:false} }
                            });
                        }
                    } else if (section === 0x02) { // changedPlayers
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readUint32();
                            const mask = decoder.readUint8();
                            const p = this.players.get(id) || { id };
                            if (mask & 0x01) p.x = decoder.readUint16();
                            if (mask & 0x02) p.y = decoder.readUint16();
                            if (mask & 0x04) p.angle = decoder.readUint16() / 100;
                            if (mask & 0x08) p.health = decoder.readUint8();
                            if (mask & 0x10) p.score = decoder.readUint16();
                            if (mask & 0x20) p.isAlive = decoder.readUint8() === 1;
                            if (mask & 0x40) {
                                const now = Date.now();
                                p.powerups = p.powerups || { shield:{}, rapidFire:{}, damageBoost:{} };
                                // shield
                                const sActive = decoder.readUint8() === 1;
                                const sRem = decoder.readUint16();
                                p.powerups.shield.active = sActive;
                                p.powerups.shield.endTime = sActive ? now + sRem * 1000 : 0;
                                // rapid
                                const rActive = decoder.readUint8() === 1;
                                const rRem = decoder.readUint16();
                                p.powerups.rapidFire.active = rActive;
                                p.powerups.rapidFire.endTime = rActive ? now + rRem * 1000 : 0;
                                // damage
                                const dActive = decoder.readUint8() === 1;
                                const dRem = decoder.readUint16();
                                p.powerups.damageBoost.active = dActive;
                                p.powerups.damageBoost.endTime = dActive ? now + dRem * 1000 : 0;
                            }
                            this.players.set(id, p);
                        }
                    } else if (section === 0x03) { // newBullets
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readString();
                            const x = decoder.readUint16();
                            const y = decoder.readUint16();
                            const vx = decoder.readInt16() / 100;
                            const vy = decoder.readInt16() / 100;
                            const ownerId = decoder.readUint32();
                            if (!this.bullets.find(b => b.id === id)) {
                                this.bullets.push({ id, x, y, vx, vy, ownerId, damage: 25 });
                            }
                        }
                    } else if (section === 0x13) { // removedBullets
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readString();
                            this.bullets = this.bullets.filter(b => b.id !== id);
                        }
                    } else if (section === 0x04) { // newPowerups
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readUint32();
                            const typeId = decoder.readUint8();
                            const x = decoder.readFloat32();
                            const y = decoder.readFloat32();
                            const type = this.getPowerupTypeById(typeId);
                            if (!this.powerups.find(p => p.id === id)) this.powerups.push({ id, type, x, y });
                        }
                    } else if (section === 0x14) { // removedPowerups
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readUint32();
                            this.powerups = this.powerups.filter(p => p.id !== id);
                        }
                    }
                }
                if (typeof remainingTime === 'number') this.updateGameTimer(remainingTime);
                this.updateScoreboard();
                return;
            }

            // 游戏结束（结果展示）
            if (msgType === MESSAGE_TYPES.GAME_END) {
                const countdown = decoder.readUint8();
                const showingResults = decoder.readUint8() === 1;
                const n = decoder.readUint16();
                const players = [];
                for (let i = 0; i < n; i++) {
                    const id = decoder.readUint32();
                    const nickname = decoder.readString();
                    const score = decoder.readUint16();
                    const isAlive = decoder.readUint8() === 1;
                    const health = decoder.readUint8();
                    players.push({ id, nickname, score, isAlive, health });
                }
                this.showGameEndModal(players);
                this.updateCountdown(countdown, showingResults);
                return;
            }

            // 新游戏开始倒计时
            if (msgType === MESSAGE_TYPES.NEW_GAME_START) {
                const countdown = decoder.readUint8();
                this.updateCountdown(countdown, false);
                return;
            }

            // 游戏正式开始
            if (msgType === MESSAGE_TYPES.GAME_STARTED) {
                this.hideNewGameModal();
                this.hideGameEndModal();
                return;
            }

            // 新玩家加入
            if (msgType === MESSAGE_TYPES.PLAYER_JOINED) {
                const id = decoder.readUint32();
                const nickname = decoder.readString();
                const x = decoder.readUint16();
                const y = decoder.readUint16();
                const angle100 = decoder.readUint16();
                const health = decoder.readUint8();
                const score = decoder.readUint16();
                const isAlive = decoder.readUint8() === 1;
                const color = decoder.readString();
                this.players.set(id, {
                    id,
                    nickname,
                    x,
                    y,
                    angle: angle100 / 100,
                    health,
                    score,
                    isAlive,
                    color,
                    powerups: { shield: {active:false}, rapidFire:{active:false}, damageBoost:{active:false} }
                });
                this.updateScoreboard();
                return;
            }

            // 玩家离开
            if (msgType === MESSAGE_TYPES.PLAYER_LEFT) {
                const id = decoder.readUint32();
                this.players.delete(id);
                this.updateScoreboard();
                return;
            }

            // 聊天消息
            if (msgType === MESSAGE_TYPES.CHAT_MESSAGE) {
                const playerId = decoder.readUint32();
                const playerName = decoder.readString();
                const content = decoder.readString();
                this.addChatMessage(playerName, content);
                return;
            }

            // 玩家受击
            if (msgType === MESSAGE_TYPES.PLAYER_HIT) {
                const targetId = decoder.readUint32();
                const shooterId = decoder.readUint32();
                const damage = decoder.readUint8();
                const isKill = decoder.readUint8() === 1;
                this.showHitEffect(targetId);
                const targetPlayer = this.players.get(targetId);
                if (targetPlayer) {
                    this.effects.push(new Effect(targetPlayer.x + 10, targetPlayer.y + 10, 'hit'));
                }
                return;
            }

            // 子弹击中墙体
            if (msgType === MESSAGE_TYPES.BULLET_HIT_WALL) {
                const x = decoder.readFloat32();
                const y = decoder.readFloat32();
                const bulletId = decoder.readString();
                this.effects.push(new Effect(x, y, 'wallHit'));
                return;
            }

            // 玩家复活
            if (msgType === MESSAGE_TYPES.PLAYER_RESPAWN) {
                const playerId = decoder.readUint32();
                const x = decoder.readFloat32();
                const y = decoder.readFloat32();
                const health = decoder.readUint8();
                const p = this.players.get(playerId);
                if (p) {
                    p.x = x; p.y = y; p.health = health; p.isAlive = true;
                }
                return;
            }

            // 击杀信息
            if (msgType === MESSAGE_TYPES.KILL_FEED) {
                const killer = decoder.readString();
                const victim = decoder.readString();
                const weapon = decoder.readString();
                const timestamp = decoder.readUint32();
                this.updateKillFeed({ killer, victim, weapon, timestamp });
                return;
            }

            // 道具拾取
            if (msgType === MESSAGE_TYPES.POWERUP_PICKED_UP) {
                const powerupId = decoder.readUint32();
                const playerId = decoder.readUint32();
                const typeId = decoder.readUint8();
                const type = this.getPowerupTypeById(typeId);
                this.powerups = this.powerups.filter(p => p.id !== powerupId);
                const pickedUpPlayer = this.players.get(playerId);
                if (pickedUpPlayer) {
                    this.effects.push(new Effect(pickedUpPlayer.x + 10, pickedUpPlayer.y + 10, 'powerup'));
                    // 本地立即设置buff，保证UI立刻显示
                    const now = Date.now();
                    const duration = (this.gameConfig && this.gameConfig.POWERUP_DURATION) || 15000;
                    pickedUpPlayer.powerups = pickedUpPlayer.powerups || { shield:{}, rapidFire:{}, damageBoost:{} };
                    if (type === 'shield') {
                        pickedUpPlayer.powerups.shield.active = true;
                        pickedUpPlayer.powerups.shield.endTime = now + duration;
                    } else if (type === 'rapid_fire' || type === 'rapidFire') {
                        pickedUpPlayer.powerups.rapidFire.active = true;
                        pickedUpPlayer.powerups.rapidFire.endTime = now + duration;
                    } else if (type === 'damage_boost' || type === 'damageBoost') {
                        pickedUpPlayer.powerups.damageBoost.active = true;
                        pickedUpPlayer.powerups.damageBoost.endTime = now + duration;
                    }
                }
                return;
            }

            // 道具生成
            if (msgType === MESSAGE_TYPES.POWERUP_SPAWNED) {
                const id = decoder.readUint32();
                const typeId = decoder.readUint8();
                const x = decoder.readFloat32();
                const y = decoder.readFloat32();
                const type = this.getPowerupTypeById(typeId);
                if (!this.powerups.find(p => p.id === id)) this.powerups.push({ id, type, x, y });
                return;
            }

            // 近战攻击
            if (msgType === MESSAGE_TYPES.MELEE_ATTACK) {
                const attackerId = decoder.readUint32();
                const targetId = decoder.readUint32();
                const targetX = decoder.readFloat32();
                const targetY = decoder.readFloat32();
                const damage = decoder.readUint8();
                const isKill = decoder.readUint8() === 1;
                const x = decoder.readFloat32();
                const y = decoder.readFloat32();
                this.handleMeleeAttack({ attackerId, targetId, targetX, targetY, damage, isKill, x, y });
                return;
            }
    }

    // 将道具类型ID映射为字符串
    getPowerupTypeById(id) {
        switch (id) {
            case 1: return 'shield';
            case 2: return 'rapid_fire';
            case 3: return 'damage_boost';
            case 4: return 'heal';
            default: return 'unknown';
        }
    }

    // 根据道具类型返回颜色与图标，确保视觉一致
    getPowerupVisual(type) {
        switch (type) {
            case 'shield':
                return { color: '#9b59b6', icon: '🛡️' };
            case 'rapid_fire':
            case 'rapidFire':
                return { color: '#e67e22', icon: '⚡' };
            case 'damage_boost':
            case 'damageBoost':
                return { color: '#e74c3c', icon: '🔥' };
            case 'heal':
                return { color: '#2ecc71', icon: '✚' };
            default:
                return { color: '#95a5a6', icon: '?' };
        }
    }

    updatePlayersFromServer(serverPlayers) {
        serverPlayers.forEach(serverPlayer => {
            const localPlayer = this.players.get(serverPlayer.id);
            if (localPlayer) {
                // 同步位置与姿态
                if (typeof serverPlayer.x === 'number') localPlayer.x = serverPlayer.x;
                if (typeof serverPlayer.y === 'number') localPlayer.y = serverPlayer.y;
                if (typeof serverPlayer.angle === 'number') localPlayer.angle = serverPlayer.angle;
                // 其他属性
                localPlayer.score = serverPlayer.score;
                localPlayer.health = serverPlayer.health;
                localPlayer.isAlive = serverPlayer.isAlive;
                // 合并buff状态，避免全量更新时重置计时
                const now = Date.now();
                const defaultBuffMs = (this.gameConfig && this.gameConfig.POWERUP_DURATION) ? this.gameConfig.POWERUP_DURATION : 15000;
                localPlayer.powerups = localPlayer.powerups || { shield:{}, rapidFire:{}, damageBoost:{} };
                const mergeBuff = (key) => {
                    const s = (serverPlayer.powerups && serverPlayer.powerups[key]) || {};
                    const l = localPlayer.powerups[key] || {};
                    if (s.active) {
                        // 若本地已有并未过期，则保留本地endTime；否则使用服务器endTime或默认值
                        if (l.active && l.endTime && l.endTime > now) {
                            // keep local endTime
                        } else if (s.endTime && s.endTime > now) {
                            l.endTime = s.endTime;
                        } else {
                            l.endTime = now + defaultBuffMs;
                        }
                        l.active = true;
                    } else {
                        l.active = false;
                        l.endTime = 0;
                    }
                    localPlayer.powerups[key] = l;
                };
                mergeBuff('shield');
                mergeBuff('rapidFire');
                mergeBuff('damageBoost');
            }
        });
        this.updateScoreboard();
    }

    handleIncrementalUpdate(message) {
        // 处理新玩家
        if (message.newPlayers) {
            message.newPlayers.forEach(player => {
                this.players.set(player.id, player);
            });
        }
        
        // 处理玩家变化
        if (message.changedPlayers) {
            message.changedPlayers.forEach(changes => {
                const player = this.players.get(changes.id);
                if (player) {
                    // 更新变化的属性
                    Object.assign(player, changes);
                }
            });
        }
        
        // 处理新子弹
        if (message.newBullets) {
            message.newBullets.forEach(bullet => {
                // 检查是否已存在此子弹，避免重复添加
                if (!this.bullets.find(b => b.id === bullet.id)) {
                    this.bullets.push(bullet);
                }
            });
        }
        
        // 处理移除的子弹
        if (message.removedBullets) {
            message.removedBullets.forEach(bulletId => {
                this.bullets = this.bullets.filter(b => b.id !== bulletId);
            });
        }
        
        // 处理新道具
        if (message.newPowerups) {
            message.newPowerups.forEach(powerup => {
                if (!this.powerups.find(p => p.id === powerup.id)) {
                    this.powerups.push(powerup);
                }
            });
        }
        
        // 处理移除的道具
        if (message.removedPowerups) {
            message.removedPowerups.forEach(powerupId => {
                this.powerups = this.powerups.filter(p => p.id !== powerupId);
            });
        }
        
        // 更新游戏计时器
        if (message.remainingTime !== undefined) {
            this.updateGameTimer(message.remainingTime);
        }
        
        // 更新倒计时
        if (message.countdown !== undefined) {
            this.updateCountdown(message.countdown, message.showingResults);
        }
        
        // 更新排行榜
        this.updateScoreboard();
    }

    updateScoreboard() {
        const playersList = document.getElementById('playersList');
        playersList.innerHTML = '';
        
        const sortedPlayers = Array.from(this.players.values())
            .sort((a, b) => b.score - a.score);
        
        sortedPlayers.forEach(player => {
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player-score';
            if (player.id === this.playerId) {
                playerDiv.classList.add('current-player');
            }
            
            playerDiv.innerHTML = `
                <span>${player.nickname}</span>
                <span>${player.score}</span>
            `;
            playersList.appendChild(playerDiv);
        });
    }

    updateGameTimer(remainingTime) {
        const timerElement = document.getElementById('timerValue');
        if (timerElement) {
            const seconds = Math.ceil(remainingTime / 1000);
            timerElement.textContent = `${seconds}s`;
            
            // 时间不足30秒时变红色
            if (seconds <= 30) {
                timerElement.style.color = '#e74c3c';
            } else {
                timerElement.style.color = '#3498db';
            }
        }
    }

    updateKillFeed(killInfo) {
        const killFeedContainer = document.getElementById('killFeed');
        if (!killFeedContainer || !killInfo) return;

        // 检查是否已经显示过这个击杀信息（避免重复显示）
        const existingNotifications = killFeedContainer.querySelectorAll('.kill-notification');
        for (let notification of existingNotifications) {
            if (notification.dataset.killId === killInfo.timestamp.toString()) {
                return; // 已经显示过这个击杀信息
            }
        }

        // 创建击杀通知
        const killNotification = document.createElement('div');
        killNotification.className = 'kill-notification';
        killNotification.dataset.killId = killInfo.timestamp.toString();
        
        // 根据武器类型选择图标和颜色
        const weaponIcon = killInfo.weapon === '近战' ? '⚔️' : '🔫';
        const weaponColor = killInfo.weapon === '近战' ? '#e74c3c' : '#f39c12';
        
        killNotification.innerHTML = `
            <span class="kill-icon">${weaponIcon}</span>
            <span class="killer">${killInfo.killer}</span>
            <span class="weapon" style="color: ${weaponColor}">${killInfo.weapon}</span>
            <span class="victim">${killInfo.victim}</span>
        `;

        // 设置边框颜色
        killNotification.style.borderLeftColor = weaponColor;

        // 添加到容器
        killFeedContainer.appendChild(killNotification);

        // 强制重排以确保动画正确触发
        killNotification.offsetHeight;

        // 触发动画
        requestAnimationFrame(() => {
            killNotification.classList.add('show');
        });

        // 4秒后移除
        setTimeout(() => {
            if (killNotification.parentNode) {
                killNotification.classList.remove('show');
                setTimeout(() => {
                    if (killNotification.parentNode) {
                        killNotification.parentNode.removeChild(killNotification);
                    }
                }, 300); // 等待淡出动画完成
            }
        }, 4000);

        // 限制同时显示的击杀信息数量
        const notifications = killFeedContainer.querySelectorAll('.kill-notification');
        if (notifications.length > 4) {
            const oldestNotification = notifications[0];
            oldestNotification.classList.remove('show');
            setTimeout(() => {
                if (oldestNotification.parentNode) {
                    oldestNotification.parentNode.removeChild(oldestNotification);
                }
            }, 300);
        }
    }

    showGameEndModal(players, killFeed) {
        const modal = document.getElementById('gameEndModal');
        const finalScores = document.getElementById('finalScores');
        const countdownValue = document.getElementById('countdownValue');
        
        if (!modal || !finalScores || !countdownValue) return;

        // 显示最终排行榜
        finalScores.innerHTML = '';
        const sortedPlayers = players.sort((a, b) => b.score - a.score);
        
        sortedPlayers.forEach((player, index) => {
            const scoreItem = document.createElement('div');
            scoreItem.className = 'score-item';
            scoreItem.innerHTML = `
                <span>${index + 1}. ${player.nickname}</span>
                <span>${player.score} 分</span>
            `;
            finalScores.appendChild(scoreItem);
        });

        // 显示击杀信息
        this.updateKillFeed(killFeed);

        // 显示模态框
        modal.classList.remove('hidden');
    }

    hideGameEndModal() {
        const modal = document.getElementById('gameEndModal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    showNewGameModal(players, terrain, countdown) {
        const modal = document.getElementById('newGameModal');
        const countdownValue = document.getElementById('newGameCountdownValue');
        
        if (!modal || !countdownValue) return;

        // 显示新游戏弹窗
        modal.classList.remove('hidden');
        
        // 更新倒计时显示
        this.updateNewGameCountdown(countdown);
        
        // 更新地形
        this.terrain = terrain || [];
    }

    hideNewGameModal() {
        const modal = document.getElementById('newGameModal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    updateNewGameCountdown(countdown) {
        const countdownValue = document.getElementById('newGameCountdownValue');
        if (countdownValue) {
            countdownValue.textContent = countdown;
        }
    }

    updateCountdown(countdown, showingResults) {
        const countdownValue = document.getElementById('countdownValue');
        const newGameCountdownValue = document.getElementById('newGameCountdownValue');
        const gameEndModal = document.getElementById('gameEndModal');
        const newGameModal = document.getElementById('newGameModal');
        
        if (showingResults) {
            // 显示游戏结束蒙版，隐藏新游戏蒙版
            if (gameEndModal) {
                gameEndModal.classList.remove('hidden');
            }
            if (newGameModal) {
                newGameModal.classList.add('hidden');
            }
            
            // 更新游戏结束蒙版的倒计时
            if (countdownValue) {
                countdownValue.textContent = countdown;
            }
        } else {
            // 隐藏游戏结束蒙版，显示新游戏蒙版
            if (gameEndModal) {
                gameEndModal.classList.add('hidden');
            }
            if (newGameModal) {
                newGameModal.classList.remove('hidden');
            }
            
            // 更新新游戏蒙版的倒计时
            if (newGameCountdownValue) {
                newGameCountdownValue.textContent = countdown;
            }
        }
        
        // 注意：不在这里隐藏蒙版，让蒙版显示完整的倒计时
        // 蒙版会在 gameStarted 消息中隐藏
    }

    handleMeleeAttack(message) {
        const attacker = this.players.get(message.attackerId);
        if (!attacker) return;

        // 添加刀挥动效果
        this.knifeSwingEffects.push(new KnifeSwingEffect(
            attacker.x, attacker.y, 
            message.targetX, message.targetY
        ));

        // 如果击中了目标，添加额外特效
        if (message.targetId && message.isKill) {
            const target = this.players.get(message.targetId);
            if (target) {
                // 添加击杀特效
                this.effects.push(new Effect(target.x, target.y, 'hit'));
            }
        }

        // 显示近战攻击范围指示器
        this.showMeleeRangeIndicator(message.x, message.y);
    }

    showMeleeRangeIndicator(x, y) {
        // 创建近战攻击范围指示器
        const indicator = {
            x: x,
            y: y,
            radius: 30, // 近战攻击范围
            life: 30, // 显示30帧
            maxLife: 30
        };
        
        this.meleeIndicators = this.meleeIndicators || [];
        this.meleeIndicators.push(indicator);
    }

    drawMeleeIndicators() {
        this.meleeIndicators.forEach(indicator => {
            const alpha = indicator.life / indicator.maxLife;
            
            // 绘制近战攻击范围圆圈
            this.backCtx.save();
            this.backCtx.globalAlpha = alpha * 0.3;
            this.backCtx.strokeStyle = '#e74c3c';
            this.backCtx.lineWidth = 2;
            this.backCtx.beginPath();
            this.backCtx.arc(indicator.x, indicator.y, indicator.radius, 0, Math.PI * 2);
            this.backCtx.stroke();
            
            // 绘制内部填充
            this.backCtx.globalAlpha = alpha * 0.1;
            this.backCtx.fillStyle = '#e74c3c';
            this.backCtx.fill();
            
            // 绘制中心点
            this.backCtx.globalAlpha = alpha;
            this.backCtx.fillStyle = '#e74c3c';
            this.backCtx.beginPath();
            this.backCtx.arc(indicator.x, indicator.y, 3, 0, Math.PI * 2);
            this.backCtx.fill();
            
            this.backCtx.restore();
        });
    }

    drawPowerup(powerup) {
        if (!powerup) return;
        const size = this.gameConfig ? this.gameConfig.POWERUP_SIZE : 15;
        const x = powerup.x, y = powerup.y;
        const vis = this.getPowerupVisual(powerup.type || 'unknown');
        const color = powerup.color || vis.color;
        const icon = powerup.icon || vis.icon;

        this.backCtx.save();
        // 发光背景
        const glow = this.backCtx.createRadialGradient(
            x + size / 2, y + size / 2, size * 0.2,
            x + size / 2, y + size / 2, size
        );
        glow.addColorStop(0, color + '88');
        glow.addColorStop(1, color + '00');
        this.backCtx.fillStyle = glow;
        this.backCtx.beginPath();
        this.backCtx.arc(x + size / 2, y + size / 2, size * 0.8, 0, Math.PI * 2);
        this.backCtx.fill();

        // 核心实体
        this.backCtx.fillStyle = color;
        this.backCtx.strokeStyle = '#ffffff55';
        this.backCtx.lineWidth = 2;
        this.backCtx.beginPath();
        this.backCtx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
        this.backCtx.fill();
        this.backCtx.stroke();

        // 图标
        this.backCtx.fillStyle = '#ffffff';
        this.backCtx.font = `${Math.round(size * 0.8)}px Arial`;
        this.backCtx.textAlign = 'center';
        this.backCtx.textBaseline = 'middle';
        this.backCtx.fillText(icon, x + size / 2, y + size / 2 + 1);

        this.backCtx.restore();
    }

    startGameLoop() {
        let lastFrameTime = 0;
        const targetFrameTime = 1000 / 60; // 60fps
        
        const gameLoop = (timestamp) => {
            const deltaTime = timestamp - lastFrameTime;
            
            // 限制最大帧率，确保所有设备的游戏逻辑保持一致
            if (deltaTime >= targetFrameTime) {
                this.update(timestamp);
                this.render();
                lastFrameTime = timestamp;

                // 统计FPS与上下行速率
                const nowPerf = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                this.frames++;
                if (nowPerf - this.lastFpsTime >= 1000) {
                    const fpsInterval = nowPerf - this.lastFpsTime;
                    this.fps = Math.round(this.frames * 1000 / fpsInterval);
                    this.frames = 0;
                    this.lastFpsTime = nowPerf;

                    const rateIntervalSec = Math.max(0.001, (nowPerf - this.lastRateTime) / 1000);
                    this.downRate = Math.round(this.msgsDownCount / rateIntervalSec);
                    this.upRate = Math.round(this.msgsUpCount / rateIntervalSec);
                    this.msgsDownCount = 0;
                    this.msgsUpCount = 0;
                    this.lastRateTime = nowPerf;
                }
            }
            
            requestAnimationFrame(gameLoop);
        };
        requestAnimationFrame(gameLoop);
    }

    update(timestamp) {
        if (!this.playerId || !this.gameConfig) return;
        
        const deltaTime = timestamp - this.lastUpdate;
        this.lastUpdate = timestamp;
        
        // 更新玩家移动
        this.updatePlayerMovement();
        
        // 更新子弹
        this.bullets = this.bullets.filter(bullet => {
            bullet.x += bullet.vx;
            bullet.y += bullet.vy;
            
            // 检查子弹是否超出边界
            return bullet.x > 0 && bullet.x < this.canvas.width &&
                   bullet.y > 0 && bullet.y < this.canvas.height;
        });
        
        // 更新特效
        this.effects = this.effects.filter(effect => {
            effect.update();
            return !effect.isDead();
        });

        // 更新近战攻击指示器
        this.meleeIndicators = this.meleeIndicators.filter(indicator => {
            indicator.life--;
            return indicator.life > 0;
        });

        // 更新刀挥动效果
        this.knifeSwingEffects = this.knifeSwingEffects.filter(effect => {
            effect.update();
            return !effect.isDead();
        });
        
        // 更新UI
        this.updateUI();
    }

    updatePlayerMovement() {
        if (!this.playerId || !this.gameConfig || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        
        const player = this.players.get(this.playerId);
        if (!player || !player.isAlive) return;
        
        const currentTime = Date.now();
        
        let dx = 0, dy = 0;
        // 使用固定的移动速度，不受屏幕尺寸影响
        const speed = this.gameConfig.PLAYER_SPEED || 5;
        
        if (this.keys['w'] || this.keys['arrowup']) dy -= speed;
        if (this.keys['s'] || this.keys['arrowdown']) dy += speed;
        if (this.keys['a'] || this.keys['arrowleft']) dx -= speed;
        if (this.keys['d'] || this.keys['arrowright']) dx += speed;
        
        // 计算角度（无论是否移动都要更新）
        const playerSize = this.gameConfig.PLAYER_SIZE || 20;
        const angle = Math.atan2(this.mouse.y - (player.y + playerSize / 2), 
                               this.mouse.x - (player.x + playerSize / 2));
        
        // 只更新角度，不更新位置（等待服务器确认）
        player.angle = angle;
        
        // 检查是否需要发送数据到服务器（频率限制）
        if (currentTime - this.lastMoveUpdate >= this.moveUpdateInterval) {
            // 检查是否有实际变化
            const hasPositionChange = (dx !== 0 || dy !== 0);
            const hasAngleChange = Math.abs(angle - (player.lastServerAngle || 0)) > 0.02; // 更小的角度变化阈值
            
            if (hasPositionChange || hasAngleChange) {
                // 计算新位置但不立即应用
                const newX = Math.max(0, Math.min(this.canvas.width - playerSize, player.x + dx));
                const newY = Math.max(0, Math.min(this.canvas.height - playerSize, player.y + dy));
                
                // 发送二进制MOVE
                const enc = new BinaryEncoder().init(32);
                enc.writeUint8(MESSAGE_TYPES.MOVE);
                enc.writeFloat32(newX);
                enc.writeFloat32(newY);
                enc.writeFloat32(angle);
                this.ws.send(enc.getBuffer());
                
                // 记录发送时间和角度
                this.lastMoveUpdate = currentTime;
                player.lastServerAngle = angle;
            }
        }
    }

    shoot() {
        if (!this.playerId) {
            console.log('射击失败: 没有玩家ID');
            return;
        }
        
        const player = this.players.get(this.playerId);
        if (!player || !player.isAlive) {
            console.log('射击失败: 玩家不存在或已死亡');
            return;
        }
        
        
        // 添加射击特效
        this.effects.push(new Effect(player.x + 10, player.y + 10, 'shoot'));
        
        const enc = new BinaryEncoder().init(24);
        enc.writeUint8(MESSAGE_TYPES.SHOOT);
        enc.writeFloat32(this.mouse.x);
        enc.writeFloat32(this.mouse.y);
        this.ws.send(enc.getBuffer());
    }

    meleeAttack() {
        if (!this.playerId) {
            console.log('近战攻击失败: 没有玩家ID');
            return;
        }
        
        const player = this.players.get(this.playerId);
        if (!player || !player.isAlive) {
            console.log('近战攻击失败: 玩家不存在或已死亡');
            return;
        }
        
        // 近战攻击特效将在服务器响应后通过handleMeleeAttack处理
        
        const enc = new BinaryEncoder().init(24);
        enc.writeUint8(MESSAGE_TYPES.MELEE);
        enc.writeFloat32(this.mouse.x);
        enc.writeFloat32(this.mouse.y);
        this.ws.send(enc.getBuffer());
    }

    respawn() {
        if (!this.playerId) return;
        
        const enc = new BinaryEncoder().init(8);
        enc.writeUint8(MESSAGE_TYPES.RESPAWN);
        this.ws.send(enc.getBuffer());
    }

    updateUI() {
        if (!this.playerId) return;
        
        const player = this.players.get(this.playerId);
        if (player) {
            const health = Math.max(0, player.health);
            const healthPercent = (health / 100) * 100;
            
            // 更新血条显示
            document.getElementById('health').textContent = health;
            const healthFill = document.getElementById('healthFill');
            if (healthFill) {
                healthFill.style.width = healthPercent + '%';
                
                // 根据血量改变血条颜色
                if (healthPercent > 60) {
                    healthFill.style.background = 'linear-gradient(90deg, #27ae60, #2ecc71, #27ae60)';
                } else if (healthPercent > 30) {
                    healthFill.style.background = 'linear-gradient(90deg, #f39c12, #e67e22, #f39c12)';
                } else {
                    healthFill.style.background = 'linear-gradient(90deg, #e74c3c, #c0392b, #e74c3c)';
                }
            }
            
            // 更新分数显示
            document.getElementById('score').textContent = player.score;
        }

        // 更新网络状态与FPS
        const fpsEl = document.getElementById('fpsDisplay');
        if (fpsEl) {
            fpsEl.textContent = `FPS: ${this.fps || '--'}`;
        }
        const rateEl = document.getElementById('rateDisplay');
        if (rateEl) {
            rateEl.textContent = `⬇︎ ${this.downRate || 0} pkt/s | ⬆︎ ${this.upRate || 0} pkt/s`;
        }
        const pingEl = document.getElementById('pingDisplay');
        const qualityEl = document.getElementById('networkQuality');
        if (pingEl) {
            // 设置颜色级别
            let cls = 'ping-display ';
            let text = (this.pingMs != null) ? `${this.pingMs}ms` : '--';
            let level = 'good';
            if (this.pingMs != null) {
                if (this.pingMs <= 60) level = 'excellent';
                else if (this.pingMs <= 120) level = 'good';
                else if (this.pingMs <= 200) level = 'medium';
                else level = 'poor';
            }
            pingEl.className = cls + level;
            pingEl.textContent = text;
        }
        if (qualityEl) {
            const q = (this.networkQuality || '').toLowerCase();
            let text = '良好';
            let cls = 'network-quality ';
            if (q === 'excellent') { text = '优秀'; cls += 'quality-excellent'; }
            else if (q === 'good') { text = '良好'; cls += 'quality-good'; }
            else if (q === 'medium') { text = '一般'; cls += 'quality-medium'; }
            else if (q === 'poor') { text = '较差'; cls += 'quality-poor'; }
            else { cls += 'quality-good'; }
            qualityEl.className = cls;
            qualityEl.textContent = text;
        }
    }

    showHitEffect(targetId) {
        // 简单的击中效果
        const player = this.players.get(targetId);
        if (player) {
            // 可以在这里添加击中特效
        }
    }

    render() {
        // 清空后台缓冲区
        this.backCtx.fillStyle = '#2c3e50';
        this.backCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 绘制网格背景
        this.drawGrid();
        
        // 绘制地形
        this.drawTerrain();
        
        // 绘制玩家
        this.players.forEach(player => {
            this.drawPlayer(player);
        });
        
        // 绘制子弹
        this.bullets.forEach(bullet => {
            this.drawBullet(bullet);
        });
        
        // 绘制道具
        this.powerups.forEach(powerup => {
            this.drawPowerup(powerup);
        });
        
        // 绘制特效
        this.effects.forEach(effect => {
            effect.draw(this.backCtx);
        });

        // 绘制近战攻击指示器
        this.drawMeleeIndicators();

        // 绘制刀挥动效果
        this.knifeSwingEffects.forEach(effect => {
            effect.draw(this.backCtx);
        });
        
        // 将后台缓冲区复制到前台画布 - 双缓冲交换
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.backBuffer, 0, 0);
    }

    drawGrid() {
        this.backCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        this.backCtx.lineWidth = 1;
        
        const gridSize = 50;
        for (let x = 0; x < this.canvas.width; x += gridSize) {
            this.backCtx.beginPath();
            this.backCtx.moveTo(x, 0);
            this.backCtx.lineTo(x, this.canvas.height);
            this.backCtx.stroke();
        }
        
        for (let y = 0; y < this.canvas.height; y += gridSize) {
            this.backCtx.beginPath();
            this.backCtx.moveTo(0, y);
            this.backCtx.lineTo(this.canvas.width, y);
            this.backCtx.stroke();
        }
    }

    drawTerrain() {
        this.terrain.forEach(block => {
            this.backCtx.save();
            
            // 根据类型设置不同的颜色和样式
            switch (block.type) {
                case 'wall':
                    this.backCtx.fillStyle = '#34495e';
                    this.backCtx.strokeStyle = '#2c3e50';
                    break;
                case 'rock':
                    this.backCtx.fillStyle = '#7f8c8d';
                    this.backCtx.strokeStyle = '#5d6d7e';
                    break;
                case 'crate':
                    this.backCtx.fillStyle = '#8b4513';
                    this.backCtx.strokeStyle = '#654321';
                    break;
                case 'barrel':
                    this.backCtx.fillStyle = '#2c3e50';
                    this.backCtx.strokeStyle = '#1a252f';
                    break;
                default:
                    this.backCtx.fillStyle = '#34495e';
                    this.backCtx.strokeStyle = '#2c3e50';
            }
            
            // 绘制地形块
            this.backCtx.fillRect(block.x, block.y, block.width, block.height);
            
            // 绘制边框
            this.backCtx.lineWidth = 2;
            this.backCtx.strokeRect(block.x, block.y, block.width, block.height);
            
            // 添加纹理效果
            this.backCtx.fillStyle = 'rgba(0, 0, 0, 0.2)';
            for (let i = 0; i < 3; i++) {
                const x = block.x + Math.random() * block.width;
                const y = block.y + Math.random() * block.height;
                this.backCtx.fillRect(x, y, 2, 2);
            }
            
            // 为特定类型添加特殊效果
            if (block.type === 'crate') {
                // 木箱纹理
                this.backCtx.strokeStyle = '#654321';
                this.backCtx.lineWidth = 1;
                this.backCtx.beginPath();
                this.backCtx.moveTo(block.x + block.width/2, block.y);
                this.backCtx.lineTo(block.x + block.width/2, block.y + block.height);
                this.backCtx.moveTo(block.x, block.y + block.height/2);
                this.backCtx.lineTo(block.x + block.width, block.y + block.height/2);
                this.backCtx.stroke();
            } else if (block.type === 'barrel') {
                // 桶的金属环
                this.backCtx.strokeStyle = '#95a5a6';
                this.backCtx.lineWidth = 2;
                this.backCtx.beginPath();
                this.backCtx.arc(block.x + block.width/2, block.y + block.height/2, block.width/3, 0, Math.PI * 2);
                this.backCtx.stroke();
            }
            
            this.backCtx.restore();
        });
    }

    drawPlayer(player) {
        const size = this.gameConfig ? this.gameConfig.PLAYER_SIZE : 20;
        
        this.backCtx.save();
        this.backCtx.translate(player.x + size / 2, player.y + size / 2);
        this.backCtx.rotate(player.angle);
        
        // 玩家身体
        if (player.isAlive) {
            this.backCtx.fillStyle = player.color || '#3498db';
        } else {
            this.backCtx.fillStyle = '#95a5a6';
        }
        
        this.backCtx.fillRect(-size / 2, -size / 2, size, size);
        
        // 玩家方向指示器
        this.backCtx.fillStyle = '#ffffff';
        this.backCtx.fillRect(size / 2 - 2, -2, 6, 4);
        
        this.backCtx.restore();
        
        // 绘制血条
        if (player.isAlive) {
            const barWidth = size;
            const barHeight = 4;
            const healthPercent = player.health / 100;
            
            // 血条背景
            this.backCtx.fillStyle = '#e74c3c';
            this.backCtx.fillRect(player.x, player.y - 15, barWidth, barHeight);
            
            // 当前血量
            this.backCtx.fillStyle = '#27ae60';
            this.backCtx.fillRect(player.x, player.y - 15, barWidth * healthPercent, barHeight);
        }
        
        // 绘制昵称（在血条上方）
        this.backCtx.fillStyle = '#ffffff';
        this.backCtx.font = '12px Arial';
        this.backCtx.textAlign = 'center';
        this.backCtx.fillText(player.nickname, player.x + size / 2, player.y - 20);
        
        // 绘制buff标记（在角色下方）
        this.drawPlayerBuffMarkers(player, size);
        
        // 绘制buff效果
        this.drawPlayerBuffs(player, size);
        
        // 绘制道具状态信息（在角色上方）
        this.drawPlayerPowerupStatus(player, size);
        
        // 添加角色动画效果
        this.drawPlayerAnimation(player, size);
    }

    drawPlayerBuffMarkers(player, size) {
        if (!player.powerups) return;
        
        const time = Date.now();
        const centerX = player.x + size / 2;
        const centerY = player.y + size + 10; // 在角色下方
        const actives = [];
        if (player.powerups.shield && player.powerups.shield.active) actives.push({ ch: 'S', color: '#9b59b6' });
        if (player.powerups.rapidFire && player.powerups.rapidFire.active) actives.push({ ch: 'R', color: '#e67e22' });
        if (player.powerups.damageBoost && player.powerups.damageBoost.active) actives.push({ ch: 'D', color: '#e74c3c' });
        const markerCount = actives.length;
        if (markerCount === 0) return;
        // 先画背景，避免盖住文字
        this.backCtx.save();
        this.backCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.backCtx.fillRect(centerX - markerCount * 6 - 2, centerY - 8, markerCount * 12 + 4, 12);
        this.backCtx.restore();
        // 再画字母标记
        actives.forEach((item, idx) => {
            this.backCtx.save();
            this.backCtx.fillStyle = item.color;
            this.backCtx.font = 'bold 10px Arial';
            this.backCtx.textAlign = 'center';
            this.backCtx.fillText(item.ch, centerX + idx * 12 - 6, centerY);
            this.backCtx.restore();
        });
    }

    drawBullet(bullet) {
        const size = this.gameConfig ? this.gameConfig.BULLET_SIZE : 4;
        const time = Date.now();
        
        this.backCtx.save();
        
        // 绘制子弹尾迹
        const trailLength = 8;
        for (let i = 1; i <= trailLength; i++) {
            const alpha = (trailLength - i) / trailLength * 0.3;
            const trailSize = size * (trailLength - i) / trailLength;
            const trailX = bullet.x - bullet.vx * i * 0.5;
            const trailY = bullet.y - bullet.vy * i * 0.5;
            
            this.backCtx.globalAlpha = alpha;
            this.backCtx.fillStyle = '#ffaa00';
            this.backCtx.beginPath();
            this.backCtx.arc(trailX, trailY, trailSize / 2, 0, Math.PI * 2);
            this.backCtx.fill();
        }
        
        // 绘制主子弹
        this.backCtx.globalAlpha = 1;
        
        // 创建子弹渐变色彩
        const gradient = this.backCtx.createRadialGradient(
            bullet.x, bullet.y, 0,
            bullet.x, bullet.y, size / 2
        );
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.7, '#ffff44');
        gradient.addColorStop(1, '#ffaa00');
        
        this.backCtx.fillStyle = gradient;
        this.backCtx.shadowColor = '#ffff00';
        this.backCtx.shadowBlur = 8;
        this.backCtx.beginPath();
        this.backCtx.arc(bullet.x, bullet.y, size / 2, 0, Math.PI * 2);
        this.backCtx.fill();
        
        // 添加闪烁效果
        this.backCtx.shadowBlur = 0;
        this.backCtx.fillStyle = '#ffffff';
        this.backCtx.globalAlpha = 0.8 + 0.2 * Math.sin(time * 0.02);
        this.backCtx.beginPath();
        this.backCtx.arc(bullet.x, bullet.y, size / 4, 0, Math.PI * 2);
        this.backCtx.fill();
        // 结束子弹绘制
        this.backCtx.restore();
    }

    drawPlayerBuffs(player, size) {
        if (!player.powerups) return;
        
        const centerX = player.x + size / 2;
        const centerY = player.y + size / 2;
        const time = Date.now();
        
        // 护盾效果 - 紫色光环
        if (player.powerups.shield && player.powerups.shield.active) {
            this.backCtx.save();
            this.backCtx.strokeStyle = '#9b59b6';
            this.backCtx.lineWidth = 3;
            this.backCtx.globalAlpha = 0.7 + 0.3 * Math.sin(time * 0.01);
            this.backCtx.beginPath();
            this.backCtx.arc(centerX, centerY, size / 2 + 5, 0, Math.PI * 2);
            this.backCtx.stroke();
            this.backCtx.restore();
        }
        
        // 快速射击效果 - 橙色闪电
        if (player.powerups.rapidFire && player.powerups.rapidFire.active) {
            this.backCtx.save();
            this.backCtx.strokeStyle = '#e67e22';
            this.backCtx.lineWidth = 2;
            this.backCtx.globalAlpha = 0.8 + 0.2 * Math.sin(time * 0.02);
            
            // 绘制闪电效果
            for (let i = 0; i < 3; i++) {
                const angle = (time * 0.01 + i * Math.PI * 2 / 3) % (Math.PI * 2);
                const startX = centerX + Math.cos(angle) * (size / 2 + 8);
                const startY = centerY + Math.sin(angle) * (size / 2 + 8);
                const endX = centerX + Math.cos(angle) * (size / 2 + 15);
                const endY = centerY + Math.sin(angle) * (size / 2 + 15);
                
                this.backCtx.beginPath();
                this.backCtx.moveTo(startX, startY);
                this.backCtx.lineTo(endX, endY);
                this.backCtx.stroke();
            }
            this.backCtx.restore();
        }
        
        // 伤害提升效果 - 红色火焰
        if (player.powerups.damageBoost && player.powerups.damageBoost.active) {
            this.backCtx.save();
            
            // 多层火焰效果
            for (let flame = 0; flame < 5; flame++) {
                const flameAngle = (time * 0.003 + flame * Math.PI * 2 / 5) % (Math.PI * 2);
                const flameRadius = size / 2 + 6 + Math.sin(time * 0.004 + flame) * 4;
                const flameX = centerX + Math.cos(flameAngle) * flameRadius;
                const flameY = centerY + Math.sin(flameAngle) * flameRadius;
                
                // 火焰渐变色彩
                const gradient = this.backCtx.createRadialGradient(
                    flameX, flameY, 0,
                    flameX, flameY, 8
                );
                gradient.addColorStop(0, '#ff4444');
                gradient.addColorStop(0.5, '#ff8800');
                gradient.addColorStop(1, 'rgba(255, 255, 0, 0)');
                
                this.backCtx.fillStyle = gradient;
                this.backCtx.globalAlpha = 0.7 + 0.3 * Math.sin(time * 0.006 + flame);
                
                this.backCtx.beginPath();
                this.backCtx.arc(flameX, flameY, 6 + Math.sin(time * 0.008 + flame) * 2, 0, Math.PI * 2);
                this.backCtx.fill();
            }
            
            this.backCtx.restore();
        }
        
        // buff持续时间显示
        this.drawBuffTimers(player, centerX, centerY - size / 2 - 20, time);
    }
    
    // 绘制星星的辅助函数
    drawStar(cx, cy, spikes, outerRadius, innerRadius) {
        let rot = Math.PI / 2 * 3;
        let x = cx;
        let y = cy;
        const step = Math.PI / spikes;
        
        this.backCtx.beginPath();
        this.backCtx.moveTo(cx, cy - outerRadius);
        
        for (let i = 0; i < spikes; i++) {
            x = cx + Math.cos(rot) * outerRadius;
            y = cy + Math.sin(rot) * outerRadius;
            this.backCtx.lineTo(x, y);
            rot += step;
            
            x = cx + Math.cos(rot) * innerRadius;
            y = cy + Math.sin(rot) * innerRadius;
            this.backCtx.lineTo(x, y);
            rot += step;
        }
        
        this.backCtx.lineTo(cx, cy - outerRadius);
        this.backCtx.closePath();
        this.backCtx.fill();
    }
    
    // 绘制玩家道具状态信息
    drawPlayerPowerupStatus(player, size) {
        if (!player.powerups) return;
        
        const time = Date.now();
        const centerX = player.x + size / 2;
        const baseY = player.y - 40; // 在昵称上方
        
        // 获取当前生效的道具
        const activePowerups = [];
        
        if (player.powerups.shield && player.powerups.shield.active) {
            const remainingTime = (player.powerups.shield.endTime - time) / 1000;
            if (remainingTime > 0) {
                activePowerups.push({
                    key: 'shield',
                    name: '护盾',
                    icon: '🛡️',
                    color: '#9b59b6',
                    remainingTime: remainingTime
                });
            }
        }
        
        if (player.powerups.rapidFire && player.powerups.rapidFire.active) {
            const remainingTime = (player.powerups.rapidFire.endTime - time) / 1000;
            if (remainingTime > 0) {
                activePowerups.push({
                    key: 'rapidFire',
                    name: '快速射击',
                    icon: '⚡',
                    color: '#e67e22',
                    remainingTime: remainingTime
                });
            }
        }
        
        if (player.powerups.damageBoost && player.powerups.damageBoost.active) {
            const remainingTime = (player.powerups.damageBoost.endTime - time) / 1000;
            if (remainingTime > 0) {
                activePowerups.push({
                    key: 'damageBoost',
                    name: '伤害提升',
                    icon: '🔥',
                    color: '#e74c3c',
                    remainingTime: remainingTime
                });
            }
        }
        
        if (player.powerups.heal && player.powerups.heal.active) {
            const remainingTime = (player.powerups.heal.endTime - time) / 1000;
            if (remainingTime > 0) {
                activePowerups.push({
                    key: 'heal',
                    name: '回血',
                    icon: '❤️',
                    color: '#27ae60',
                    remainingTime: remainingTime
                });
            }
        }
        
        if (activePowerups.length === 0) return;
        
        // 绘制背景框
        const boxWidth = Math.max(120, activePowerups.length * 100);
        const boxHeight = 25 + activePowerups.length * 20;
        const boxX = centerX - boxWidth / 2;
        const boxY = baseY - boxHeight;
        
        this.backCtx.save();
        this.backCtx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        this.backCtx.fillRect(boxX, boxY, boxWidth, boxHeight);
        this.backCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        this.backCtx.lineWidth = 1;
        this.backCtx.strokeRect(boxX, boxY, boxWidth, boxHeight);
        
        // 绘制道具信息
        activePowerups.forEach((powerup, index) => {
            const itemY = boxY + 15 + index * 20;
            
            // 绘制图标
            this.backCtx.font = '14px Arial';
            this.backCtx.textAlign = 'left';
            this.backCtx.fillStyle = powerup.color;
            this.backCtx.fillText(powerup.icon, boxX + 5, itemY);
            
            // 绘制道具名称
            this.backCtx.font = '12px Arial';
            this.backCtx.fillStyle = '#ffffff';
            this.backCtx.fillText(powerup.name, boxX + 25, itemY);
            
            // 绘制剩余时间
            const timeText = `${Math.ceil(powerup.remainingTime)}s`;
            this.backCtx.font = '11px Arial';
            this.backCtx.textAlign = 'right';
            this.backCtx.fillStyle = powerup.remainingTime < 5 ? '#ff6b6b' : '#95a5a6';
            this.backCtx.fillText(timeText, boxX + boxWidth - 5, itemY);
            
            // 绘制进度条
            const totalDurationSec = (this.gameConfig && this.gameConfig.POWERUP_DURATION ? this.gameConfig.POWERUP_DURATION / 1000 : 15);
            const progress = Math.max(0, Math.min(1, powerup.remainingTime / totalDurationSec)); // 按配置总时间
            const barWidth = boxWidth - 10;
            const barHeight = 3;
            const barX = boxX + 5;
            const barY = itemY + 5;
            
            // 进度条背景
            this.backCtx.fillStyle = 'rgba(255, 255, 255, 0.2)';
            this.backCtx.fillRect(barX, barY, barWidth, barHeight);
            
            // 进度条填充
            this.backCtx.fillStyle = powerup.color;
            this.backCtx.fillRect(barX, barY, barWidth * progress, barHeight);
        });
        
        this.backCtx.restore();
    }
    
    // 角色动画效果
    drawPlayerAnimation(player, size) {
        if (!player.isAlive) return;
        
        const centerX = player.x + size / 2;
        const centerY = player.y + size / 2;
        const time = Date.now();
        
        // 呼吸动画（角色边缘轻微变化）
        const breathScale = 1 + Math.sin(time * 0.003) * 0.03;
        
        this.backCtx.save();
        this.backCtx.translate(centerX, centerY);
        this.backCtx.scale(breathScale, breathScale);
        this.backCtx.translate(-centerX, -centerY);
        
        // 绘制角色光晕
        const glowGradient = this.backCtx.createRadialGradient(
            centerX, centerY, size * 0.3,
            centerX, centerY, size * 0.8
        );
        glowGradient.addColorStop(0, player.color + '30');
        glowGradient.addColorStop(1, player.color + '00');
        
        this.backCtx.fillStyle = glowGradient;
        this.backCtx.beginPath();
        this.backCtx.arc(centerX, centerY, size * 0.8, 0, Math.PI * 2);
        this.backCtx.fill();
        
        this.backCtx.restore();
        
        // 如果角色在移动，添加运动迹迹
        if (player.isMoving) {
            for (let i = 1; i <= 3; i++) {
                const trailAlpha = (4 - i) / 4 * 0.3;
                this.backCtx.save();
                this.backCtx.globalAlpha = trailAlpha;
                this.backCtx.fillStyle = player.color;
                this.backCtx.beginPath();
                
                // 根据移动方向绘制迹迹
                const trailX = centerX - (player.vx || 0) * i * 2;
                const trailY = centerY - (player.vy || 0) * i * 2;
                
                this.backCtx.arc(trailX, trailY, size * 0.3 * (4 - i) / 4, 0, Math.PI * 2);
                this.backCtx.fill();
                this.backCtx.restore();
            }
        }
    }
    
    // 显示buff剩余时间
    drawBuffTimers(player, centerX, baseY, time) {
        if (!player.powerups) return;
        
        const buffTypes = [
            { key: 'shield', color: '#9b59b6', icon: '🛡️' },
            { key: 'rapidFire', color: '#e67e22', icon: '⚡' },
            { key: 'damageBoost', color: '#e74c3c', icon: '🔥' }
        ];
        
        let displayIndex = 0;
        const totalDurationSec = (this.gameConfig && this.gameConfig.POWERUP_DURATION ? this.gameConfig.POWERUP_DURATION / 1000 : 15);
        
        buffTypes.forEach(buff => {
            if (player.powerups[buff.key] && player.powerups[buff.key].active) {
                const remainingTime = (player.powerups[buff.key].endTime - time) / 1000;
                const progress = Math.max(0, Math.min(1, remainingTime / totalDurationSec));
                
                if (remainingTime > 0) {
                    const timerY = baseY - displayIndex * 8;
                    
                    // 绘制buff图标
                    this.backCtx.save();
                    this.backCtx.font = '12px Arial';
                    this.backCtx.textAlign = 'center';
                    this.backCtx.fillStyle = buff.color;
                    this.backCtx.fillText(buff.icon, centerX - 20, timerY);
                    
                    // 绘制进度条背景
                    this.backCtx.fillStyle = '#333333';
                    this.backCtx.fillRect(centerX - 10, timerY - 3, 30, 6);
                    
                    // 绘制进度条
                    this.backCtx.fillStyle = buff.color;
                    this.backCtx.fillRect(centerX - 10, timerY - 3, 30 * progress, 6);
                    
                    // 绘制进度条边框
                    this.backCtx.strokeStyle = '#ffffff';
                    this.backCtx.lineWidth = 1;
                    this.backCtx.strokeRect(centerX - 10, timerY - 3, 30, 6);
                    
                    this.backCtx.restore();
                    displayIndex++;
                }
            }
        });
    }
}

// 启动游戏
window.game = new GameClient();
