// 二进制协议类型常量（客户端/服务端一致）
// roundRect 兜底（Chrome 99+ 原生支持；旧内核用 arcTo 实现）
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        const rr = Math.min(Array.isArray(r) ? r[0] : (r || 0), w / 2, h / 2);
        this.moveTo(x + rr, y);
        this.arcTo(x + w, y, x + w, y + h, rr);
        this.arcTo(x + w, y + h, x, y + h, rr);
        this.arcTo(x, y + h, x, y, rr);
        this.arcTo(x, y, x + w, y, rr);
        this.closePath();
        return this;
    };
}

const MESSAGE_TYPES = {
    // 客户端发送
    JOIN: 1,
    MOVE: 2,
    SHOOT: 3,
    MELEE: 4,
    RESPAWN: 5,
    CHAT: 6,
    PING: 7,
    RELOAD: 8,
    GRENADE: 9,

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
    // opts: gravity 重力 | shape 'circle'/'streak'(速度方向光条)/'rect'(旋转碎片) | spin 自转 | glow 加色发光
    constructor(x, y, vx, vy, color, life, size = 2, opts = undefined) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.color = color;
        this.life = life;
        this.maxLife = life;
        this.size = size;
        this.gravity = (opts && opts.gravity) || 0;
        this.shape = (opts && opts.shape) || 'circle';
        this.rot = Math.random() * Math.PI * 2;
        this.spin = (opts && opts.spin) || 0;
        this.glow = !!(opts && opts.glow);
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vy += this.gravity;
        this.rot += this.spin;
        this.life--;
        this.vx *= 0.98; // 阻力
        this.vy *= 0.98;
    }

    draw(ctx) {
        const alpha = this.life / this.maxLife;
        ctx.save();
        ctx.globalAlpha = alpha;
        if (this.glow) ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = this.color;
        if (this.shape === 'streak') {
            // 沿速度方向的光条（火花）
            ctx.strokeStyle = this.color;
            ctx.lineWidth = this.size;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(this.x - this.vx * 2.4, this.y - this.vy * 2.4);
            ctx.lineTo(this.x, this.y);
            ctx.stroke();
        } else if (this.shape === 'rect') {
            // 旋转小碎片（弹壳/碎屑）
            ctx.translate(this.x, this.y);
            ctx.rotate(this.rot);
            ctx.fillRect(-this.size, -this.size * 0.6, this.size * 2, this.size * 1.2);
        } else {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    isDead() {
        return this.life <= 0;
    }
}

// 刀挥动效果类：有轮廓的刀 + 跟随刀身的弧形挥砍拖尾
// opts.claw = true 时渲染为感染者的三道利爪撕裂（绿色）
class KnifeSwingEffect {
    constructor(x, y, targetX, targetY, duration = 340, opts = undefined) {
        this.x = x;
        this.y = y;
        this.duration = duration;
        this.startTime = Date.now();
        this.angle = Math.atan2(targetY - y, targetX - x); // 挥动中心朝向
        this.arcHalf = Math.PI * 0.42; // 单侧挥幅约 75°
        this.knifeLength = 50;         // 与攻击判定范围匹配
        this.progress = 0;
        this.claw = !!(opts && opts.claw);
    }

    update() {
        const elapsed = Date.now() - this.startTime;
        this.progress = Math.min(elapsed / this.duration, 1);
        return this.progress >= 1;
    }

    draw(ctx) {
        const p = this.progress;
        const fade = p < 0.7 ? 1 : Math.max(0, 1 - (p - 0.7) / 0.3);
        // 快进慢出：起手迅猛、收势自然
        const eased = 1 - Math.pow(1 - p, 2.6);
        const startA = -this.arcHalf;
        const curA = startA + eased * this.arcHalf * 2;
        const r = this.knifeLength;

        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);

        // ---- 挥砍拖尾：从起始角扫到当前角度的弧形渐变（外缘最亮；爪击为绿色） ----
        const trailFrom = Math.max(startA, curA - 1.6);
        if (curA - trailFrom > 0.02) {
            const grad = ctx.createRadialGradient(0, 0, r * 0.25, 0, 0, r);
            if (this.claw) {
                grad.addColorStop(0, 'rgba(140, 255, 170, 0)');
                grad.addColorStop(0.72, 'rgba(140, 255, 170, 0.12)');
                grad.addColorStop(1, 'rgba(190, 255, 205, 0.45)');
            } else {
                grad.addColorStop(0, 'rgba(200, 236, 255, 0)');
                grad.addColorStop(0.72, 'rgba(200, 236, 255, 0.10)');
                grad.addColorStop(1, 'rgba(228, 246, 255, 0.42)');
            }
            ctx.globalAlpha = fade;
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, r, trailFrom, curA);
            ctx.closePath();
            ctx.fill();
            // 拖尾外缘亮弧
            ctx.globalAlpha = fade * 0.8;
            ctx.strokeStyle = this.claw ? 'rgba(190, 255, 205, 0.6)' : 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.arc(0, 0, r - 1, trailFrom, curA);
            ctx.stroke();
        }

        // ---- 爪击：三道平行撕裂痕（无刀体） ----
        if (this.claw) {
            ctx.rotate(curA);
            ctx.globalAlpha = fade;
            for (const off of [-9, 0, 9]) {
                // 爪痕主体：根窄尖利的月牙条
                ctx.fillStyle = 'rgba(220, 255, 230, 0.92)';
                ctx.beginPath();
                ctx.moveTo(12, off * 0.35);
                ctx.quadraticCurveTo(r * 0.62, off - 1.5, r + 2, off * 1.15);
                ctx.quadraticCurveTo(r * 0.62, off + 2.2, 12, off * 0.35 + 2);
                ctx.closePath();
                ctx.fill();
                // 绿色发光描边
                ctx.strokeStyle = 'rgba(110, 230, 150, 0.65)';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            ctx.restore();
            return;
        }

        // ---- 刀本体（旋转到当前挥动角度） ----
        ctx.rotate(curA);
        ctx.globalAlpha = fade;

        // 投影
        ctx.save();
        ctx.translate(2, 3);
        ctx.globalAlpha = fade * 0.25;
        ctx.fillStyle = '#000';
        this._bladePath(ctx);
        ctx.fill();
        ctx.restore();

        // 刀柄（深色 + 缠绕纹理）与柄尾
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#3d2f22';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(-14, 0);
        ctx.lineTo(-4, 0);
        ctx.stroke();
        ctx.strokeStyle = '#5c4632';
        ctx.lineWidth = 1.5;
        for (let i = -12; i <= -6; i += 3) {
            ctx.beginPath();
            ctx.moveTo(i, -2.6);
            ctx.lineTo(i + 2, 2.6);
            ctx.stroke();
        }
        ctx.fillStyle = '#8a94a6';
        ctx.beginPath();
        ctx.arc(-15, 0, 2.6, 0, Math.PI * 2);
        ctx.fill();
        // 护手
        ctx.fillStyle = '#9aa4b4';
        ctx.fillRect(-5, -6.5, 3, 13);

        // 刀身：金属渐变（刀背深、开刃线、刃口亮白）
        const steel = ctx.createLinearGradient(0, -4, 0, 5);
        steel.addColorStop(0, '#aab6c6');
        steel.addColorStop(0.52, '#d5dde8');
        steel.addColorStop(0.56, '#f8fbff');
        steel.addColorStop(1, '#ffffff');
        ctx.fillStyle = steel;
        this._bladePath(ctx);
        ctx.fill();
        ctx.strokeStyle = 'rgba(30, 41, 59, 0.55)';
        ctx.lineWidth = 1;
        this._bladePath(ctx);
        ctx.stroke();

        ctx.restore();
    }

    // 刀身轮廓：直刀背 + 弧形收尖 + 刃腹微鼓
    _bladePath(ctx) {
        ctx.beginPath();
        ctx.moveTo(-2, -3.4);
        ctx.lineTo(36, -3.4);
        ctx.quadraticCurveTo(45, -2.6, 50, 0.6);
        ctx.quadraticCurveTo(41, 4.6, 30, 4.8);
        ctx.lineTo(-2, 4.8);
        ctx.closePath();
    }

    isDead() {
        return Date.now() - this.startTime >= this.duration;
    }
}

// 特效类
class Effect {
    constructor(x, y, type, duration = 1000, opts = {}) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.duration = duration;
        this.angle = opts.angle || 0;
        this.weapon = opts.weapon || 'rifle';
        this.color = opts.color || '#fbbf24';
        this.label = opts.label || '';
        this.radius = opts.radius || 90;
        this.startTime = Date.now();
        this.particles = [];
        this.createParticles();
    }

    createParticles() {
        switch (this.type) {
            case 'shoot': {
                // 枪口喷火：沿射击方向的窄锥形火花 + 亮芯，样式随武器
                const dir = this.angle;
                const colors = ['#fff6d5', '#ffd27f', '#f39c12', '#ff8c42'];
                let count = 7, cone = 0.55, speedMul = 1;
                if (this.weapon === 'shotgun') { count = 13; cone = 1.05; }
                else if (this.weapon === 'smg') { count = 5; cone = 0.5; }
                else if (this.weapon === 'sniper') { count = 8; cone = 0.28; speedMul = 1.7; }
                else if (this.weapon === 'rpg') { count = 11; cone = 0.85; speedMul = 1.2; }
                for (let i = 0; i < count; i++) {
                    const a = dir + (Math.random() - 0.5) * cone;
                    const speed = (2.5 + Math.random() * 3.5) * speedMul;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * speed,
                        Math.sin(a) * speed,
                        colors[(Math.random() * colors.length) | 0],
                        10 + ((Math.random() * 6) | 0),
                        1 + Math.random() * 1.5,
                        { glow: true }
                    ));
                }
                this.particles.push(new Particle(
                    this.x, this.y,
                    Math.cos(dir) * 0.5, Math.sin(dir) * 0.5,
                    '#ffffff', 6, this.weapon === 'shotgun' ? 4 : 3, { glow: true }
                ));
                // 抛壳（垂直枪口方向弹出，带重力翻滚）
                if (this.weapon !== 'rpg') {
                    const side = Math.random() < 0.5 ? 1 : -1;
                    const ca = dir + side * Math.PI / 2 + (Math.random() - 0.5) * 0.5;
                    this.particles.push(new Particle(
                        this.x - Math.cos(dir) * 10, this.y - Math.sin(dir) * 10,
                        Math.cos(ca) * (1.2 + Math.random()),
                        Math.sin(ca) * (1.2 + Math.random()) - 1.6,
                        '#e8c268', 26, 1.6,
                        { gravity: 0.16, shape: 'rect', spin: 0.4 }
                    ));
                }
                // 一缕硝烟
                this.particles.push(new Particle(
                    this.x, this.y,
                    Math.cos(dir) * 0.6 + (Math.random() - 0.5) * 0.4,
                    Math.sin(dir) * 0.6 - 0.5,
                    'rgba(160, 170, 190, 0.5)', 26, 2.5 + Math.random() * 2
                ));
                break;
            }
            case 'hitmarker': {
                // 击中标记（无粒子，draw 中绘制）
                break;
            }
            case 'kill': {
                // 击杀确认：金色星屑爆散
                for (let i = 0; i < 12; i++) {
                    const a = Math.random() * Math.PI * 2;
                    const speed = 2 + Math.random() * 4;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * speed, Math.sin(a) * speed,
                        Math.random() < 0.4 ? '#ffffff' : '#ffd76b',
                        16 + ((Math.random() * 12) | 0),
                        1.5 + Math.random() * 2,
                        { glow: true, shape: Math.random() < 0.5 ? 'streak' : 'circle' }
                    ));
                }
                break;
            }
            case 'explosion': {
                // 爆炸：火球碎片 + 缓慢升腾的烟雾（冲击环与白闪在 draw 中绘制）
                const fireColors = ['#fff6d5', '#ffd27f', '#ff9c42', '#ff6b35', '#f2495c'];
                for (let i = 0; i < 20; i++) {
                    const a = Math.random() * Math.PI * 2;
                    const speed = 1.5 + Math.random() * 5;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * speed,
                        Math.sin(a) * speed,
                        fireColors[(Math.random() * fireColors.length) | 0],
                        14 + ((Math.random() * 16) | 0),
                        2 + Math.random() * 3
                    ));
                }
                for (let i = 0; i < 10; i++) {
                    const a = Math.random() * Math.PI * 2;
                    const speed = 0.4 + Math.random() * 1.2;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * speed,
                        Math.sin(a) * speed - 0.5,
                        '#5b6470',
                        30 + ((Math.random() * 22) | 0),
                        3 + Math.random() * 3.5
                    ));
                }
                // 高速火星条（带重力坠落）
                for (let i = 0; i < 10; i++) {
                    const a = Math.random() * Math.PI * 2;
                    const speed = 4 + Math.random() * 6;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * speed, Math.sin(a) * speed,
                        Math.random() < 0.5 ? '#ffe1a8' : '#ff9c42',
                        14 + ((Math.random() * 10) | 0), 1.6,
                        { shape: 'streak', glow: true, gravity: 0.15 }
                    ));
                }
                break;
            }
            case 'crateBreak': {
                // 木箱碎裂：木屑翻滚 + 尘土
                for (let i = 0; i < 10; i++) {
                    const a = Math.random() * Math.PI * 2;
                    const speed = 1 + Math.random() * 3;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * speed,
                        Math.sin(a) * speed - 1.2,
                        Math.random() < 0.5 ? '#c8945a' : '#8c5a22',
                        22 + ((Math.random() * 14) | 0),
                        1.8 + Math.random() * 2,
                        { gravity: 0.14, shape: 'rect', spin: 0.3 }
                    ));
                }
                for (let i = 0; i < 6; i++) {
                    const a = Math.random() * Math.PI * 2;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * (0.5 + Math.random()),
                        Math.sin(a) * (0.5 + Math.random()) - 0.4,
                        'rgba(170, 180, 200, 0.45)',
                        24 + ((Math.random() * 10) | 0),
                        2.5 + Math.random() * 2
                    ));
                }
                break;
            }
            case 'crate': {
                // 开箱：内容色碎片爆裂 + 白色亮片（光环与浮字在 draw 中绘制）
                for (let i = 0; i < 14; i++) {
                    const a = Math.random() * Math.PI * 2;
                    const speed = 1.5 + Math.random() * 3.5;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(a) * speed,
                        Math.sin(a) * speed - 0.8,
                        Math.random() < 0.35 ? '#ffffff' : this.color,
                        22 + ((Math.random() * 14) | 0),
                        1.5 + Math.random() * 2
                    ));
                }
                break;
            }
            case 'hit': {
                // 命中爆点：白色亮芯 + 红色碎片 + 火花条
                this.particles.push(new Particle(this.x, this.y, 0, 0, '#ffffff', 6, 5, { glow: true }));
                for (let i = 0; i < 8; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 1.5 + Math.random() * 3.5;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        Math.random() < 0.3 ? '#ffb3a0' : '#f2495c',
                        16 + ((Math.random() * 12) | 0),
                        1.5 + Math.random() * 2,
                        { gravity: 0.06 }
                    ));
                }
                for (let i = 0; i < 4; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 3 + Math.random() * 3;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#ffe1a8', 10 + ((Math.random() * 6) | 0), 1.4,
                        { shape: 'streak', glow: true }
                    ));
                }
                break;
            }
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
                // 尘土（重力下落的灰粒）
                for (let i = 0; i < 6; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 0.5 + Math.random() * 2;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed - 0.8,
                        '#9aa4b8', 22 + ((Math.random() * 10) | 0), 1.5 + Math.random() * 1.5,
                        { gravity: 0.1 }
                    ));
                }
                // 迸溅火花条
                for (let i = 0; i < 5; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const speed = 2.5 + Math.random() * 4;
                    this.particles.push(new Particle(
                        this.x, this.y,
                        Math.cos(angle) * speed,
                        Math.sin(angle) * speed,
                        '#ffcf6b', 9 + ((Math.random() * 6) | 0), 1.2,
                        { shape: 'streak', glow: true, gravity: 0.12 }
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

        // 枪口星形闪光（前 80ms，沿射击方向的四芒星）
        if (this.type === 'shoot') {
            const el = Date.now() - this.startTime;
            if (el < 80) {
                const p = 1 - el / 80;
                const big = this.weapon === 'shotgun' || this.weapon === 'rpg';
                const L = (big ? 15 : 10) * (0.6 + p * 0.4);
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = p;
                ctx.translate(this.x, this.y);
                ctx.rotate(this.angle);
                const star = (len, wid, color) => {
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.moveTo(len, 0);
                    ctx.quadraticCurveTo(0, wid, -len * 0.45, 0);
                    ctx.quadraticCurveTo(0, -wid, len, 0);
                    ctx.fill();
                };
                star(L * 1.5, L * 0.4, 'rgba(255, 200, 110, 0.9)');
                ctx.rotate(Math.PI / 2);
                star(L * 0.7, L * 0.3, 'rgba(255, 200, 110, 0.7)');
                ctx.rotate(-Math.PI / 2);
                star(L, L * 0.26, '#fff6dd');
                ctx.restore();
            }
        }

        // 击中标记：准星四角短线向外弹开（打中敌人时的手感反馈）
        if (this.type === 'hitmarker') {
            const p = Math.min(1, (Date.now() - this.startTime) / this.duration);
            const d = 5 + p * 5;
            ctx.save();
            ctx.globalAlpha = 1 - p;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                ctx.beginPath();
                ctx.moveTo(this.x + sx * d, this.y + sy * d);
                ctx.lineTo(this.x + sx * (d + 5), this.y + sy * (d + 5));
                ctx.stroke();
            }
            ctx.restore();
        }

        // 爆炸附加表现：白闪 + 冲击波环扩散到爆炸半径
        if (this.type === 'explosion') {
            const p = Math.min(1, (Date.now() - this.startTime) / this.duration);
            ctx.save();
            if (p < 0.12) {
                ctx.globalAlpha = (1 - p / 0.12) * 0.85;
                ctx.fillStyle = '#fff8ec';
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius * 0.45, 0, Math.PI * 2);
                ctx.fill();
            }
            if (p < 0.55) {
                const rp = p / 0.55;
                const ringR = this.radius * (0.25 + 0.75 * (1 - Math.pow(1 - rp, 2)));
                ctx.globalAlpha = (1 - rp) * 0.7;
                ctx.strokeStyle = '#ffd9a0';
                ctx.lineWidth = 3.5 * (1 - rp) + 1;
                ctx.beginPath();
                ctx.arc(this.x, this.y, ringR, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }

        // 开箱附加表现：扩散光环 + 内容名浮字
        if (this.type === 'crate') {
            const p = Math.min(1, (Date.now() - this.startTime) / this.duration);
            ctx.save();
            // 光环
            if (p < 0.6) {
                ctx.globalAlpha = (1 - p / 0.6) * 0.55;
                ctx.strokeStyle = this.color;
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(this.x, this.y, 8 + p * 55, 0, Math.PI * 2);
                ctx.stroke();
            }
            // 内容名上浮
            if (this.label) {
                ctx.globalAlpha = 1 - p;
                ctx.font = 'bold 14px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(4, 8, 15, 0.85)';
                ctx.strokeText(this.label, this.x, this.y - 18 - p * 26);
                ctx.fillStyle = this.color;
                ctx.fillText(this.label, this.x, this.y - 18 - p * 26);
            }
            ctx.restore();
        }
    }

    isDead() {
        return Date.now() - this.startTime > this.duration || this.particles.length === 0;
    }
}

// 伤害数字飘字
class DamageNumber {
    constructor(x, y, text, color) {
        this.x = x + (Math.random() - 0.5) * 12;
        this.y = y;
        this.text = text;
        this.color = color;
        this.life = 1; // 1 -> 0
    }

    update() {
        this.y -= 0.7;
        this.life -= 0.022;
    }

    isDead() { return this.life <= 0; }

    draw(ctx) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, this.life);
        ctx.font = 'bold 14px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.strokeText(this.text, this.x, this.y);
        ctx.fillStyle = this.color;
        ctx.fillText(this.text, this.x, this.y);
        ctx.restore();
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
        this.trailParticles = []; // 火箭烟迹/落地尘等松散粒子
        this.meleeIndicators = [];
        this.knifeSwingEffects = [];
        this.damageNumbers = [];
        this.shakeMag = 0;
        this.flashAlpha = 0;
        this.flashColor = '#ffffff';
        this.keys = {};
        this.mouse = { x: 0, y: 0 };
        this.lastUpdate = 0;
        
        // 添加移动数据发送频率限制
        this.lastMoveUpdate = 0;
        this.moveUpdateInterval = 1000 / 60; // 60fps发送频率，与服务器同步
        
        // 添加插值平滑参数
        this.interpolationFactor = 0.25; // 他人包时位置插值（减少漂移）
        this.otherFrameLerp = 0.2;       // 他人按帧平滑靠拢系数
        this.extrapolationDelayMs = 150; // 超过该间隔未收到新包开始外推
        this.extrapolationMaxMs = 200;   // 外推封顶时长，避免漂移过远
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
    }

    setupEventListeners() {
        // 键盘事件
        document.addEventListener('keydown', (e) => {
            if (e.target.matches && e.target.matches('input, textarea')) return;
            this.keys[e.key.toLowerCase()] = true;

            // 复活键
            if (e.code === 'Space') {
                e.preventDefault();
                this.respawn();
            }

            // R 键换弹
            if ((e.key === 'r' || e.key === 'R') && this.playerId) {
                this.sendReload();
            }

            // G 键投掷手雷
            if ((e.key === 'g' || e.key === 'G') && this.playerId) {
                this.sendGrenade();
            }
        });

        document.addEventListener('keyup', (e) => {
            this.keys[e.key.toLowerCase()] = false;
        });

        // 鼠标事件
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            // 将鼠标坐标转换为游戏世界坐标（1200x800）
            // 使用CSS像素计算，不需要考虑devicePixelRatio
            this.mouse.x = ((e.clientX - rect.left) / rect.width) * 1200;
            this.mouse.y = ((e.clientY - rect.top) / rect.height) * 800;
            
            // 确保坐标在有效范围内
            this.mouse.x = Math.max(0, Math.min(1200, this.mouse.x));
            this.mouse.y = Math.max(0, Math.min(800, this.mouse.y));
        });

        // 左键按住连发（射速由当前武器决定，见 handleAutoFire）
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) {
                this.mouseDown = true;
                this.handleAutoFire(); // 按下立即尝试开火
            }
        });
        document.addEventListener('mouseup', (e) => {
            if (e.button === 0) this.mouseDown = false;
        });
        this.canvas.addEventListener('mouseleave', () => { this.mouseDown = false; });

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

        // 触屏控制（虚拟摇杆 + 瞄准开火 + 动作按钮）
        this.setupTouchControls();

        // 表情快捷栏
        const emojiBar = document.getElementById('emojiBar');
        if (emojiBar && chatInput) {
            ['😀', '😂', '😎', '😭', '🤔', '😱', '👍', '🔥', '💥', '🎉', '🫡', '💀'].forEach(em => {
                const btn = document.createElement('button');
                btn.className = 'emoji-btn';
                btn.type = 'button';
                btn.textContent = em;
                btn.addEventListener('click', () => {
                    if (chatInput.value.length + em.length <= (chatInput.maxLength || 100)) {
                        chatInput.value += em;
                    }
                    chatInput.focus();
                });
                emojiBar.appendChild(btn);
            });
        }
    }

    // 触屏设备：进入沉浸模式（浏览器全屏 + 尝试锁定横屏）
    // 需要用户手势上下文；iPhone Safari 不支持全屏 API，静默跳过
    requestImmersive() {
        if (!this.isTouch) return;
        try {
            const el = document.documentElement;
            const lockLandscape = () => {
                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('landscape').catch(() => {});
                }
            };
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                const req = el.requestFullscreen || el.webkitRequestFullscreen;
                if (req) {
                    const p = req.call(el);
                    if (p && p.then) p.then(lockLandscape).catch(() => {});
                }
            } else {
                lockLandscape();
            }
        } catch (e) {}
    }

    // 触屏方案：左 45% 屏落指出浮动摇杆控制移动；右侧落指按住即朝该方向自动开火，
    // 拖动改变瞄准方向；死亡时点右侧复活；右下三颗按钮：近战/手雷/换弹
    setupTouchControls() {
        this.isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
        this.touchMove = { x: 0, y: 0 };
        if (!this.isTouch) return;

        const container = document.getElementById('gameContainer');
        const joyBase = document.getElementById('joyBase');
        const joyKnob = document.getElementById('joyKnob');
        if (!container || !joyBase) return;
        const JOY_R = 42;
        let joyId = null, joyCenter = null;
        let aimId = null, aimStart = null;

        const setAim = (dx, dy) => {
            const me = this.players.get(this.playerId);
            if (!me) return;
            const size = (this.gameConfig && this.gameConfig.PLAYER_SIZE) || 20;
            const len = Math.hypot(dx, dy) || 1;
            this.mouse.x = me.x + size / 2 + (dx / len) * 140;
            this.mouse.y = me.y + size / 2 + (dy / len) * 140;
        };

        container.addEventListener('touchstart', (e) => {
            if (!this.playerId) return; // 未进入游戏不拦截（大厅正常滚动/点击）
            // 游戏中触摸即尝试进入全屏沉浸（未全屏时）
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                this.requestImmersive();
            }
            let handled = false;
            for (const t of e.changedTouches) {
                if (t.target.closest && t.target.closest('.touch-btn, #hudRight, #invitePanel, #inviteToggle')) continue;
                handled = true;
                if (t.clientX < window.innerWidth * 0.45 && joyId === null) {
                    joyId = t.identifier;
                    joyCenter = { x: t.clientX, y: t.clientY };
                    joyBase.style.left = (t.clientX - 55) + 'px';
                    joyBase.style.top = (t.clientY - 55) + 'px';
                    joyBase.classList.add('active');
                } else if (aimId === null) {
                    const me = this.players.get(this.playerId);
                    if (me && !me.isAlive) { this.respawn(); continue; }
                    aimId = t.identifier;
                    aimStart = { x: t.clientX, y: t.clientY };
                    this.mouseDown = true; // 按住即自动开火（朝当前瞄准方向）
                }
            }
            if (handled) e.preventDefault();
        }, { passive: false });

        container.addEventListener('touchmove', (e) => {
            if (!this.playerId) return;
            for (const t of e.changedTouches) {
                if (t.identifier === joyId) {
                    let dx = t.clientX - joyCenter.x;
                    let dy = t.clientY - joyCenter.y;
                    const len = Math.hypot(dx, dy);
                    if (len > JOY_R) { dx = dx / len * JOY_R; dy = dy / len * JOY_R; }
                    joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
                    this.touchMove.x = dx / JOY_R;
                    this.touchMove.y = dy / JOY_R;
                } else if (t.identifier === aimId) {
                    const dx = t.clientX - aimStart.x;
                    const dy = t.clientY - aimStart.y;
                    if (Math.hypot(dx, dy) > 12) setAim(dx, dy);
                }
            }
            e.preventDefault();
        }, { passive: false });

        const endTouch = (e) => {
            for (const t of e.changedTouches) {
                if (t.identifier === joyId) {
                    joyId = null;
                    this.touchMove.x = 0;
                    this.touchMove.y = 0;
                    joyKnob.style.transform = 'translate(-50%, -50%)';
                    joyBase.classList.remove('active');
                } else if (t.identifier === aimId) {
                    aimId = null;
                    this.mouseDown = false;
                }
            }
        };
        container.addEventListener('touchend', endTouch);
        container.addEventListener('touchcancel', endTouch);

        // 动作按钮
        const bind = (id, fn) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('touchstart', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    fn();
                }, { passive: false });
            }
        };
        bind('tbReload', () => this.sendReload());
        bind('tbGrenade', () => this.sendGrenade());
        bind('tbMelee', () => {
            const me = this.players.get(this.playerId);
            if (me && me.isAlive) this.meleeAttack();
        });
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
            document.body.classList.add('in-game');
            if (this.isTouch) {
                const tc = document.getElementById('touchControls');
                if (tc) tc.classList.remove('hidden');
                this.requestImmersive(); // 进入游戏即尝试全屏（按钮点击的手势上下文）
            }
            if (window.gameMusic) window.gameMusic.play('battle');
        };
    }

    joinGame() {
        const nickname = document.getElementById('nicknameInput').value.trim();
        if (!nickname) {
            window.showToast('请先输入昵称', 'warn');
            document.getElementById('nicknameInput').focus();
            return;
        }

        // 优先使用页面提供的传输工厂（无服务器局域网版：本地回环或WebRTC DataChannel），
        // 否则连接WebSocket服务器（自动检测当前主机地址）
        if (window.createGameTransport) {
            this.ws = window.createGameTransport();
        } else {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.hostname;
            const port = '38080';
            this.ws = new WebSocket(`${protocol}//${host}:${port}`);
        }
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
            window.showToast('与服务器断开连接，请刷新页面重试', 'error', 8000);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket错误:', error);
            window.showToast('连接服务器失败，请确保服务器正在运行', 'error');
        };
    }

    sendChatMessage() {
        try {
            const input = document.getElementById('chatInput');
            if (!input) return;
            const text = (input.value || '').trim();
            if (!text) return;
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                window.showToast('尚未连接到服务器，无法发送消息', 'warn');
                return;
            }
            // 使用JSON发送聊天消息，服务器会广播为二进制或JSON
            this.ws.send(JSON.stringify({ type: 'chatMessage', content: text }));
            input.value = '';
        } catch (e) {
            console.error('发送聊天消息失败:', e);
        }
    }

    // 聊天消息（全程 textContent 渲染，昵称与内容均为用户输入，防 XSS）
    addChatMessage(playerName, content, playerId) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const msg = document.createElement('div');
        msg.className = 'chat-message';
        const isSystem = !playerId || playerName === '系统';
        if (isSystem) {
            msg.classList.add('system');
            msg.textContent = content || '';
        } else {
            if (playerId === this.playerId) msg.classList.add('mine');
            const sender = document.createElement('span');
            sender.className = 'sender';
            sender.textContent = playerName || '玩家';
            const p = this.players.get(playerId);
            if (p && p.color) sender.style.color = p.color;
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = content || '';
            msg.append(sender, bubble);
        }
        container.appendChild(msg);
        // 只保留最近 60 条
        while (container.children.length > 60) container.removeChild(container.firstChild);
        // 滚动到底部
        container.scrollTop = container.scrollHeight;
    }

    // 角色头顶聊天气泡（画布绘制，天然免疫 XSS）
    setChatBubble(playerId, content) {
        if (!playerId || !content) return;
        const text = String(content).trim();
        if (!text || text.startsWith('/')) return; // 指令不冒泡
        const p = this.players.get(playerId);
        if (!p) return;
        p.chatBubble = { text: text.slice(0, 50), until: Date.now() + 4000 };
    }

    drawChatBubble(player) {
        const b = player.chatBubble;
        if (!b || b.until < Date.now()) return;
        const ctx = this.backCtx;
        const size = (this.gameConfig && this.gameConfig.PLAYER_SIZE) || 20;
        const cx = player.x + size / 2;

        ctx.save();
        ctx.font = '12px system-ui, sans-serif';
        // 文本换行（最多 2 行，超出加省略号）
        const maxW = 150;
        const lines = [];
        let cur = '';
        let truncated = false;
        for (const ch of b.text) {
            if (ctx.measureText(cur + ch).width > maxW) {
                lines.push(cur);
                cur = ch;
                if (lines.length === 2) { truncated = true; cur = ''; break; }
            } else {
                cur += ch;
            }
        }
        if (cur && lines.length < 2) lines.push(cur);
        if (truncated) lines[1] = lines[1].slice(0, -1) + '…';
        if (!lines.length) { ctx.restore(); return; }

        const lineH = 15;
        const w = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + 18;
        const h = lines.length * lineH + 11;
        let bx = cx - w / 2;
        bx = Math.max(4, Math.min(this.canvas.width - w - 4, bx));
        const by = player.y - 32 - h;

        // 尾声淡出
        const rem = b.until - Date.now();
        ctx.globalAlpha = Math.min(1, rem / 300);

        // 尾巴（先画，让气泡描边盖住接缝）
        ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
        ctx.strokeStyle = '#232842';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - 6, by + h - 2);
        ctx.lineTo(cx, by + h + 7);
        ctx.lineTo(cx + 6, by + h - 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 气泡体
        ctx.beginPath();
        ctx.roundRect(bx, by, w, h, 10);
        ctx.fill();
        ctx.stroke();
        // 补一块白色遮住尾巴顶部的描边接缝
        ctx.fillRect(cx - 5, by + h - 2.5, 10, 2);
        // 文本
        ctx.fillStyle = '#1f2536';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        lines.forEach((l, i) => ctx.fillText(l, bx + w / 2, by + 6 + i * lineH));
        ctx.restore();
    }

    handleMessage(message) {
        switch (message.type) {
            // ...

            case 'chatMessage':
                this.addChatMessage(message.playerName, message.content, message.playerId);
                this.setChatBubble(message.playerId, message.content);
                break;

            case 'killstreak': {
                const names = { 2: '双杀', 3: '三连杀', 4: '四连杀', 5: '五连杀' };
                const label = message.streak <= 5 ? names[message.streak] : `超神·${message.streak}连杀`;
                const mine = message.playerId === this.playerId;
                this.showStreakBanner(`${message.name} ${label}！`, message.streak >= 5 ? 'god' : mine ? 'mine' : '');
                if (window.gameSound) window.gameSound.streak(Math.min(6, message.streak));
                break;
            }

            case 'streakEnd':
                this.showStreakBanner(`${message.by} 终结了 ${message.name} 的 ${message.streak} 连杀`, 'end');
                if (window.gameSound) window.gameSound.streakEnd();
                break;

            case 'terrainRemove': {
                // 地形被摧毁：移除方块 + 木箱碎裂特效
                const ids = message.ids || [];
                this.terrain = (this.terrain || []).filter(b => !ids.includes(b.id));
                (message.breaks || []).forEach(p => {
                    this.effects.push(new Effect(p.x, p.y, 'crateBreak', 700));
                    if (window.gameSound) window.gameSound.crateBreak(this.volFor(p.x, p.y));
                });
                break;
            }

            case 'terrainSync':
                // 新一局恢复地形
                if (Array.isArray(message.terrain)) this.terrain = message.terrain;
                break;

            case 'explosion': {
                // 爆炸：视效 + 声音 + 距离衰减震屏
                this.effects.push(new Effect(message.x, message.y, 'explosion', 750, {
                    radius: message.radius || 90
                }));
                if (window.gameSound) window.gameSound.explosion(this.volFor(message.x, message.y));
                const me = this.players.get(this.playerId);
                if (me && typeof me.x === 'number') {
                    const d = Math.hypot(me.x - message.x, me.y - message.y);
                    this.addShake(Math.max(2, 13 - d / 45));
                }
                break;
            }

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
                this.updateMatchInfo();
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
                    const team = decoder.readUint8();
                    const shieldActive = decoder.readUint8() === 1;
                    const rapidActive = decoder.readUint8() === 1;
                    const damageActive = decoder.readUint8() === 1;
                    const wIdx = decoder.readUint8();
                    const wMag = decoder.readUint8();
                    const wRes = decoder.readUint8();
                    const wRel = decoder.readUint16();
                    const wG = decoder.readUint8();

                    // 若非快照且未提供昵称，则尝试复用已有昵称
                    if (!isSnapshot) {
                        const exist = this.players.get(id);
                        nickname = exist?.nickname || `Player ${id}`;
                    }

                    const pObj = {
                        id, nickname, x, y, angle, health, score, isAlive, color, team,
                        powerups: {
                            shield: { active: shieldActive, endTime: shieldActive ? nowForBuffs + defaultBuffMs : 0 },
                            rapidFire: { active: rapidActive, endTime: rapidActive ? nowForBuffs + defaultBuffMs : 0 },
                            damageBoost: { active: damageActive, endTime: damageActive ? nowForBuffs + defaultBuffMs : 0 }
                        }
                    };
                    this.applyWeaponNet(pObj, wIdx, wMag, wRes, wRel, wG);
                    players.push(pObj);
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
                    const kind = decoder.readUint8();
                    bullets.push({ id, x, y, vx, vy, ownerId, damage, kind });
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
                    const nowTs = Date.now();
                    players.forEach(p => {
                        p.targetX = p.x;
                        p.targetY = p.y;
                        p.lastServerX = p.x;
                        p.lastServerY = p.y;
                        p.lastServerUpdate = nowTs;
                        p.serverVx = 0;
                        p.serverVy = 0;
                        this.players.set(p.id, p);
                    });
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
                // 自愈：游戏已在进行但结算/开局弹窗还挂着（gameStarted消息丢失时的兜底）
                if (!isGameEnded) {
                    this.hideGameEndModal();
                    this.hideNewGameModal();
                }
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
                            const team = decoder.readUint8();
                            const wIdx = decoder.readUint8();
                            const wMag = decoder.readUint8();
                            const wRes = decoder.readUint8();
                            const wRel = decoder.readUint16();
                            const wG = decoder.readUint8();
                            const nowTs = Date.now();
                            const np = {
                                id,
                                nickname,
                                x,
                                y,
                                angle: angle100 / 100,
                                health,
                                score,
                                isAlive,
                                color,
                                team,
                                powerups: { shield: {active:false}, rapidFire:{active:false}, damageBoost:{active:false} },
                                targetX: x,
                                targetY: y,
                                lastServerX: x,
                                lastServerY: y,
                                lastServerUpdate: nowTs,
                                serverVx: 0,
                                serverVy: 0
                            };
                            this.applyWeaponNet(np, wIdx, wMag, wRes, wRel, wG);
                            this.players.set(id, np);
                        }
                    } else if (section === 0x02) { // changedPlayers
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readUint32();
                            const mask = decoder.readUint8();
                            const cur = this.players.get(id) || { id };
                            const factorSelf = 0.35;
                            const fSelf = factorSelf;
                            let nx, ny, nAngle;
                            if (mask & 0x01) nx = decoder.readUint16();
                            if (mask & 0x02) ny = decoder.readUint16();
                            if (mask & 0x04) nAngle = decoder.readUint16() / 100;
                            if (mask & 0x08) cur.health = decoder.readUint8();
                            if (mask & 0x10) cur.score = decoder.readUint16();
                            if (mask & 0x20) cur.isAlive = decoder.readUint8() === 1;
                            // 更新目标位置与服务器速度估计
                            const nowTs = Date.now();
                            const prevX = cur.lastServerX !== undefined ? cur.lastServerX : (cur.x !== undefined ? cur.x : nx);
                            const prevY = cur.lastServerY !== undefined ? cur.lastServerY : (cur.y !== undefined ? cur.y : ny);
                            if (nx !== undefined) cur.targetX = nx;
                            if (ny !== undefined) cur.targetY = ny;
                            const useX = (nx !== undefined) ? nx : prevX;
                            const useY = (ny !== undefined) ? ny : prevY;
                            const dt = Math.max(0, nowTs - (cur.lastServerUpdate || nowTs));
                            if (dt > 0 && (nx !== undefined || ny !== undefined)) {
                                cur.serverVx = (useX - prevX) / dt;
                                cur.serverVy = (useY - prevY) / dt;
                            }
                            cur.lastServerX = useX;
                            cur.lastServerY = useY;
                            cur.lastServerUpdate = nowTs;
                            // 仅本地玩家立即做一次纠偏；其他玩家留给按帧平滑处理
                            if (id === this.playerId) {
                                const lockWindow = 160;
                                const locked = (axis) => cur[`blockMove${axis}`] && (Date.now() - (cur.blockMoveAt || 0) < lockWindow);
                                if (nx !== undefined) {
                                    cur.x = locked('X') ? nx : this.correctSelfAxis(cur.x, nx);
                                }
                                if (ny !== undefined) {
                                    cur.y = locked('Y') ? ny : this.correctSelfAxis(cur.y, ny);
                                }
                                if (nAngle !== undefined) cur.angle = nAngle;
                            } else {
                                if (nAngle !== undefined) cur.angle = nAngle;
                            }
                            if (mask & 0x40) {
                                const now = Date.now();
                                cur.powerups = cur.powerups || { shield:{}, rapidFire:{}, damageBoost:{} };
                                // shield
                                const sActive = decoder.readUint8() === 1;
                                const sRem = decoder.readUint16();
                                cur.powerups.shield.active = sActive;
                                cur.powerups.shield.endTime = sActive ? now + sRem * 1000 : 0;
                                // rapid
                                const rActive = decoder.readUint8() === 1;
                                const rRem = decoder.readUint16();
                                cur.powerups.rapidFire.active = rActive;
                                cur.powerups.rapidFire.endTime = rActive ? now + rRem * 1000 : 0;
                                // damage
                                const dActive = decoder.readUint8() === 1;
                                const dRem = decoder.readUint16();
                                cur.powerups.damageBoost.active = dActive;
                                cur.powerups.damageBoost.endTime = dActive ? now + dRem * 1000 : 0;
                            }
                            if (mask & 0x80) { // 武器/弹药状态
                                const wIdx = decoder.readUint8();
                                const wMag = decoder.readUint8();
                                const wRes = decoder.readUint8();
                                const wRel = decoder.readUint16();
                                const wG = decoder.readUint8();
                                this.applyWeaponNet(cur, wIdx, wMag, wRes, wRel, wG);
                            }
                            this.players.set(id, cur);
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
                            const kind = decoder.readUint8();
                            if (!this.bullets.find(b => b.id === id)) {
                                this.bullets.push({ id, x, y, vx, vy, ownerId, damage: 25, kind });
                                if (ownerId !== this.playerId) {
                                    if (kind === 2) {
                                        // 手雷出手：轻抛掷声，不放枪口焰
                                        if (window.gameSound) window.gameSound.grenadeThrow(this.volFor(x, y) * 0.6);
                                    } else {
                                        this.remoteShotFx(x, y, vx, vy, ownerId);
                                    }
                                }
                            }
                        }
                    } else if (section === 0x13) { // removedBullets
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readString();
                            this.bullets = this.bullets.filter(b => b.id !== id);
                        }
                    } else if (section === 0x04) { // newPowerups
                        // 与服务端 encodeIncrementalUpdate 对齐：id(u32) x(u16) y(u16) typeId(u8)
                        const n = decoder.readUint16();
                        for (let i = 0; i < n; i++) {
                            const id = decoder.readUint32();
                            const x = decoder.readUint16();
                            const y = decoder.readUint16();
                            const typeId = decoder.readUint8();
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
                    const team = decoder.readUint8();
                    players.push({ id, nickname, score, isAlive, health, team });
                }
                if (!this._endSoundPlayed) {
                    this._endSoundPlayed = true;
                    if (window.gameSound) window.gameSound.gameEnd();
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
                this._endSoundPlayed = false;
                if (window.gameSound) window.gameSound.gameStart();
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
                const team = decoder.readUint8();
                const wIdx = decoder.readUint8();
                const wMag = decoder.readUint8();
                const wRes = decoder.readUint8();
                const wRel = decoder.readUint16();
                const wG = decoder.readUint8();
                const jp = {
                    id,
                    nickname,
                    x,
                    y,
                    angle: angle100 / 100,
                    health,
                    score,
                    isAlive,
                    color,
                    team,
                    powerups: { shield: {active:false}, rapidFire:{active:false}, damageBoost:{active:false} }
                };
                this.applyWeaponNet(jp, wIdx, wMag, wRes, wRel, wG);
                this.players.set(id, jp);
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
                this.addChatMessage(playerName, content, playerId);
                this.setChatBubble(playerId, content);
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
                    this.damageNumbers.push(new DamageNumber(
                        targetPlayer.x + 10, targetPlayer.y - 8, '-' + damage,
                        targetId === this.playerId ? '#ff6b6b' : '#ffd76b'
                    ));
                }
                if (targetId === this.playerId) {
                    if (window.gameSound) (isKill ? window.gameSound.death() : window.gameSound.hurt());
                    this.addShake(isKill ? 9 : 5);
                    this.triggerFlash('#e03131', isKill ? 0.30 : 0.16);
                    if (isKill) {
                        const killer = this.players.get(shooterId);
                        this.deathInfo = { killerId: shooterId, killerName: killer ? killer.nickname : '', at: Date.now() };
                    }
                } else if (shooterId === this.playerId) {
                    if (window.gameSound) (isKill ? window.gameSound.kill() : window.gameSound.hitConfirm());
                    // 击中标记（手感反馈）
                    if (targetPlayer) {
                        this.effects.push(new Effect(targetPlayer.x + 10, targetPlayer.y + 10, 'hitmarker', 220));
                    }
                    if (isKill) {
                        this.addShake(4);
                        this.triggerFlash('#ffffff', 0.12);
                        if (targetPlayer) {
                            this.effects.push(new Effect(targetPlayer.x + 10, targetPlayer.y + 10, 'kill', 600));
                            this.damageNumbers.push(new DamageNumber(
                                targetPlayer.x + 10, targetPlayer.y - 22, '+100', '#ffd76b'
                            ));
                        }
                    }
                } else if (targetPlayer && window.gameSound) {
                    window.gameSound.wallHit(this.volFor(targetPlayer.x, targetPlayer.y) * 0.5);
                }
                return;
            }

            // 子弹击中墙体
            if (msgType === MESSAGE_TYPES.BULLET_HIT_WALL) {
                const x = decoder.readFloat32();
                const y = decoder.readFloat32();
                const bulletId = decoder.readString();
                this.effects.push(new Effect(x, y, 'wallHit'));
                if (window.gameSound) window.gameSound.wallHit(this.volFor(x, y));
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
                if (playerId === this.playerId && window.gameSound) window.gameSound.respawn();
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
                if (playerId === this.playerId && window.gameSound) window.gameSound.pickup();
                const pickedUpPlayer = this.players.get(playerId);
                if (pickedUpPlayer) {
                    if (type === 'heal') {
                        this.damageNumbers.push(new DamageNumber(
                            pickedUpPlayer.x + 10, pickedUpPlayer.y - 8, '+HP', '#5dde9a'
                        ));
                        pickedUpPlayer.healFxUntil = Date.now() + 1400; // 治疗涌动特效
                    }
                    // 开箱揭示：内容色爆裂 + 光环 + 内容名浮字
                    const revealColor = ({
                        shield: '#9b59b6', rapid_fire: '#e67e22', damage_boost: '#e74c3c',
                        heal: '#2ecc71', weapon_smg: '#fbbf24', weapon_shotgun: '#fbbf24', weapon_sniper: '#fbbf24'
                    })[type] || '#fbbf24';
                    this.effects.push(new Effect(
                        pickedUpPlayer.x + 10, pickedUpPlayer.y + 10, 'crate', 900,
                        { color: revealColor, label: this.powerupName(type) }
                    ));
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
            case 5: return 'weapon_smg';
            case 6: return 'weapon_shotgun';
            case 7: return 'weapon_sniper';
            default: return 'unknown';
        }
    }

    // ---------- 武器辅助 ----------
    weaponIdName(idx) {
        const ids = (this.gameConfig && this.gameConfig.WEAPON_IDS) || ['rifle', 'smg', 'shotgun', 'sniper'];
        return ids[idx] || 'rifle';
    }

    weaponConf(idx) {
        const W = (this.gameConfig && this.gameConfig.WEAPONS) || {};
        return W[this.weaponIdName(idx)] || { name: '步枪', fireRate: 200, magSize: 30, reloadMs: 1500 };
    }

    // 应用来自服务器的武器状态（w=武器索引 mag=弹夹 res=备弹(255=∞) rel=换弹剩余ms g=手雷数）
    applyWeaponNet(p, w, mag, res, rel, g) {
        p.weapon = w;
        p.mag = mag;
        p.reserve = res;
        if (g !== undefined) p.grenades = g;
        if (rel > 0) {
            p.reloadEnd = Date.now() + rel;
            p.reloadTotal = this.weaponConf(w).reloadMs || 1500;
        } else {
            p.reloadEnd = 0;
        }
    }

    // 死亡反馈：被谁击败 + 复活倒计时（昵称 textContent 防 XSS）
    updateDeathOverlay() {
        const overlay = document.getElementById('deathOverlay');
        if (!overlay || !this.playerId) return;
        const me = this.players.get(this.playerId);
        const dead = me && !me.isAlive && this.deathInfo;
        if (!dead) {
            overlay.classList.add('hidden');
            return;
        }
        overlay.classList.remove('hidden');
        const title = document.getElementById('deathTitle');
        if (title) {
            title.textContent = this.deathInfo.killerName
                ? `被 ${this.deathInfo.killerName} 击败了`
                : '你被击败了';
        }
        const cd = document.getElementById('deathCountdown');
        if (cd) {
            const total = (this.gameConfig && this.gameConfig.RESPAWN_TIME) || 3000;
            cd.textContent = Math.max(0, Math.ceil((total - (Date.now() - this.deathInfo.at)) / 1000));
        }
    }

    // 连杀播报横幅（昵称为用户输入，textContent 防 XSS）
    showStreakBanner(text, cls = '') {
        const el = document.getElementById('streakBanner');
        if (!el) return;
        el.textContent = text;
        el.className = 'show' + (cls ? ' ' + cls : '');
        clearTimeout(this._streakBannerTimer);
        this._streakBannerTimer = setTimeout(() => { el.className = ''; }, 2600);
    }

    // 弹药 HUD（每帧刷新）
    updateAmmoHUD() {
        const nameEl = document.getElementById('weaponName');
        const magEl = document.getElementById('ammoMag');
        const resEl = document.getElementById('ammoReserve');
        if (!nameEl || !magEl || !resEl || !this.playerId) return;
        const me = this.players.get(this.playerId);
        if (!me) return;
        // 感染者：显示利爪，无弹药/手雷概念
        if (this.gameConfig && this.gameConfig.GAME_MODE === 'infect' && me.team === 1) {
            nameEl.textContent = '感染者';
            magEl.textContent = '利爪';
            resEl.textContent = '';
            const tk = document.getElementById('reloadTrack');
            if (tk) tk.classList.add('hidden');
            const gz = document.getElementById('grenadeCount');
            if (gz) gz.textContent = '—';
            return;
        }

        const conf = this.weaponConf(me.weapon || 0);
        const now = Date.now();
        const reloading = !!(me.reloadEnd && me.reloadEnd > now);

        nameEl.textContent = reloading ? '换弹中' : (conf.name || '步枪');
        magEl.textContent = me.mag !== undefined ? me.mag : (conf.magSize || 30);
        resEl.textContent = '/ ' + ((me.reserve === undefined || me.reserve === 255) ? '∞' : me.reserve);

        const uiRoot = document.getElementById('ui');
        if (uiRoot) uiRoot.classList.toggle('reloading', reloading);
        const track = document.getElementById('reloadTrack');
        const fill = document.getElementById('reloadFill');
        if (track) track.classList.toggle('hidden', !reloading);
        if (reloading && fill) {
            const total = me.reloadTotal || conf.reloadMs || 1500;
            const pct = Math.max(0, Math.min(100, (1 - (me.reloadEnd - now) / total) * 100));
            fill.style.width = pct + '%';
        }

        // 手雷数
        const gEl = document.getElementById('grenadeCount');
        if (gEl) {
            const g = me.grenades !== undefined ? me.grenades : 2;
            gEl.textContent = '×' + g;
            gEl.parentElement.classList.toggle('empty', g <= 0);
        }
    }

    // 道具箱内容的中文名（拾取揭示用）
    powerupName(type) {
        switch (type) {
            case 'shield': return '护盾';
            case 'rapid_fire': return '急速射击';
            case 'damage_boost': return '伤害强化';
            case 'heal': return '满血恢复';
            case 'weapon_smg': return '冲锋枪';
            case 'weapon_shotgun': return '霰弹枪';
            case 'weapon_sniper': return '狙击枪';
            default: return '道具';
        }
    }

    // 根据道具类型返回颜色与图标，确保视觉一致
    getPowerupVisual(type) {
        switch (type) {
            case 'shield':
                return { color: '#a78bfa', icon: '◆' };
            case 'rapid_fire':
            case 'rapidFire':
                return { color: '#fbbf24', icon: '▲' };
            case 'damage_boost':
            case 'damageBoost':
                return { color: '#f87171', icon: '●' };
            case 'heal':
                return { color: '#34d399', icon: '+' };
            default:
                return { color: '#95a5a6', icon: '?' };
        }
    }

    updatePlayersFromServer(serverPlayers) {
        serverPlayers.forEach(serverPlayer => {
            const localPlayer = this.players.get(serverPlayer.id);
            if (localPlayer) {
                const nowTs = Date.now();
                if (serverPlayer.id === this.playerId) {
                    // 本地玩家：做一次较大的纠偏；若当前轴被阻挡，则直接对齐该轴，避免“推进-回弹”抖动
                    const factorSelf = 0.35;
                    const lockWindow = 160; // ms 内视为仍在推墙
                    const locked = (axis) => localPlayer[`blockMove${axis}`] && (Date.now() - (localPlayer.blockMoveAt || 0) < lockWindow);
                    if (typeof serverPlayer.x === 'number') {
                        localPlayer.x = locked('X') ? serverPlayer.x : this.correctSelfAxis(localPlayer.x, serverPlayer.x);
                    }
                    if (typeof serverPlayer.y === 'number') {
                        localPlayer.y = locked('Y') ? serverPlayer.y : this.correctSelfAxis(localPlayer.y, serverPlayer.y);
                    }
                } else {
                    // 他人：只更新目标与服务器速度估计，具体位置交给按帧平滑
                    const prevX = localPlayer.lastServerX !== undefined ? localPlayer.lastServerX : (localPlayer.x ?? serverPlayer.x);
                    const prevY = localPlayer.lastServerY !== undefined ? localPlayer.lastServerY : (localPlayer.y ?? serverPlayer.y);
                    if (typeof serverPlayer.x === 'number') localPlayer.targetX = serverPlayer.x;
                    if (typeof serverPlayer.y === 'number') localPlayer.targetY = serverPlayer.y;
                    const useX = (typeof serverPlayer.x === 'number') ? serverPlayer.x : prevX;
                    const useY = (typeof serverPlayer.y === 'number') ? serverPlayer.y : prevY;
                    const dt = Math.max(0, nowTs - (localPlayer.lastServerUpdate || nowTs));
                    if (dt > 0 && (serverPlayer.x !== undefined || serverPlayer.y !== undefined)) {
                        localPlayer.serverVx = (useX - prevX) / dt;
                        localPlayer.serverVy = (useY - prevY) / dt;
                    }
                    localPlayer.lastServerX = useX;
                    localPlayer.lastServerY = useY;
                    localPlayer.lastServerUpdate = nowTs;
                }
                if (typeof serverPlayer.angle === 'number') {
                    localPlayer.angle = serverPlayer.angle;
                }
                // 其他属性
                localPlayer.score = serverPlayer.score;
                localPlayer.health = serverPlayer.health;
                localPlayer.isAlive = serverPlayer.isAlive;
                // 队伍与颜色（回合切换分队模式时会变化）
                if (serverPlayer.team !== undefined) localPlayer.team = serverPlayer.team;
                if (serverPlayer.color) localPlayer.color = serverPlayer.color;
                // 武器状态
                if (serverPlayer.weapon !== undefined) {
                    localPlayer.weapon = serverPlayer.weapon;
                    localPlayer.mag = serverPlayer.mag;
                    localPlayer.reserve = serverPlayer.reserve;
                    localPlayer.reloadEnd = serverPlayer.reloadEnd || 0;
                    if (serverPlayer.grenades !== undefined) localPlayer.grenades = serverPlayer.grenades;
                    if (serverPlayer.reloadTotal) localPlayer.reloadTotal = serverPlayer.reloadTotal;
                }
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
            } else {
                // 新玩家：初始化并设置目标位置
                const nowTs = Date.now();
                const p = {
                    id: serverPlayer.id,
                    nickname: serverPlayer.nickname,
                    x: serverPlayer.x,
                    y: serverPlayer.y,
                    angle: serverPlayer.angle,
                    health: serverPlayer.health,
                    score: serverPlayer.score,
                    isAlive: serverPlayer.isAlive,
                    color: serverPlayer.color,
                    powerups: serverPlayer.powerups || { shield:{active:false}, rapidFire:{active:false}, damageBoost:{active:false} },
                    targetX: serverPlayer.x,
                    targetY: serverPlayer.y,
                    lastServerX: serverPlayer.x,
                    lastServerY: serverPlayer.y,
                    lastServerUpdate: nowTs,
                    serverVx: 0,
                    serverVy: 0
                };
                this.players.set(serverPlayer.id, p);
            }
        });
        this.updateScoreboard();
    }

    handleIncrementalUpdate(message) {
        // 自愈：游戏已在进行但结算/开局弹窗还挂着
        if (message.isGameEnded === false) {
            this.hideGameEndModal();
            this.hideNewGameModal();
        }

        // 处理新玩家
        if (message.newPlayers) {
            message.newPlayers.forEach(player => {
                if (player.weapon !== undefined) {
                    this.applyWeaponNet(player, player.weapon, player.mag, player.reserve, player.reloadRem || 0, player.grenades);
                }
                this.players.set(player.id, player);
            });
        }

        // 处理玩家变化
        if (message.changedPlayers) {
            message.changedPlayers.forEach(changes => {
                const player = this.players.get(changes.id);
                if (player) {
                    // 武器状态单独应用（JSON 路径）
                    if (changes.weaponState) {
                        const ws = changes.weaponState;
                        this.applyWeaponNet(player, ws.w, ws.mag, ws.res, ws.rel, ws.g);
                    }
                    const { weaponState, ...rest } = changes;
                    Object.assign(player, rest);
                }
            });
        }
        
        // 处理新子弹
        if (message.newBullets) {
            message.newBullets.forEach(bullet => {
                // 检查是否已存在此子弹，避免重复添加
                if (!this.bullets.find(b => b.id === bullet.id)) {
                    this.bullets.push(bullet);
                    if (bullet.ownerId !== this.playerId) {
                        this.remoteShotFx(bullet.x, bullet.y, bullet.vx || 0, bullet.vy || 0, bullet.ownerId);
                    }
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

        const allPlayers = Array.from(this.players.values());
        const isTeamGame = allPlayers.some(p => p.team === 1 || p.team === 2);

        const appendPlayerRow = (player) => {
            const playerDiv = document.createElement('div');
            playerDiv.className = 'player-score';
            if (player.id === this.playerId) {
                playerDiv.classList.add('current-player');
            }
            // 昵称是用户输入，必须用 textContent 防 XSS
            const nameSpan = document.createElement('span');
            nameSpan.textContent = player.nickname;
            const scoreSpan = document.createElement('span');
            scoreSpan.textContent = player.score;
            playerDiv.append(nameSpan, scoreSpan);
            playersList.appendChild(playerDiv);
        };

        if (isTeamGame) {
            // 分队计分板：分组显示，组头显示团队总分（感染模式用感染者/幸存者标签）
            const isInfect = this.gameConfig && this.gameConfig.GAME_MODE === 'infect';
            (isInfect ? [
                { team: 1, name: '感染者', color: '#2ecc71' },
                { team: 2, name: '幸存者', color: '#3498db' }
            ] : [
                { team: 1, name: '红队', color: '#e74c3c' },
                { team: 2, name: '蓝队', color: '#3498db' }
            ]).forEach(meta => {
                const members = allPlayers
                    .filter(p => p.team === meta.team)
                    .sort((a, b) => b.score - a.score);
                const total = members.reduce((sum, p) => sum + (p.score || 0), 0);
                const header = document.createElement('div');
                header.className = 'team-score-header';
                header.style.color = meta.color;
                header.style.borderLeftColor = meta.color;
                header.innerHTML = `
                    <span>${meta.name}</span>
                    <span>${total}</span>
                `;
                playersList.appendChild(header);
                members.forEach(appendPlayerRow);
            });
            // 尚未分队的玩家兜底显示
            allPlayers
                .filter(p => p.team !== 1 && p.team !== 2)
                .sort((a, b) => b.score - a.score)
                .forEach(appendPlayerRow);
        } else {
            allPlayers
                .sort((a, b) => b.score - a.score)
                .forEach(appendPlayerRow);
        }
    }

    // 更新HUD上的地图/模式信息（来自JOINED的配置）
    updateMatchInfo() {
        const el = document.getElementById('matchInfo');
        if (!el || !this.gameConfig) return;
        const mapName = this.gameConfig.MAP_NAME || '经典竞技场';
        const mode = this.gameConfig.GAME_MODE === 'infect' ? '感染模式'
            : this.gameConfig.TEAM_MODE ? '红蓝对抗' : '个人混战';
        el.textContent = `${mapName} · ${mode}`;
    }

    updateGameTimer(remainingTime) {
        const timerElement = document.getElementById('timerValue');
        if (!timerElement) return;
        const seconds = Math.max(0, Math.ceil(remainingTime / 1000));
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        timerElement.textContent = `${m}:${String(s).padStart(2, '0')}`;
        // 剩 30 秒变金、10 秒变红脉冲
        const box = document.getElementById('gameTimer');
        if (box) {
            box.classList.toggle('critical', seconds <= 10);
            box.classList.toggle('low', seconds > 10 && seconds <= 30);
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
        
        // 根据武器类型选择强调色
        const weaponColor = killInfo.weapon === '近战' ? '#f87171' : '#fbbf24';
        
        // 昵称是用户输入，必须用 textContent 防 XSS
        const killerSpan = document.createElement('span');
        killerSpan.className = 'killer';
        killerSpan.textContent = killInfo.killer;
        const weaponSpan = document.createElement('span');
        weaponSpan.className = 'weapon';
        weaponSpan.style.color = weaponColor;
        weaponSpan.textContent = killInfo.weapon;
        const victimSpan = document.createElement('span');
        victimSpan.className = 'victim';
        victimSpan.textContent = killInfo.victim;
        killNotification.append(killerSpan, weaponSpan, victimSpan);

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
        const isTeamGame = players.some(p => p.team === 1 || p.team === 2);

        // 分队模式：先显示团队胜负横幅
        if (isTeamGame) {
            const totals = { 1: 0, 2: 0 };
            players.forEach(p => {
                if (p.team === 1 || p.team === 2) totals[p.team] += p.score || 0;
            });
            let title, titleColor;
            if (totals[1] === totals[2]) {
                title = '平局';
                titleColor = '#f1c40f';
            } else if (totals[1] > totals[2]) {
                title = '红队获胜';
                titleColor = '#e74c3c';
            } else {
                title = '蓝队获胜';
                titleColor = '#3498db';
            }
            const banner = document.createElement('div');
            banner.className = 'team-result-banner';
            banner.innerHTML = `
                <div class="team-result-title" style="color: ${titleColor}">${title}</div>
                <div class="team-result-score">
                    <span style="color: #e74c3c">红队 ${totals[1]}</span>
                    <span class="team-result-vs">:</span>
                    <span style="color: #3498db">${totals[2]} 蓝队</span>
                </div>
            `;
            finalScores.appendChild(banner);
        }

        const sortedPlayers = players.sort((a, b) => b.score - a.score);

        sortedPlayers.forEach((player, index) => {
            const scoreItem = document.createElement('div');
            scoreItem.className = 'score-item';
            const teamColor = player.team === 1 ? '#e74c3c' : player.team === 2 ? '#3498db' : '';
            // 昵称是用户输入，必须用 textContent 防 XSS
            const nameSpan = document.createElement('span');
            if (teamColor) nameSpan.style.color = teamColor;
            nameSpan.textContent = `${index + 1}. ${player.nickname}`;
            const ptsSpan = document.createElement('span');
            ptsSpan.textContent = `${player.score} 分`;
            scoreItem.append(nameSpan, ptsSpan);
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

        // 感染者近战为利爪撕裂（专属特效与音效）
        const attackerP = this.players.get(message.attackerId);
        const isClaw = this.gameConfig && this.gameConfig.GAME_MODE === 'infect' &&
            attackerP && attackerP.team === 1;
        if (window.gameSound) {
            if (isClaw) window.gameSound.claw(this.volFor(message.x, message.y));
            else window.gameSound.melee(this.volFor(message.x, message.y));
        }
        if (message.targetId && message.damage > 0) {
            const meleeTarget = this.players.get(message.targetId);
            if (meleeTarget) {
                this.damageNumbers.push(new DamageNumber(
                    meleeTarget.x + 10, meleeTarget.y - 8, '-' + message.damage,
                    message.targetId === this.playerId ? '#ff6b6b' : '#ffd76b'
                ));
            }
        }
        if (message.targetId === this.playerId && message.damage > 0) {
            if (window.gameSound) (message.isKill ? window.gameSound.death() : window.gameSound.hurt());
            this.addShake(message.isKill ? 9 : 6);
            this.triggerFlash('#e03131', message.isKill ? 0.30 : 0.18);
        } else if (message.attackerId === this.playerId && message.isKill) {
            if (window.gameSound) window.gameSound.kill();
            this.addShake(4);
            this.triggerFlash('#ffffff', 0.12);
        }

        // 添加挥击效果（以玩家中心为轴；感染者为利爪撕裂）
        const psize = (this.gameConfig && this.gameConfig.PLAYER_SIZE) || 20;
        const clawAttack = this.gameConfig && this.gameConfig.GAME_MODE === 'infect' &&
            attacker.team === 1;
        this.knifeSwingEffects.push(new KnifeSwingEffect(
            attacker.x + psize / 2, attacker.y + psize / 2,
            message.targetX, message.targetY,
            340, { claw: clawAttack }
        ));

        // 如果击中了目标，添加额外特效
        if (message.targetId && message.isKill) {
            const target = this.players.get(message.targetId);
            if (target) {
                // 添加击杀特效
                this.effects.push(new Effect(target.x, target.y, 'hit'));
            }
        }
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

    // 道具箱：2.5D 悬浮补给箱（武器箱金木色/增益箱青蓝色，具体内容拾取时揭示）
    drawPowerup(powerup) {
        if (!powerup) return;
        const ctx = this.backCtx;
        const s = 22; // 箱体边长
        const time = Date.now();
        const bob = Math.sin(time * 0.003 + (powerup.id % 10)) * 2.5; // 悬浮起伏
        const cx = powerup.x + s / 2;
        const baseY = powerup.y + s / 2;
        const topY = baseY - 6 + bob; // 箱顶中心
        const ex = 7; // 挤出高度

        // 按类别配色
        const isWeapon = typeof powerup.type === 'string' && powerup.type.startsWith('weapon_');
        const P = isWeapon
            ? { ring: '#fbbf24', side: '#3d3325', topA: '#8a6f3d', topB: '#5d4a29', lid: 'rgba(251, 191, 36, 0.65)', corner: '#c9a75c', glyph: '#ffe9b3', mark: '武' }
            : { ring: '#4dd0e1', side: '#1f3d44', topA: '#3f7d8c', topB: '#295660', lid: 'rgba(77, 208, 225, 0.65)', corner: '#7fd3e0', glyph: '#d9f6fb', mark: '+' };

        ctx.save();

        // 地面光圈（呼吸脉动）
        const pulse = 0.5 + Math.sin(time * 0.004 + powerup.id) * 0.2;
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = P.ring;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(cx, baseY + s / 2 + 3, s * 0.75, s * 0.28, 0, 0, Math.PI * 2);
        ctx.stroke();
        // 投影
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.ellipse(cx, baseY + s / 2 + 3, s * 0.55 - bob * 0.06 * s, s * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();

        // 箱体（2.5D 挤出：亮顶面 + 暗侧面）
        ctx.globalAlpha = 1;
        const x0 = cx - s / 2, y0 = topY - s / 2;
        // 侧面
        ctx.fillStyle = P.side;
        ctx.fillRect(x0, y0 + s - ex, s, ex);
        // 顶面
        const topGrad = ctx.createLinearGradient(x0, y0 - ex, x0, y0 + s - ex);
        topGrad.addColorStop(0, P.topA);
        topGrad.addColorStop(1, P.topB);
        ctx.fillStyle = topGrad;
        ctx.fillRect(x0, y0 - ex, s, s);
        // 描边与箱盖缝
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 0.5, y0 - ex + 0.5, s - 1, s - 1);
        ctx.strokeStyle = P.lid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, y0 - ex + s * 0.32);
        ctx.lineTo(x0 + s, y0 - ex + s * 0.32);
        ctx.stroke();
        // 金属包角
        ctx.fillStyle = P.corner;
        const c = 3.5;
        ctx.fillRect(x0, y0 - ex, c, c);
        ctx.fillRect(x0 + s - c, y0 - ex, c, c);
        ctx.fillRect(x0, y0 - ex + s - c, c, c);
        ctx.fillRect(x0 + s - c, y0 - ex + s - c, c, c);

        // 中央类别标记（武=武器箱 +=增益箱）
        ctx.fillStyle = P.glyph;
        ctx.font = `bold ${Math.round(s * (isWeapon ? 0.55 : 0.68))}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(P.mark, cx, y0 - ex + s * 0.6);

        ctx.restore();
    }

    startGameLoop() {
        let lastFrameTime = 0;
        const targetFrameTime = 1000 / 60; // 60fps
        
        const gameLoop = (timestamp) => {
            // rAF 已与显示器刷新率同步，直接每帧更新渲染（门控会导致周期性跳帧）
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

        // 按住左键连发 + 弹药HUD + 死亡反馈
        this.handleAutoFire();
        this.updateAmmoHUD();
        this.updateDeathOverlay();

        // 他人按帧平滑靠拢 + 轻量外推（减少观众端漂移感）
        const nowMs = Date.now();
        const dtMs = Math.max(0, deltaTime);
        this.players.forEach((p, id) => {
            if (id === this.playerId) return;
            if (!p) return;
            // 初始化目标与时间戳
            if (p.targetX === undefined) p.targetX = p.x ?? 0;
            if (p.targetY === undefined) p.targetY = p.y ?? 0;
            if (p.lastServerUpdate === undefined) p.lastServerUpdate = nowMs;
            if (p.serverVx === undefined) p.serverVx = 0;
            if (p.serverVy === undefined) p.serverVy = 0;
            
            // 基于服务器速度的短时外推
            let toX = p.targetX;
            let toY = p.targetY;
            const since = Math.max(0, nowMs - p.lastServerUpdate);
            if (since > this.extrapolationDelayMs && since <= this.extrapolationMaxMs) {
                toX += p.serverVx * since;
                toY += p.serverVy * since;
            }
            
            // 按帧平滑靠拢
            const prevX = p.x;
            const prevY = p.y;
            if (typeof p.x === 'number') p.x += (toX - p.x) * this.otherFrameLerp;
            else p.x = toX;
            if (typeof p.y === 'number') p.y += (toY - p.y) * this.otherFrameLerp;
            else p.y = toY;
            
            // 更新用于渲染拖尾的速度（每帧位移）
            if (prevX !== undefined && prevY !== undefined) {
                p.vx = p.x - prevX;
                p.vy = p.y - prevY;
            }
        });
        
        // 更新子弹
        this.bullets = this.bullets.filter(bullet => {
            // 手雷：本地也模拟撞墙/边界停驻，消失由服务器 removedBullets 控制
            if (bullet.kind === 2) {
                if (bullet.vx || bullet.vy) {
                    const nx = bullet.x + bullet.vx;
                    const ny = bullet.y + bullet.vy;
                    if (nx <= 6 || nx >= this.canvas.width - 6 ||
                        ny <= 6 || ny >= this.canvas.height - 6 ||
                        this.checkTerrainCollisionClient(nx - 3, ny - 3, 6, 6)) {
                        bullet.vx = 0;
                        bullet.vy = 0;
                    } else {
                        bullet.x = nx;
                        bullet.y = ny;
                    }
                    // 落地扬尘（停驻瞬间一次）
                    if (!bullet.vx && !bullet.vy && !bullet.landed) {
                        bullet.landed = true;
                        for (let i = 0; i < 5; i++) {
                            const a = Math.random() * Math.PI * 2;
                            this.trailParticles.push(new Particle(
                                bullet.x, bullet.y + 3,
                                Math.cos(a) * (0.5 + Math.random()), -0.4 - Math.random() * 0.6,
                                'rgba(170, 180, 200, 0.45)', 18 + ((Math.random() * 8) | 0),
                                1.5 + Math.random() * 1.5, { gravity: 0.05 }
                            ));
                        }
                    }
                }
                return true;
            }
            bullet.x += bullet.vx;
            bullet.y += bullet.vy;

            // 火箭弹持续烟迹
            if (bullet.kind === 1 && Math.random() < 0.7 && this.trailParticles.length < 260) {
                this.trailParticles.push(new Particle(
                    bullet.x - bullet.vx * 1.2 + (Math.random() - 0.5) * 2,
                    bullet.y - bullet.vy * 1.2 + (Math.random() - 0.5) * 2,
                    (Math.random() - 0.5) * 0.4, -0.25 - Math.random() * 0.3,
                    Math.random() < 0.3 ? 'rgba(255, 176, 90, 0.55)' : 'rgba(150, 158, 175, 0.5)',
                    20 + ((Math.random() * 14) | 0), 2 + Math.random() * 2.2
                ));
            }

            // 检查子弹是否超出边界
            return bullet.x > 0 && bullet.x < this.canvas.width &&
                   bullet.y > 0 && bullet.y < this.canvas.height;
        });
        
        // 更新特效
        this.effects = this.effects.filter(effect => {
            effect.update();
            return !effect.isDead();
        });

        // 更新松散粒子（烟迹/尘土）
        this.trailParticles = this.trailParticles.filter(p => {
            p.update();
            return !p.isDead();
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

        // 更新伤害飘字
        this.damageNumbers = this.damageNumbers.filter(d => {
            d.update();
            return !d.isDead();
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

        // 对角归一：保持对角速度与单轴一致，减少贴墙时的穿插抖动
        if (dx !== 0 && dy !== 0) {
            const inv = 1 / Math.sqrt(2);
            dx *= inv;
            dy *= inv;
        }

        // 触屏摇杆：矢量输入（模长已 ≤1），覆盖键盘
        if (this.touchMove && (Math.abs(this.touchMove.x) > 0.14 || Math.abs(this.touchMove.y) > 0.14)) {
            dx = this.touchMove.x * speed;
            dy = this.touchMove.y * speed;
        }

        // 计算角度（无论是否移动都要更新）
        const playerSize = this.gameConfig.PLAYER_SIZE || 20;

        // 触屏且未按开火时，朝向跟随移动方向
        if (this.isTouch && !this.mouseDown && (dx || dy)) {
            this.mouse.x = player.x + playerSize / 2 + (dx / speed) * 140;
            this.mouse.y = player.y + playerSize / 2 + (dy / speed) * 140;
        }
        const angle = Math.atan2(this.mouse.y - (player.y + playerSize / 2), 
                               this.mouse.x - (player.x + playerSize / 2));
        
        // 只更新角度，不更新位置（等待服务器确认）
        player.angle = angle;
        
        // 检查是否需要发送数据到服务器（频率限制）
        if (currentTime - this.lastMoveUpdate >= this.moveUpdateInterval) {
            // 先计算本地可行走的新位置（带本地碰撞预判 + 轴向分离）
            const oldX = player.x;
            const oldY = player.y;
            const margin = (this.gameConfig && this.gameConfig.TERRAIN_SIZE) ? this.gameConfig.TERRAIN_SIZE : 40;
            const clampX = (x) => Math.max(margin, Math.min(this.canvas.width - margin - playerSize, x));
            const clampY = (y) => Math.max(margin, Math.min(this.canvas.height - margin - playerSize, y));

            // 目标位移
            let wantX = clampX(player.x + dx);
            let wantY = clampY(player.y + dy);

            // 轴向分离碰撞检测（与服务器一致），避免本地穿入导致反复回弹
            let finalX = oldX;
            let finalY = oldY;
            if (dx !== 0) {
                const tryX = clampX(oldX + dx);
                if (!this.checkTerrainCollisionClient(tryX, oldY, playerSize, playerSize)) {
                    finalX = tryX;
                }
            }
            if (dy !== 0) {
                const tryY = clampY(oldY + dy);
                if (!this.checkTerrainCollisionClient(finalX, tryY, playerSize, playerSize)) {
                    finalY = tryY;
                }
            }

            // 标记被墙体阻挡的轴，用于后续收到服务器位置时按轴对齐（避免抖动）
            const blockedX = (dx !== 0) && Math.abs(finalX - oldX) < 1e-6;
            const blockedY = (dy !== 0) && Math.abs(finalY - oldY) < 1e-6;
            player.blockMoveX = blockedX;
            player.blockMoveY = blockedY;
            player.blockMoveAt = currentTime;
            if (!blockedX && dx === 0) player.blockMoveX = false;
            if (!blockedY && dy === 0) player.blockMoveY = false;

            // 检查是否有实际变化
            const hasPositionChange = (Math.abs(finalX - oldX) > 0.001 || Math.abs(finalY - oldY) > 0.001);
            const hasAngleChange = Math.abs(angle - (player.lastServerAngle || 0)) > 0.02; // 更小的角度变化阈值
            
            if (hasPositionChange || hasAngleChange) {
                // 发送二进制MOVE
                const enc = new BinaryEncoder().init(32);
                enc.writeUint8(MESSAGE_TYPES.MOVE);
                enc.writeFloat32(hasPositionChange ? finalX : oldX);
                enc.writeFloat32(hasPositionChange ? finalY : oldY);
                enc.writeFloat32(angle);
                this.ws.send(enc.getBuffer());
                
                // 本地乐观应用（预测）
                if (hasPositionChange) {
                    player.x = finalX;
                    player.y = finalY;
                }
                
                // 记录发送时间和角度
                this.lastMoveUpdate = currentTime;
                player.lastServerAngle = angle;
            }
        }
    }

    // 自身位置纠偏：带死区，避免服务器量化回包造成的抖动/拉扯
    correctSelfAxis(cv, nv) {
        if (cv === undefined || cv === null) return nv;
        const d = nv - cv;
        const ad = Math.abs(d);
        if (ad > 32) return nv;          // 偏差过大（被墙挡/被修正），直接对齐
        if (ad > 3) return cv + d * 0.3; // 温和纠偏
        return cv;                        // 量化噪声，忽略
    }

    // 本地AABB碰撞检测（客户端侧，使用服务端下发的terrain）
    checkTerrainCollisionClient(x, y, w, h) {
        if (!this.terrain || this.terrain.length === 0) return false;
        for (let i = 0; i < this.terrain.length; i++) {
            const t = this.terrain[i];
            // 与服务端一致：所有地形块均视为碰撞体
            if (this._aabbIntersect(x, y, w, h, t.x, t.y, t.width, t.height)) {
                return true;
            }
        }
        return false;
    }

    _aabbIntersect(ax, ay, aw, ah, bx, by, bw, bh) {
        return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    }

    // 按住左键连发：按当前武器射速节流，空仓/换弹时播放空击声
    handleAutoFire() {
        if (!this.mouseDown || !this.playerId) return;
        const me = this.players.get(this.playerId);
        if (!me || !me.isAlive) return;
        const now = Date.now();
        const conf = this.weaponConf(me.weapon || 0);
        let rate = conf.fireRate || 200;
        if (me.powerups && me.powerups.rapidFire && me.powerups.rapidFire.active) {
            rate = Math.floor(rate * 0.5);
        }
        // 感染模式：感染者的"开火"是近战利爪
        if (this.gameConfig && this.gameConfig.GAME_MODE === 'infect' && me.team === 1) {
            if (now - (this.lastClientShot || 0) < 1000) return;
            this.lastClientShot = now;
            this.meleeAttack();
            return;
        }
        if (now - (this.lastClientShot || 0) < rate) return;
        if ((me.reloadEnd && me.reloadEnd > now) || (me.mag !== undefined && me.mag <= 0)) {
            if (now - (this.lastEmptyClick || 0) > 300) {
                this.lastEmptyClick = now;
                if (window.gameSound) window.gameSound.emptyClick();
            }
            return;
        }
        this.lastClientShot = now;
        this.shoot();
        // 本地预测弹药消耗，让 HUD 即时反馈（服务器状态会覆盖校正）
        if (me.mag !== undefined) me.mag = Math.max(0, me.mag - 1);
    }

    // G 键投掷手雷（朝准星方向，服务器权威判定）
    sendGrenade() {
        const me = this.players.get(this.playerId);
        if (!me || !me.isAlive || !this.ws) return;
        // 感染者没有手雷
        if (this.gameConfig && this.gameConfig.GAME_MODE === 'infect' && me.team === 1) return;
        const now = Date.now();
        if (now - (this.lastGrenadeSent || 0) < 1000) return;
        if ((me.grenades | 0) <= 0) {
            this.lastGrenadeSent = now;
            if (window.gameSound) window.gameSound.emptyClick();
            return;
        }
        this.lastGrenadeSent = now;
        const enc = new BinaryEncoder().init(24);
        enc.writeUint8(MESSAGE_TYPES.GRENADE);
        enc.writeFloat32(this.mouse.x);
        enc.writeFloat32(this.mouse.y);
        this.ws.send(enc.getBuffer());
        me.grenades = Math.max(0, (me.grenades | 0) - 1); // 本地预测
        if (window.gameSound) window.gameSound.grenadeThrow(1);
    }

    sendReload() {
        const me = this.players.get(this.playerId);
        if (!me || !me.isAlive || !this.ws) return;
        const now = Date.now();
        if (me.reloadEnd && me.reloadEnd > now) return;
        const conf = this.weaponConf(me.weapon || 0);
        if (me.mag !== undefined && me.mag >= (conf.magSize || 30)) return;
        const enc = new BinaryEncoder().init(4);
        enc.writeUint8(MESSAGE_TYPES.RELOAD);
        this.ws.send(enc.getBuffer());
        // 本地预测换弹开始（服务器状态会校正）
        me.reloadEnd = now + (conf.reloadMs || 1500);
        me.reloadTotal = conf.reloadMs || 1500;
        if (window.gameSound) window.gameSound.reload();
    }

    shoot() {
        if (!this.playerId) return;

        const player = this.players.get(this.playerId);
        if (!player || !player.isAlive) return;

        // 枪口喷火特效（定位到枪管尖端，沿瞄准方向，样式随武器）
        const size = (this.gameConfig && this.gameConfig.PLAYER_SIZE) || 20;
        const ang = player.angle || 0;
        const muzzle = size / 2 + 7; // 枪管画到 size/2+7，尖端即枪口
        const wname = this.weaponIdName(player.weapon || 0);
        this.effects.push(new Effect(
            player.x + size / 2 + Math.cos(ang) * muzzle,
            player.y + size / 2 + Math.sin(ang) * muzzle,
            'shoot', 300, { angle: ang, weapon: wname }
        ));
        if (window.gameSound) window.gameSound.shoot(1, wname);
        this.addShake(wname === 'shotgun' || wname === 'sniper' ? 3 : 1.5);

        const enc = new BinaryEncoder().init(24);
        enc.writeUint8(MESSAGE_TYPES.SHOOT);
        enc.writeFloat32(this.mouse.x);
        enc.writeFloat32(this.mouse.y);
        this.ws.send(enc.getBuffer());
    }

    // 远端玩家开火表现（同一玩家 60ms 内的多颗弹丸只播一次，霰弹枪不会炸音）
    remoteShotFx(x, y, vx, vy, ownerId) {
        const now = Date.now();
        this._remoteFlashAt = this._remoteFlashAt || new Map();
        if (now - (this._remoteFlashAt.get(ownerId) || 0) < 60) return;
        this._remoteFlashAt.set(ownerId, now);
        const owner = this.players.get(ownerId);
        const wname = this.weaponIdName((owner && owner.weapon) || 0);
        if (window.gameSound) window.gameSound.shoot(this.volFor(x, y) * 0.6, wname);
        this.effects.push(new Effect(x, y, 'shoot', 300, { angle: Math.atan2(vy, vx), weapon: wname }));
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
            
            // 更新血量显示（颜色状态由 CSS class 控制）
            document.getElementById('health').textContent = health;
            const healthFill = document.getElementById('healthFill');
            if (healthFill) {
                healthFill.style.width = healthPercent + '%';
            }
            const uiRoot = document.getElementById('ui');
            if (uiRoot) {
                uiRoot.classList.toggle('hp-low', healthPercent <= 30);
                uiRoot.classList.toggle('hp-mid', healthPercent > 30 && healthPercent <= 60);
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
            rateEl.textContent = `↓ ${this.downRate || 0} pkt/s · ↑ ${this.upRate || 0} pkt/s`;
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
        // 受击白闪（drawPlayer 中叠加绘制）
        const player = this.players.get(targetId);
        if (player) player.hitFlashUntil = Date.now() + 110;
    }

    // 屏幕震动（叠加，帧间衰减）
    addShake(mag) {
        this.shakeMag = Math.min(14, (this.shakeMag || 0) + mag);
    }

    // 全屏闪光（击杀/受击反馈）
    triggerFlash(color, alpha) {
        this.flashColor = color;
        this.flashAlpha = Math.max(this.flashAlpha || 0, alpha);
    }

    // 按与本机玩家的距离衰减音量
    volFor(x, y) {
        const me = this.players.get(this.playerId);
        if (!me) return 0.5;
        const d = Math.hypot((x || 0) - me.x, (y || 0) - me.y);
        return Math.max(0.12, Math.min(1, 1 - d / 1000));
    }

    // 颜色明暗调整：'#rrggbb' -> rgb()
    _shade(hex, amt) {
        if (!hex || hex[0] !== '#' || hex.length !== 7) return hex;
        const n = parseInt(hex.slice(1), 16);
        if (isNaN(n)) return hex;
        const r = Math.max(0, Math.min(255, (n >> 16) + amt));
        const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
        const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
        return `rgb(${r},${g},${b})`;
    }

    // 2.5D 阴影层：地形斜投影 + 玩家椭圆脚影
    drawShadowLayer() {
        const ctx = this.backCtx;
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
        this.terrain.forEach(b => {
            ctx.fillRect(b.x + 5, b.y + b.height - 2, b.width, 7);
        });
        const size = this.gameConfig ? this.gameConfig.PLAYER_SIZE : 20;
        this.players.forEach(p => {
            if (!p.isAlive) return;
            ctx.beginPath();
            ctx.ellipse(p.x + size / 2, p.y + size + 2, size * 0.55, size * 0.24, 0, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.restore();
    }

    // 2.5D 地形块：顶面上移 + 侧立面，营造高度感
    drawTerrainBlock(block) {
        const ctx = this.backCtx;
        const H = 12;  // 挤出高度
        const R = 6;   // 卡通圆角
        let top, side, line;
        switch (block.type) {
            case 'rock':   top = '#9aa7c2'; side = '#66738f'; line = '#3a4258'; break;
            case 'crate':  top = '#e0a04c'; side = '#a06a28'; line = '#5c3d14'; break;
            case 'barrel': top = '#5e79d8'; side = '#3d4f9e'; line = '#28316b'; break;
            default:       top = '#6b7fdd'; side = '#4552a8'; line = '#2b3472'; // wall
        }
        // 侧立面（圆角贴住顶面）
        ctx.fillStyle = side;
        ctx.beginPath();
        ctx.roundRect(block.x, block.y - H + block.height - R, block.width, H + R, R);
        ctx.fill();
        // 顶面
        ctx.fillStyle = top;
        ctx.beginPath();
        ctx.roundRect(block.x, block.y - H, block.width, block.height, R);
        ctx.fill();
        // 卡通粗描边（整体轮廓）
        ctx.strokeStyle = line;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.roundRect(block.x + 1, block.y - H + 1, block.width - 2, block.height + H - 2, R);
        ctx.stroke();
        // 顶面高光
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(block.x + R, block.y - H + 2.5);
        ctx.lineTo(block.x + block.width - R, block.y - H + 2.5);
        ctx.stroke();
        // 类型细节（画在顶面坐标系）
        if (block.type === 'crate') {
            ctx.strokeStyle = line;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(block.x + block.width / 2, block.y - H + 4);
            ctx.lineTo(block.x + block.width / 2, block.y - H + block.height - 4);
            ctx.moveTo(block.x + 4, block.y - H + block.height / 2);
            ctx.lineTo(block.x + block.width - 4, block.y - H + block.height / 2);
            ctx.stroke();
        } else if (block.type === 'barrel') {
            ctx.strokeStyle = line;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(block.x + block.width / 2, block.y - H + block.height / 2, block.width / 3, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    // 静态暗角（只生成一次）
    drawVignette() {
        if (!this._vignette) {
            const c = document.createElement('canvas');
            c.width = this.canvas.width;
            c.height = this.canvas.height;
            const vctx = c.getContext('2d');
            const cx = c.width / 2, cy = c.height / 2;
            const r = Math.max(c.width, c.height) * 0.72;
            const g = vctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
            g.addColorStop(0, 'rgba(0, 0, 0, 0)');
            g.addColorStop(1, 'rgba(10, 14, 40, 0.22)');
            vctx.fillStyle = g;
            vctx.fillRect(0, 0, c.width, c.height);
            this._vignette = c;
        }
        this.backCtx.drawImage(this._vignette, 0, 0);
    }

    drawDamageNumbers() {
        this.damageNumbers.forEach(d => d.draw(this.backCtx));
    }

    render() {
        // 清空后台缓冲区（卡通风：明快的靛蓝场地）
        this.backCtx.fillStyle = '#333d78';
        this.backCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 屏幕震动偏移
        this.shakeMag = (this.shakeMag || 0) * 0.85;
        if (this.shakeMag < 0.1) this.shakeMag = 0;
        const shakeX = (Math.random() - 0.5) * 2 * this.shakeMag;
        const shakeY = (Math.random() - 0.5) * 2 * this.shakeMag;

        this.backCtx.save();
        this.backCtx.translate(shakeX, shakeY);

        // 绘制网格背景
        this.drawGrid();

        // 2.5D 阴影层
        this.drawShadowLayer();

        // 画家算法：地形/道具/玩家按底边 y 排序绘制，获得正确前后遮挡
        const psize = this.gameConfig ? this.gameConfig.PLAYER_SIZE : 20;
        const usize = this.gameConfig ? this.gameConfig.POWERUP_SIZE : 15;
        const drawList = [];
        this.terrain.forEach(b => drawList.push({ y: b.y + b.height, k: 0, o: b }));
        this.powerups.forEach(p => drawList.push({ y: p.y + usize, k: 1, o: p }));
        this.players.forEach(p => drawList.push({ y: p.y + psize, k: 2, o: p }));
        drawList.sort((a, b) => a.y - b.y || a.k - b.k);
        drawList.forEach(item => {
            if (item.k === 0) this.drawTerrainBlock(item.o);
            else if (item.k === 1) this.drawPowerup(item.o);
            else this.drawPlayer(item.o);
        });

        // 绘制烟迹/尘土（垫在子弹下层）
        this.trailParticles.forEach(p => p.draw(this.backCtx));

        // 绘制子弹
        this.bullets.forEach(bullet => {
            this.drawBullet(bullet);
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

        // 伤害飘字
        this.drawDamageNumbers();

        // 角色头顶聊天气泡
        this.players.forEach(p => this.drawChatBubble(p));

        this.backCtx.restore();

        // 击杀/受击全屏闪光
        if (this.flashAlpha > 0.01) {
            this.backCtx.save();
            this.backCtx.globalAlpha = this.flashAlpha;
            this.backCtx.fillStyle = this.flashColor;
            this.backCtx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.backCtx.restore();
            this.flashAlpha *= 0.86;
        } else {
            this.flashAlpha = 0;
        }

        // 暗角
        this.drawVignette();

        // 将后台缓冲区复制到前台画布 - 双缓冲交换
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.drawImage(this.backBuffer, 0, 0);
    }

    drawGrid() {
        // 卡通风：点阵替代线网格，更轻快
        const ctx = this.backCtx;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
        const gridSize = 50;
        for (let x = gridSize; x < this.canvas.width; x += gridSize) {
            for (let y = gridSize; y < this.canvas.height; y += gridSize) {
                ctx.beginPath();
                ctx.arc(x, y, 1.6, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    drawPlayer(player) {
        const size = this.gameConfig ? this.gameConfig.PLAYER_SIZE : 20;

        // 队伍标识环（分队/感染模式下在脚底画阵营色椭圆环）
        if (player.isAlive && (player.team === 1 || player.team === 2)) {
            const isInfect = this.gameConfig && this.gameConfig.GAME_MODE === 'infect';
            const teamAccent = player.team === 1 ? (isInfect ? '#2ecc71' : '#e74c3c') : '#3498db';
            this.backCtx.save();
            this.backCtx.strokeStyle = teamAccent;
            this.backCtx.globalAlpha = 0.85;
            this.backCtx.lineWidth = 2;
            this.backCtx.beginPath();
            this.backCtx.ellipse(player.x + size / 2, player.y + size + 3, size * 0.72, size * 0.3, 0, 0, Math.PI * 2);
            this.backCtx.stroke();
            this.backCtx.restore();
        }

        // 自己死亡期间：红圈脉冲标记击杀者
        if (this.deathInfo && player.id === this.deathInfo.killerId && player.isAlive) {
            const meP = this.players.get(this.playerId);
            if (meP && !meP.isAlive) {
                const pulse = 0.5 + Math.sin(Date.now() * 0.008) * 0.3;
                this.backCtx.save();
                this.backCtx.globalAlpha = pulse;
                this.backCtx.strokeStyle = '#ff6b6b';
                this.backCtx.lineWidth = 2.5;
                this.backCtx.beginPath();
                this.backCtx.arc(player.x + size / 2, player.y + size / 2, size * 1.15, 0, Math.PI * 2);
                this.backCtx.stroke();
                this.backCtx.restore();
            }
        }

        this.backCtx.save();
        this.backCtx.translate(player.x + size / 2, player.y + size / 2);
        this.backCtx.rotate(player.angle);
        
        // 玩家身体（卡通风：圆角方块 + 粗描边 + 顶部高光）
        const bodyColor = player.isAlive ? (player.color || '#3498db') : '#8a93a5';
        const bodyGrad = this.backCtx.createLinearGradient(0, -size / 2, 0, size / 2);
        bodyGrad.addColorStop(0, this._shade(bodyColor, 30));
        bodyGrad.addColorStop(1, this._shade(bodyColor, -18));
        this.backCtx.fillStyle = bodyGrad;
        this.backCtx.beginPath();
        this.backCtx.roundRect(-size / 2, -size / 2, size, size, 5);
        this.backCtx.fill();
        this.backCtx.strokeStyle = '#232842';
        this.backCtx.lineWidth = 2.5;
        this.backCtx.stroke();
        // 顶部高光点
        this.backCtx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        this.backCtx.beginPath();
        this.backCtx.arc(-size * 0.22, -size * 0.22, size * 0.13, 0, Math.PI * 2);
        this.backCtx.fill();

        // 护盾：贴身铠甲（肩甲两块 + 后背胸甲带 + 铆钉），钢蓝色金属质感
        if (player.isAlive && player.powerups && player.powerups.shield && player.powerups.shield.active) {
            const actx = this.backCtx;
            actx.fillStyle = '#b9c8dd';
            actx.strokeStyle = '#46536b';
            actx.lineWidth = 1.5;
            // 肩甲（旋转系上下两侧，即角色左右肩）
            for (const sy of [-1, 1]) {
                actx.beginPath();
                actx.roundRect(-size * 0.48, sy === -1 ? -size * 0.6 : size * 0.36, size * 0.8, size * 0.24, 4);
                actx.fill();
                actx.stroke();
            }
            // 后背胸甲带（避开前脸的眼睛）
            actx.beginPath();
            actx.roundRect(-size * 0.55, -size * 0.16, size * 0.42, size * 0.32, 4);
            actx.fill();
            actx.stroke();
            // 铆钉
            actx.fillStyle = '#5d6b84';
            for (const [rx, ry] of [
                [-size * 0.32, -size * 0.48], [size * 0.12, -size * 0.48],
                [-size * 0.32, size * 0.48], [size * 0.12, size * 0.48],
                [-size * 0.42, 0]
            ]) {
                actx.beginPath();
                actx.arc(rx, ry, 1.3, 0, Math.PI * 2);
                actx.fill();
            }
        }

        // 受击白闪
        if (player.hitFlashUntil && player.hitFlashUntil > Date.now()) {
            this.backCtx.fillStyle = 'rgba(255, 255, 255, 0.75)';
            this.backCtx.beginPath();
            this.backCtx.roundRect(-size / 2, -size / 2, size, size, 5);
            this.backCtx.fill();
        }

        // 卡通眼睛（旋转坐标系里 +x 即朝向；感染者红瞳发光）
        if (player.isAlive) {
            const zombieEyes = this.gameConfig && this.gameConfig.GAME_MODE === 'infect' && player.team === 1;
            const eyeX = size * 0.14, eyeY = size * 0.2, eyeR = size * 0.17;
            for (const sy of [-1, 1]) {
                this.backCtx.fillStyle = zombieEyes ? '#eaffea' : '#ffffff';
                this.backCtx.strokeStyle = '#232842';
                this.backCtx.lineWidth = 1.2;
                this.backCtx.beginPath();
                this.backCtx.arc(eyeX, sy * eyeY, eyeR, 0, Math.PI * 2);
                this.backCtx.fill();
                this.backCtx.stroke();
                if (zombieEyes) {
                    this.backCtx.fillStyle = '#e03131';
                    this.backCtx.shadowColor = '#ff5d5d';
                    this.backCtx.shadowBlur = 5;
                } else {
                    this.backCtx.fillStyle = '#232842';
                }
                this.backCtx.beginPath();
                this.backCtx.arc(eyeX + eyeR * 0.42, sy * eyeY, eyeR * 0.5, 0, Math.PI * 2);
                this.backCtx.fill();
                this.backCtx.shadowBlur = 0;
            }
        } else {
            // 阵亡：×× 眼
            this.backCtx.strokeStyle = '#3a4152';
            this.backCtx.lineWidth = 1.8;
            const eyeX = size * 0.14, eyeY = size * 0.2, k = size * 0.1;
            for (const sy of [-1, 1]) {
                this.backCtx.beginPath();
                this.backCtx.moveTo(eyeX - k, sy * eyeY - k);
                this.backCtx.lineTo(eyeX + k, sy * eyeY + k);
                this.backCtx.moveTo(eyeX + k, sy * eyeY - k);
                this.backCtx.lineTo(eyeX - k, sy * eyeY + k);
                this.backCtx.stroke();
            }
        }
        
        // 感染者：僵尸前爪替代枪械 + 身上疤痕
        const isZombie = this.gameConfig && this.gameConfig.GAME_MODE === 'infect' &&
            player.team === 1 && player.isAlive;
        if (isZombie) {
            // 疤痕缝线
            this.backCtx.strokeStyle = 'rgba(15, 55, 30, 0.85)';
            this.backCtx.lineWidth = 1.3;
            this.backCtx.beginPath();
            this.backCtx.moveTo(-size * 0.3, -size * 0.05);
            this.backCtx.lineTo(-size * 0.05, -size * 0.18);
            this.backCtx.stroke();
            for (const t of [0.25, 0.55, 0.8]) {
                const sx = -size * 0.3 + (size * 0.25) * t;
                const sy = -size * 0.05 - (size * 0.13) * t;
                this.backCtx.beginPath();
                this.backCtx.moveTo(sx - 1.5, sy - 1.8);
                this.backCtx.lineTo(sx + 1.5, sy + 1.8);
                this.backCtx.stroke();
            }
            // 两只前爪（爪掌 + 三根白爪尖）
            for (const sy of [-1, 1]) {
                const hx = size / 2 - 1, hy = sy * size * 0.28;
                this.backCtx.fillStyle = '#1e4d2b';
                this.backCtx.beginPath();
                this.backCtx.arc(hx, hy, 3.4, 0, Math.PI * 2);
                this.backCtx.fill();
                this.backCtx.strokeStyle = '#d9ffe3';
                this.backCtx.lineWidth = 1.4;
                this.backCtx.lineCap = 'round';
                for (const k of [-1, 0, 1]) {
                    this.backCtx.beginPath();
                    this.backCtx.moveTo(hx + 2, hy + k * 2.1);
                    this.backCtx.lineTo(hx + 7, hy + k * 2.8);
                    this.backCtx.stroke();
                }
            }
        }

        // 增益武器光效：伤害强化=赤红灼光 / 急速射击=炽热橙光
        const dmgGlow = player.powerups && player.powerups.damageBoost && player.powerups.damageBoost.active;
        const rapidGlow = player.powerups && player.powerups.rapidFire && player.powerups.rapidFire.active;
        if (dmgGlow) {
            this.backCtx.shadowColor = '#ff4d4d';
            this.backCtx.shadowBlur = 10;
        } else if (rapidGlow) {
            this.backCtx.shadowColor = '#ffb347';
            this.backCtx.shadowBlur = 10;
        }

        // 枪械外观（随武器变化；感染者无枪）
        const wIdx = player.weapon || 0;
        this.backCtx.fillStyle = dmgGlow ? '#ffd6cf' : rapidGlow ? '#ffe9c4' : '#e8edf5';
        if (isZombie) {
            // 已画爪，跳过枪械
        } else if (wIdx === 1) {
            // 冲锋枪：短枪管 + 下挂弹匣
            this.backCtx.fillRect(size / 2 - 2, -2, 8, 4);
            this.backCtx.fillStyle = '#9aa4b4';
            this.backCtx.fillRect(size / 2 + 1, 2, 3, 4.5);
        } else if (wIdx === 2) {
            // 霰弹枪：粗短双管 + 木质护木
            this.backCtx.fillRect(size / 2 - 2, -3.5, 10, 3);
            this.backCtx.fillRect(size / 2 - 2, 0.5, 10, 3);
            this.backCtx.fillStyle = '#8a5a2b';
            this.backCtx.fillRect(size / 2 - 3, -2.5, 3.5, 5);
        } else if (wIdx === 3) {
            // 狙击枪：细长枪管 + 瞄具
            this.backCtx.fillRect(size / 2 - 2, -1.5, 17, 3);
            this.backCtx.fillStyle = '#38bdf8';
            this.backCtx.fillRect(size / 2 + 3, -4.5, 4.5, 2.5);
        } else if (wIdx === 4) {
            // 火箭筒：粗发射管 + 喇叭口
            this.backCtx.fillStyle = '#4d5b45';
            this.backCtx.fillRect(size / 2 - 4, -3.5, 13, 7);
            this.backCtx.fillStyle = '#333d2e';
            this.backCtx.fillRect(size / 2 + 9, -4.5, 3.5, 9);
        } else {
            // 步枪：默认枪管
            this.backCtx.fillRect(size / 2 - 2, -2.5, 9, 5);
        }

        this.backCtx.restore();

        // 换弹进度环（所有玩家可见）
        if (player.isAlive && player.reloadEnd && player.reloadEnd > Date.now()) {
            const total = player.reloadTotal || 1500;
            const frac = Math.max(0, Math.min(1, 1 - (player.reloadEnd - Date.now()) / total));
            this.backCtx.save();
            this.backCtx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
            this.backCtx.lineWidth = 2.5;
            this.backCtx.beginPath();
            this.backCtx.arc(player.x + size / 2, player.y + size / 2, size * 0.95, 0, Math.PI * 2);
            this.backCtx.stroke();
            this.backCtx.strokeStyle = '#f1f5f9';
            this.backCtx.beginPath();
            this.backCtx.arc(player.x + size / 2, player.y + size / 2, size * 0.95, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
            this.backCtx.stroke();
            this.backCtx.restore();
        }
        
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
        
        // 绘制昵称（在血条上方，分队模式下按队伍着色）
        this.backCtx.fillStyle = player.team === 1 ? '#ffb0a3' : player.team === 2 ? '#a8d4f7' : '#ffffff';
        this.backCtx.font = '12px Arial';
        this.backCtx.textAlign = 'center';
        this.backCtx.fillText(player.nickname, player.x + size / 2, player.y - 20);
        
        
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

        // 火箭弹：弹体沿速度方向 + 喷焰尾迹
        if (bullet.kind === 1) {
            const ang = Math.atan2(bullet.vy, bullet.vx);
            const ctx = this.backCtx;
            ctx.save();
            // 尾焰（抖动的橙色锥）
            for (let i = 1; i <= 5; i++) {
                const fx = bullet.x - Math.cos(ang) * (5 + i * 3.2) + (Math.random() - 0.5) * 2;
                const fy = bullet.y - Math.sin(ang) * (5 + i * 3.2) + (Math.random() - 0.5) * 2;
                ctx.globalAlpha = (6 - i) / 6 * 0.75;
                ctx.fillStyle = i <= 2 ? '#ffd27f' : '#ff8c42';
                ctx.beginPath();
                ctx.arc(fx, fy, 3.4 - i * 0.5, 0, Math.PI * 2);
                ctx.fill();
            }
            // 弹体
            ctx.globalAlpha = 1;
            ctx.translate(bullet.x, bullet.y);
            ctx.rotate(ang);
            ctx.fillStyle = '#4a5568';
            ctx.fillRect(-6, -2.5, 10, 5);
            ctx.fillStyle = '#f2495c';
            ctx.beginPath();
            ctx.moveTo(4, -2.5);
            ctx.lineTo(9, 0);
            ctx.lineTo(4, 2.5);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
            return;
        }

        // 手雷：深色弹体 + 引信红灯闪烁
        if (bullet.kind === 2) {
            const ctx = this.backCtx;
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
            ctx.beginPath();
            ctx.ellipse(bullet.x, bullet.y + 5, 4.5, 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#3f4a35';
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(bullet.x, bullet.y, 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#79866a';
            ctx.fillRect(bullet.x - 1.5, bullet.y - 6.5, 3, 3);
            // 引信灯（越接近爆炸闪得越快）
            if (Math.sin(time * 0.03) > -0.2) {
                ctx.fillStyle = '#ff5d5d';
                ctx.shadowColor = '#ff5d5d';
                ctx.shadowBlur = 6;
                ctx.beginPath();
                ctx.arc(bullet.x, bullet.y - 5, 1.4, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
            return;
        }

        this.backCtx.save();

        // 曳光弹：沿速度方向的发光渐变光条 + 亮芯
        this.backCtx.globalCompositeOperation = 'lighter';
        const tailX = bullet.x - bullet.vx * 2.6;
        const tailY = bullet.y - bullet.vy * 2.6;
        const tracer = this.backCtx.createLinearGradient(tailX, tailY, bullet.x, bullet.y);
        tracer.addColorStop(0, 'rgba(255, 150, 40, 0)');
        tracer.addColorStop(0.6, 'rgba(255, 190, 80, 0.55)');
        tracer.addColorStop(1, 'rgba(255, 235, 170, 0.95)');
        this.backCtx.strokeStyle = tracer;
        this.backCtx.lineWidth = size * 0.9;
        this.backCtx.lineCap = 'round';
        this.backCtx.beginPath();
        this.backCtx.moveTo(tailX, tailY);
        this.backCtx.lineTo(bullet.x, bullet.y);
        this.backCtx.stroke();

        // 亮芯
        const gradient = this.backCtx.createRadialGradient(
            bullet.x, bullet.y, 0,
            bullet.x, bullet.y, size * 0.9
        );
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(0.5, '#ffe9a0');
        gradient.addColorStop(1, 'rgba(255, 170, 0, 0)');
        this.backCtx.fillStyle = gradient;
        this.backCtx.beginPath();
        this.backCtx.arc(bullet.x, bullet.y, size * 0.9, 0, Math.PI * 2);
        this.backCtx.fill();
        this.backCtx.globalCompositeOperation = 'source-over';
        this.backCtx.globalAlpha = 1;
        
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

    // 增益的角色环绕表现：护盾微光罩 / 急速能量弧 / 伤害强化尖刺气场 / 治疗涌动
    drawPlayerBuffs(player, size) {
        if (!player.powerups) return;

        const ctx = this.backCtx;
        const centerX = player.x + size / 2;
        const centerY = player.y + size / 2;
        const time = Date.now();

        // 护盾：淡蓝护罩微光（铠甲主体画在角色旋转坐标系里）
        if (player.powerups.shield && player.powerups.shield.active) {
            ctx.save();
            const pulse = 0.25 + 0.12 * Math.sin(time * 0.006);
            const g = ctx.createRadialGradient(centerX, centerY, size * 0.4, centerX, centerY, size * 0.95);
            g.addColorStop(0, 'rgba(140, 190, 255, 0)');
            g.addColorStop(1, `rgba(140, 190, 255, ${pulse})`);
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(centerX, centerY, size * 0.95, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // 急速射击：两段高速旋转的金色能量弧
        if (player.powerups.rapidFire && player.powerups.rapidFire.active) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineCap = 'round';
            const base = time * 0.012;
            for (const phase of [0, Math.PI]) {
                ctx.strokeStyle = 'rgba(255, 200, 80, 0.85)';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(centerX, centerY, size * 0.85, base + phase, base + phase + 1.1);
                ctx.stroke();
                // 弧头亮点
                const hx = centerX + Math.cos(base + phase + 1.1) * size * 0.85;
                const hy = centerY + Math.sin(base + phase + 1.1) * size * 0.85;
                ctx.fillStyle = '#fff2c8';
                ctx.beginPath();
                ctx.arc(hx, hy, 2.2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        // 伤害强化：缓慢旋转的红色尖刺气场（脉动）
        if (player.powerups.damageBoost && player.powerups.damageBoost.active) {
            ctx.save();
            const rot = time * 0.0022;
            const spikes = 8;
            const rIn = size * 0.72 + Math.sin(time * 0.008) * 1.5;
            const rOut = rIn + 7 + Math.sin(time * 0.008) * 2;
            ctx.globalAlpha = 0.8;
            const grad = ctx.createRadialGradient(centerX, centerY, rIn, centerX, centerY, rOut);
            grad.addColorStop(0, 'rgba(255, 90, 60, 0.85)');
            grad.addColorStop(1, 'rgba(255, 170, 60, 0.15)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            for (let i = 0; i < spikes; i++) {
                const a0 = rot + (i / spikes) * Math.PI * 2;
                const a1 = a0 + Math.PI / spikes;
                const a2 = a0 + (Math.PI * 2) / spikes;
                ctx.moveTo(centerX + Math.cos(a0) * rIn, centerY + Math.sin(a0) * rIn);
                ctx.lineTo(centerX + Math.cos(a1) * rOut, centerY + Math.sin(a1) * rOut);
                ctx.lineTo(centerX + Math.cos(a2) * rIn, centerY + Math.sin(a2) * rIn);
            }
            ctx.fill();
            ctx.restore();
        }

        // 治疗涌动：拾取回血后 1.4s 内绿色十字上升 + 身体绿光
        if (player.healFxUntil && player.healFxUntil > time) {
            ctx.save();
            const p = 1 - (player.healFxUntil - time) / 1400;
            ctx.globalAlpha = Math.min(1, (1 - p) * 1.6);
            // 身体绿光
            const hg = ctx.createRadialGradient(centerX, centerY, size * 0.3, centerX, centerY, size * 0.9);
            hg.addColorStop(0, 'rgba(80, 230, 140, 0.25)');
            hg.addColorStop(1, 'rgba(80, 230, 140, 0)');
            ctx.fillStyle = hg;
            ctx.beginPath();
            ctx.arc(centerX, centerY, size * 0.9, 0, Math.PI * 2);
            ctx.fill();
            // 三枚上升绿十字（不同相位）
            ctx.fillStyle = '#5dde9a';
            for (let i = 0; i < 3; i++) {
                const ph = (p + i * 0.33) % 1;
                const cxx = centerX + (i - 1) * size * 0.42;
                const cyy = centerY + size * 0.4 - ph * size * 1.5;
                const s = 2.4;
                ctx.globalAlpha = Math.min(1, (1 - ph) * 1.4) * Math.min(1, (1 - p) * 1.6);
                ctx.fillRect(cxx - s / 2, cyy - s * 1.5, s, s * 3);
                ctx.fillRect(cxx - s * 1.5, cyy - s / 2, s * 3, s);
            }
            ctx.restore();
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
                    icon: '◆',
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
                    icon: '▲',
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
                    icon: '●',
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
                    icon: '+',
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
            { key: 'shield', color: '#a78bfa', icon: '◆' },
            { key: 'rapidFire', color: '#fbbf24', icon: '▲' },
            { key: 'damageBoost', color: '#f87171', icon: '●' }
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
