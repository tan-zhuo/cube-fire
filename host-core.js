// host-core.js — 浏览器端"游戏主机"核心，从 server.js 移植而来
// 由房主页面运行权威游戏逻辑；玩家连接通过 GameHost.addConnection 接入
// （本地玩家走内存回环，远程玩家走 WebRTC DataChannel）
window.GameHost = (function () {
'use strict';

// 静默主机日志以提升性能（如需调试，可改为 false）
const SILENCE_LOGS = true;
const console = SILENCE_LOGS
    ? { log() {}, info() {}, debug() {}, warn: window.console.warn.bind(window.console), error: window.console.error.bind(window.console) }
    : window.console;

// 所有已接入的玩家连接（替代原 wss.clients）
const connections = new Set();

// 游戏状态
const gameState = {
    players: new Map(),
    bullets: [],
    powerups: [],
    terrain: [],
    nextPlayerId: 1,
    nextPowerupId: 1,
    gameStartTime: null, // 游戏开始时间，初始为null
    gameDuration: 120000, // 2分钟游戏时长
    isGameEnded: true, // 初始状态为未开始
    killFeed: [],
    countdown: 0,
    showingResults: false,
    countdownStartTime: 0, // 倒计时开始时间
    // 增量更新相关
    lastUpdateTime: 0,
    updateCounter: 0,
    lastPlayerStates: new Map(),
    lastBulletStates: [],
    lastPowerupStates: [],
    // 网络质量检测
    clientPing: new Map(),
    clientUpdateRates: new Map(),
    clientNetworkQuality: new Map(),
    // 消息批处理队列
    messageQueue: new Map(), // playerId -> array of messages
    batchTimer: null,
    lastBatchTime: 0,
    // 数据压缩缓存
    compressionCache: new Map()
};

// 确保游戏状态正确初始化
console.log('游戏状态初始化:', {
    isGameEnded: gameState.isGameEnded,
    countdown: gameState.countdown,
    showingResults: gameState.showingResults,
    message: '等待玩家加入以开始游戏'
});

// 游戏配置
const GAME_CONFIG = {
    CANVAS_WIDTH: 1200,
    CANVAS_HEIGHT: 800,
    PLAYER_SIZE: 20,
    BULLET_SIZE: 4,
    BULLET_SPEED: 10, // 玩家速度的1.5倍 (5 * 1.5 = 7.5)
    PLAYER_SPEED: 5,
    MAX_HEALTH: 100,
    RESPAWN_TIME: 3000, // 3秒复活时间
    POWERUP_SIZE: 15,
    POWERUP_SPAWN_INTERVAL: 12000, // 12秒生成一个道具箱
    POWERUP_DURATION: 15000, // 道具持续时间15秒
    TERRAIN_SIZE: 40, // 地形块大小
    MELEE_RANGE: 50, // 近战攻击范围
    MELEE_DAMAGE: 100, // 近战攻击伤害（一刀秒杀）
    MELEE_COOLDOWN: 1000 // 近战攻击冷却时间1秒
};

// ===================== 武器表 =====================
// 与 server.js / game.js（经 JOINED 配置下发）保持一致。
// reserve 为拾取时的备弹（不含首个弹夹）；步枪为默认武器、备弹无限（-1）。
const WEAPONS = {
    rifle:   { name: '步枪',   damage: 25, fireRate: 200,  magSize: 30, reloadMs: 1500, pellets: 1, spread: 0,    speed: 10, reserve: -1,  lifeMs: 2000 },
    smg:     { name: '冲锋枪', damage: 12, fireRate: 90,   magSize: 40, reloadMs: 1600, pellets: 1, spread: 0.09, speed: 11, reserve: 80,  lifeMs: 2000 },
    shotgun: { name: '霰弹枪', damage: 11, fireRate: 750,  magSize: 6,  reloadMs: 2200, pellets: 6, spread: 0.34, speed: 9,  reserve: 24,  lifeMs: 450 },
    sniper:  { name: '狙击枪', damage: 80, fireRate: 1100, magSize: 5,  reloadMs: 2400, pellets: 1, spread: 0,    speed: 12, reserve: 10,  lifeMs: 2000 },
    rpg:     { name: '火箭筒', damage: 85, fireRate: 1500, magSize: 1,  reloadMs: 2500, pellets: 1, spread: 0,    speed: 7,  reserve: 4,   lifeMs: 2200, kind: 1, blastRadius: 90 }
};
const WEAPON_IDS = ['rifle', 'smg', 'shotgun', 'sniper', 'rpg']; // uint8 索引编码

// 手雷参数
const GRENADE = { blastRadius: 100, blastDamage: 75, speed: 8, maxThrow: 320, fuseMs: 1300, cooldownMs: 1000, carry: 2, carryMax: 4 };

// 玩家武器状态的网络快照（w=武器索引 mag=弹夹 res=备弹(255=无限) rel=换弹剩余ms g=手雷数）
function weaponNetState(p) {
    const rel = p.reloading ? Math.max(0, p.reloadEnd - Date.now()) : 0;
    return {
        w: Math.max(0, WEAPON_IDS.indexOf(p.weapon)),
        mag: Math.max(0, Math.min(255, p.mag | 0)),
        res: p.reserve < 0 ? 255 : Math.max(0, Math.min(254, p.reserve | 0)),
        rel: Math.min(65535, rel | 0),
        g: Math.max(0, Math.min(255, p.grenades | 0))
    };
}

// ===================== 地图注册表 =====================
// 所有地图均为 1200x800（30x20 格，格宽 TERRAIN_SIZE=40）。
// buildBlocks(): 返回除四周边界墙外的地形块（边界墙由 generateTerrain 统一追加）。
// teamZones: 分队模式下两队的出生区域（像素矩形），1=红队(左) 2=蓝队(右)。
const DEFAULT_TEAM_ZONES = {
    1: { x: 60, y: 60, w: 300, h: 680 },
    2: { x: 840, y: 60, w: 300, h: 680 }
};

const MAPS = {
    classic: {
        name: '经典竞技场',
        buildBlocks: buildClassicBlocks,
        teamZones: DEFAULT_TEAM_ZONES
    },
    fortress: {
        name: '双子要塞',
        buildBlocks: buildFortressBlocks,
        teamZones: {
            1: { x: 60, y: 60, w: 260, h: 680 },
            2: { x: 880, y: 60, w: 260, h: 680 }
        }
    },
    maze: {
        name: '迷宫回廊',
        buildBlocks: buildMazeBlocks,
        teamZones: DEFAULT_TEAM_ZONES
    },
    crossfire: {
        name: '十字堡垒',
        buildBlocks: buildCrossfireBlocks,
        teamZones: DEFAULT_TEAM_ZONES
    }
};
const DEFAULT_MAP_ID = 'classic';

// 对局配置：房主创建房间时指定；/map、/team 聊天命令修改下一局设置
const matchConfig = {
    mapId: DEFAULT_MAP_ID,
    teamMode: false,
    pendingMapId: null,
    pendingTeamMode: null
};

// 队伍配色（1=红队 2=蓝队），同队队员使用不同深浅便于区分个体
const TEAM_COLORS = {
    1: ['#e74c3c', '#ff8a75', '#c0392b', '#ff5e3a'],
    2: ['#3498db', '#7fc4f5', '#2471a8', '#54a0ff']
};
const TEAM_NAMES = { 1: '红队', 2: '蓝队' };

// 二进制协议配置
const MESSAGE_TYPES = {
    // 客户端发送的消息
    JOIN: 1,
    MOVE: 2,
    SHOOT: 3,
    RELOAD: 8,
    GRENADE: 9,
    MELEE: 4,
    RESPAWN: 5,
    CHAT: 6,
    PING: 7,
    
    // 服务器发送的消息
    JOINED: 10,
    PLAYER_JOINED: 11,
    PLAYER_LEFT: 12,
    GAME_STATE: 13,
    PLAYER_MOVE: 14,
    // BULLET_SHOT: 15, // 已移除，子弹现在通过 gameState 发送
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

// 二进制编码器
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
        this.view.setUint16(this.offset, value, true); // little endian
        this.offset += 2;
        return this;
    }
    
    writeInt16(value) {
        this.view.setInt16(this.offset, value, true);
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
        const encoder = new TextEncoder();
        const bytes = encoder.encode(str);
        this.writeUint16(bytes.length);
        new Uint8Array(this.buffer, this.offset, bytes.length).set(bytes);
        this.offset += bytes.length;
        return this;
    }
    
    getBuffer() {
        return this.buffer.slice(0, this.offset);
    }
}

// 编码加入确认（JOINED）
function encodeJoined(playerId) {
    const encoder = new BinaryEncoder().init(4096); // 配置JSON含武器表，需要更大缓冲
    encoder.writeUint8(MESSAGE_TYPES.JOINED);
    encoder.writeUint32(playerId);
    // 将gameConfig作为字符串传输，便于扩展；附带当前对局的地图与模式信息
    const map = MAPS[matchConfig.mapId] || MAPS[DEFAULT_MAP_ID];
    encoder.writeString(JSON.stringify({
        ...GAME_CONFIG,
        MAP_ID: matchConfig.mapId,
        MAP_NAME: map.name,
        TEAM_MODE: matchConfig.teamMode,
        WEAPONS: WEAPONS,
        WEAPON_IDS: WEAPON_IDS
    }));
    return encoder.getBuffer();
}

// 角度编码：atan2 范围是 -π~π，uint16 无符号，先归一化到 0~2π 再 ×100
function encodeAngle100(angle) {
    const TWO_PI = Math.PI * 2;
    const a = ((angle || 0) % TWO_PI + TWO_PI) % TWO_PI;
    return Math.round(a * 100);
}

// 编码增量更新（二进制）
function encodeIncrementalUpdate(update) {
    const enc = new BinaryEncoder().init(8192);
    enc.writeUint8(MESSAGE_TYPES.INCREMENTAL_UPDATE);
    // 时间戳与剩余时间
    const ts = update.timestamp || Date.now();
    enc.writeUint32(ts);
    enc.writeUint32(Math.max(0, update.remainingTime || 0));
    enc.writeUint8(update.isGameEnded ? 1 : 0);
    
    // 新玩家
    if (update.newPlayers && update.newPlayers.length > 0) {
        enc.writeUint8(0x10);
        enc.writeUint16(update.newPlayers.length);
        update.newPlayers.forEach(p => {
            enc.writeUint32(p.id);
            enc.writeString(p.nickname || '');
            enc.writeUint16(Math.max(0, Math.min(65535, Math.round(p.x))));
            enc.writeUint16(Math.max(0, Math.min(65535, Math.round(p.y))));
            enc.writeUint16(encodeAngle100(p.angle));
            enc.writeUint8(p.health || 0);
            enc.writeUint16(Math.min(65535, p.score || 0));
            enc.writeUint8(p.isAlive ? 1 : 0);
            enc.writeString(p.color || '#3498db');
            enc.writeUint8(p.team || 0);
            // 武器状态
            enc.writeUint8(p.weapon | 0);
            enc.writeUint8(p.mag | 0);
            enc.writeUint8(p.reserve === undefined ? 255 : p.reserve);
            enc.writeUint16(p.reloadRem | 0);
            enc.writeUint8(p.grenades === undefined ? 2 : p.grenades);
        });
    }

    // 变化玩家（使用bitmask按需写字段）
    if (update.changedPlayers && update.changedPlayers.length > 0) {
        enc.writeUint8(0x02);
        enc.writeUint16(update.changedPlayers.length);
        update.changedPlayers.forEach(c => {
            enc.writeUint32(c.id);
            let mask = 0;
            if (c.x !== undefined) mask |= 0x01;
            if (c.y !== undefined) mask |= 0x02;
            if (c.angle !== undefined) mask |= 0x04;
            if (c.health !== undefined) mask |= 0x08;
            if (c.score !== undefined) mask |= 0x10;
            if (c.isAlive !== undefined) mask |= 0x20;
            if (c.powerups !== undefined) mask |= 0x40; // 道具状态变化
            if (c.weaponState !== undefined) mask |= 0x80; // 武器/弹药变化
            enc.writeUint8(mask);
            if (mask & 0x01) enc.writeUint16(Math.max(0, Math.min(65535, Math.round(c.x))));
            if (mask & 0x02) enc.writeUint16(Math.max(0, Math.min(65535, Math.round(c.y))));
            if (mask & 0x04) enc.writeUint16(encodeAngle100(c.angle));
            if (mask & 0x08) enc.writeUint8(c.health);
            if (mask & 0x10) enc.writeUint16(Math.min(65535, c.score));
            if (mask & 0x20) enc.writeUint8(c.isAlive ? 1 : 0);

            // 写入道具状态（3个buff：shield/rapidFire/damageBoost），每个：active(uint8) + 剩余时间秒(uint16)
            if (mask & 0x40) {
                const now = Date.now();
                const writeBuff = (buff) => {
                    const active = buff && buff.active;
                    enc.writeUint8(active ? 1 : 0);
                    const remSec = active ? Math.max(0, Math.ceil(((buff.endTime || now) - now) / 1000)) : 0;
                    enc.writeUint16(Math.min(65535, remSec));
                };
                writeBuff(c.powerups && c.powerups.shield);
                writeBuff(c.powerups && (c.powerups.rapidFire || c.powerups.rapid_fire));
                writeBuff(c.powerups && (c.powerups.damageBoost || c.powerups.damage_boost));
            }

            // 写入武器状态：武器索引(uint8) + 弹夹(uint8) + 备弹(uint8,255=无限) + 换弹剩余ms(uint16)
            if (mask & 0x80) {
                enc.writeUint8(c.weaponState.w | 0);
                enc.writeUint8(c.weaponState.mag | 0);
                enc.writeUint8(c.weaponState.res | 0);
                enc.writeUint16(c.weaponState.rel | 0);
                enc.writeUint8(c.weaponState.g | 0);
            }
        });
    }
    
    // 新子弹
    if (update.newBullets && update.newBullets.length > 0) {
        enc.writeUint8(0x03);
        enc.writeUint16(update.newBullets.length);
        update.newBullets.forEach(b => {
            enc.writeString(String(b.id));
            enc.writeUint16(Math.max(0, Math.min(65535, Math.round(b.x))));
            enc.writeUint16(Math.max(0, Math.min(65535, Math.round(b.y))));
            enc.writeInt16(Math.max(-32768, Math.min(32767, Math.round((b.vx || 0) * 100))));
            enc.writeInt16(Math.max(-32768, Math.min(32767, Math.round((b.vy || 0) * 100))));
            enc.writeUint32(b.ownerId || 0);
            enc.writeUint8(b.kind | 0);
        });
    }
    
    // 移除子弹
    if (update.removedBullets && update.removedBullets.length > 0) {
        enc.writeUint8(0x13);
        enc.writeUint16(update.removedBullets.length);
        update.removedBullets.forEach(id => enc.writeString(String(id)));
    }
    
    // 新道具
    if (update.newPowerups && update.newPowerups.length > 0) {
        enc.writeUint8(0x04);
        enc.writeUint16(update.newPowerups.length);
        update.newPowerups.forEach(p => {
            enc.writeUint32(p.id);
            enc.writeUint16(Math.max(0, Math.min(65535, Math.round(p.x))));
            enc.writeUint16(Math.max(0, Math.min(65535, Math.round(p.y))));
            enc.writeUint8(getPowerupTypeId(p.type));
        });
    }
    
    // 移除道具
    if (update.removedPowerups && update.removedPowerups.length > 0) {
        enc.writeUint8(0x14);
        enc.writeUint16(update.removedPowerups.length);
        update.removedPowerups.forEach(id => enc.writeUint32(id));
    }
    
    // 结束标识
    enc.writeUint8(0xFF);
    return enc.getBuffer();
}

// 编码游戏结束（结果展示）
function encodeGameEnd(payload) {
    const enc = new BinaryEncoder().init(8192);
    enc.writeUint8(MESSAGE_TYPES.GAME_END);
    enc.writeUint8(payload.countdown || 0);
    enc.writeUint8(payload.showingResults ? 1 : 0);
    const players = payload.players || [];
    enc.writeUint16(players.length);
    players.forEach(p => {
        enc.writeUint32(p.id);
        enc.writeString(p.nickname || '');
        enc.writeUint16(Math.min(65535, p.score || 0));
        enc.writeUint8(p.isAlive ? 1 : 0);
        enc.writeUint8(Math.max(0, Math.min(100, p.health || 0)));
        enc.writeUint8(p.team || 0);
    });
    return enc.getBuffer();
}

// 编码新游戏开始倒计时
function encodeNewGameStart(payload) {
    const enc = new BinaryEncoder().init(32);
    enc.writeUint8(MESSAGE_TYPES.NEW_GAME_START);
    enc.writeUint8(payload.countdown || 0);
    return enc.getBuffer();
}

// 编码游戏正式开始
function encodeGameStarted() {
    const enc = new BinaryEncoder().init(8);
    enc.writeUint8(MESSAGE_TYPES.GAME_STARTED);
    return enc.getBuffer();
}

function encodePlayerJoined(player) {
    const enc = new BinaryEncoder().init(256);
    enc.writeUint8(MESSAGE_TYPES.PLAYER_JOINED);
    enc.writeUint32(player.id);
    enc.writeString(player.nickname || '');
    enc.writeUint16(Math.max(0, Math.min(65535, Math.round(player.x))));
    enc.writeUint16(Math.max(0, Math.min(65535, Math.round(player.y))));
    enc.writeUint16(encodeAngle100(player.angle));
    enc.writeUint8(player.health || 0);
    enc.writeUint16(Math.min(65535, player.score || 0));
    enc.writeUint8(player.isAlive ? 1 : 0);
    enc.writeString(player.color || '#3498db');
    enc.writeUint8(player.team || 0);
    // 武器状态（player 为 playerJoined 消息里的普通对象，字段已是编码值）
    enc.writeUint8(player.weapon | 0);
    enc.writeUint8(player.mag | 0);
    enc.writeUint8(player.reserve === undefined ? 255 : player.reserve);
    enc.writeUint16(player.reloadRem | 0);
    enc.writeUint8(player.grenades === undefined ? 2 : player.grenades);
    return enc.getBuffer();
}

function encodePlayerLeft(playerId) {
    const enc = new BinaryEncoder().init(16);
    enc.writeUint8(MESSAGE_TYPES.PLAYER_LEFT);
    enc.writeUint32(playerId);
    return enc.getBuffer();
}

function encodeChatMessage(msg) {
    const enc = new BinaryEncoder().init(1024);
    enc.writeUint8(MESSAGE_TYPES.CHAT_MESSAGE);
    enc.writeUint32(msg.playerId || 0);
    enc.writeString(msg.playerName || '');
    enc.writeString(msg.content || '');
    return enc.getBuffer();
}

function encodePlayerHit(msg) {
    const enc = new BinaryEncoder().init(32);
    enc.writeUint8(MESSAGE_TYPES.PLAYER_HIT);
    enc.writeUint32(msg.targetId || 0);
    enc.writeUint32(msg.shooterId || 0);
    enc.writeUint8(Math.max(0, Math.min(255, msg.damage || 0)));
    enc.writeUint8(msg.isKill ? 1 : 0);
    return enc.getBuffer();
}

function encodeBulletHitWall(msg) {
    const enc = new BinaryEncoder().init(32);
    enc.writeUint8(MESSAGE_TYPES.BULLET_HIT_WALL);
    enc.writeFloat32(msg.x || 0);
    enc.writeFloat32(msg.y || 0);
    enc.writeString(String(msg.bulletId || ''));
    return enc.getBuffer();
}

function encodePlayerRespawnMsg(msg) {
    const enc = new BinaryEncoder().init(32);
    enc.writeUint8(MESSAGE_TYPES.PLAYER_RESPAWN);
    enc.writeUint32(msg.playerId || 0);
    enc.writeFloat32(msg.x || 0);
    enc.writeFloat32(msg.y || 0);
    enc.writeUint8(Math.max(0, Math.min(100, msg.health || 0)));
    return enc.getBuffer();
}

function encodeKillFeedMsg(msg) {
    const enc = new BinaryEncoder().init(256);
    enc.writeUint8(MESSAGE_TYPES.KILL_FEED);
    enc.writeString(msg.killInfo?.killer || '');
    enc.writeString(msg.killInfo?.victim || '');
    enc.writeString(msg.killInfo?.weapon || '');
    enc.writeUint32((msg.killInfo?.timestamp || Date.now()) >>> 0);
    return enc.getBuffer();
}

function encodePowerupPickedUpMsg(msg) {
    const enc = new BinaryEncoder().init(32);
    enc.writeUint8(MESSAGE_TYPES.POWERUP_PICKED_UP);
    enc.writeUint32(msg.powerupId || 0);
    enc.writeUint32(msg.playerId || 0);
    enc.writeUint8(getPowerupTypeId(msg.powerupType || 'unknown'));
    return enc.getBuffer();
}

function encodePowerupSpawnedMsg(msg) {
    const enc = new BinaryEncoder().init(32);
    enc.writeUint8(MESSAGE_TYPES.POWERUP_SPAWNED);
    const p = msg.powerup || {};
    enc.writeUint32(p.id || 0);
    enc.writeUint8(getPowerupTypeId(p.type || 'unknown'));
    enc.writeFloat32(p.x || 0);
    enc.writeFloat32(p.y || 0);
    return enc.getBuffer();
}

function encodeMeleeAttack(msg) {
    const enc = new BinaryEncoder().init(64);
    enc.writeUint8(MESSAGE_TYPES.MELEE_ATTACK);
    enc.writeUint32(msg.attackerId || 0);
    enc.writeUint32(msg.targetId || 0);
    enc.writeFloat32(msg.targetX || 0);
    enc.writeFloat32(msg.targetY || 0);
    enc.writeUint8(Math.max(0, Math.min(255, msg.damage || 0)));
    enc.writeUint8(msg.isKill ? 1 : 0);
    enc.writeFloat32(msg.x || 0); // 攻击者当前位置x
    enc.writeFloat32(msg.y || 0); // 攻击者当前位置y
    return enc.getBuffer();
}

// 二进制解码器
class BinaryDecoder {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.offset = 0;
    }
    
    readUint8() {
        const value = this.view.getUint8(this.offset);
        this.offset += 1;
        return value;
    }
    
    readUint16() {
        const value = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return value;
    }
    
    readUint32() {
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }
    
    readFloat32() {
        const value = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return value;
    }
    
    readString() {
        const length = this.readUint16();
        const bytes = new Uint8Array(this.view.buffer, this.offset, length);
        this.offset += length;
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
}

// 编码游戏状态更新消息
function encodeGameStateUpdate(gameState) {
    const encoder = new BinaryEncoder().init(8192);
    
    encoder.writeUint8(MESSAGE_TYPES.GAME_UPDATE);
    
    // 写入玩家数量
    const players = Array.from(gameState.players.values());
    encoder.writeUint16(players.length);
    
    // 写入每个玩家数据
    players.forEach(player => {
        encoder.writeUint32(player.id);
        encoder.writeFloat32(player.x);
        encoder.writeFloat32(player.y);
        encoder.writeFloat32(player.angle);
        encoder.writeUint8(player.health);
        encoder.writeUint16(Math.min(65535, player.score));
        encoder.writeUint8(player.isAlive ? 1 : 0);

        // 写入颜色与队伍（静态）
        encoder.writeString(player.color || '#3498db');
        encoder.writeUint8(player.team || 0);

        // 写入道具状态（简单序列化）
        encoder.writeUint8(player.powerups && player.powerups.shield && player.powerups.shield.active ? 1 : 0);
        encoder.writeUint8(player.powerups && player.powerups.rapidFire && player.powerups.rapidFire.active ? 1 : 0);
        encoder.writeUint8(player.powerups && player.powerups.damageBoost && player.powerups.damageBoost.active ? 1 : 0);

        // 武器状态
        const ws = weaponNetState(player);
        encoder.writeUint8(ws.w);
        encoder.writeUint8(ws.mag);
        encoder.writeUint8(ws.res);
        encoder.writeUint16(ws.rel);
        encoder.writeUint8(ws.g);
    });

    // 写入子弹数量和数据
    encoder.writeUint16(gameState.bullets.length);
    gameState.bullets.forEach(bullet => {
        // 统一使用字符串ID，便于与客户端兼容
        encoder.writeString(String(bullet.id));
        encoder.writeFloat32(bullet.x);
        encoder.writeFloat32(bullet.y);
        encoder.writeFloat32(bullet.vx);
        encoder.writeFloat32(bullet.vy);
        encoder.writeUint32(bullet.ownerId);
        encoder.writeUint8(bullet.damage);
        encoder.writeUint8(bullet.kind | 0);
    });
    
    // 写入道具数量和数据
    encoder.writeUint16(gameState.powerups.length);
    gameState.powerups.forEach(powerup => {
        encoder.writeUint32(powerup.id);
        // 使用类型ID代替字符串以减小体积
        try {
            encoder.writeUint8(getPowerupTypeId(powerup.type));
        } catch (e) {
            encoder.writeUint8(0);
        }
        encoder.writeFloat32(powerup.x);
        encoder.writeFloat32(powerup.y);
    });
    
    // 写入剩余时间（毫秒）
    let remainingTime = 0;
    if (gameState.gameStartTime && !gameState.isGameEnded) {
        const now = Date.now();
        remainingTime = Math.max(0, gameState.gameDuration - (now - gameState.gameStartTime));
    }
    encoder.writeUint32(remainingTime);

    return encoder.getBuffer();
}

// encodeBulletShot 函数已移除，不再需要单独的子弹射击消息

// 编码初始完整游戏状态（用于新加入玩家）
function encodeInitialGameState(state) {
    const encoder = new BinaryEncoder().init(16384);
    encoder.writeUint8(MESSAGE_TYPES.GAME_STATE);

    // 玩家
    const players = Array.from(state.players.values());
    encoder.writeUint16(players.length);
    players.forEach(player => {
        encoder.writeUint32(player.id);
        encoder.writeString(player.nickname);
        encoder.writeFloat32(player.x);
        encoder.writeFloat32(player.y);
        encoder.writeFloat32(player.angle);
        encoder.writeUint8(player.health);
        encoder.writeUint16(Math.min(65535, Math.max(0, Math.floor(player.score || 0))));
        encoder.writeUint8(player.isAlive ? 1 : 0);
        encoder.writeString(player.color);
        encoder.writeUint8(player.team || 0);
        // powerups flags
        encoder.writeUint8(player.powerups.shield.active ? 1 : 0);
        encoder.writeUint8(player.powerups.rapidFire.active ? 1 : 0);
        encoder.writeUint8(player.powerups.damageBoost.active ? 1 : 0);

        // 武器状态
        const ws = weaponNetState(player);
        encoder.writeUint8(ws.w);
        encoder.writeUint8(ws.mag);
        encoder.writeUint8(ws.res);
        encoder.writeUint16(ws.rel);
        encoder.writeUint8(ws.g);
    });

    // 子弹
    encoder.writeUint16(state.bullets.length);
    state.bullets.forEach(bullet => {
        encoder.writeString(String(bullet.id));
        encoder.writeFloat32(bullet.x);
        encoder.writeFloat32(bullet.y);
        encoder.writeFloat32(bullet.vx);
        encoder.writeFloat32(bullet.vy);
        encoder.writeUint32(bullet.ownerId);
        encoder.writeUint8(bullet.damage);
        encoder.writeUint8(bullet.kind | 0);
    });

    // 道具（包含颜色和图标，便于渲染）
    encoder.writeUint16(state.powerups.length);
    state.powerups.forEach(p => {
        encoder.writeUint32(p.id);
        encoder.writeString(p.type);
        encoder.writeFloat32(p.x);
        encoder.writeFloat32(p.y);
        encoder.writeString(p.getColor ? p.getColor() : '#95a5a6');
        encoder.writeString(p.getIcon ? p.getIcon() : '?');
    });

    // 地形
    encoder.writeUint16(state.terrain.length);
    state.terrain.forEach(t => {
        encoder.writeUint32(t.id);
        encoder.writeFloat32(t.x);
        encoder.writeFloat32(t.y);
        encoder.writeFloat32(t.width);
        encoder.writeFloat32(t.height);
        encoder.writeString(t.type || 'wall');
    });

    return encoder.getBuffer();
}

// 解码客户端消息
function decodeMessage(buffer) {
    try {
        const decoder = new BinaryDecoder(buffer);
        const messageType = decoder.readUint8();
        
        switch (messageType) {
            case MESSAGE_TYPES.JOIN:
                return {
                    type: 'join',
                    nickname: decoder.readString(),
                    clientTime: decoder.readUint32()
                };
                
            case MESSAGE_TYPES.MOVE:
                return {
                    type: 'move',
                    x: decoder.readFloat32(),
                    y: decoder.readFloat32(),
                    angle: decoder.readFloat32()
                };
                
            case MESSAGE_TYPES.SHOOT:
                return {
                    type: 'shoot',
                    targetX: decoder.readFloat32(),
                    targetY: decoder.readFloat32()
                };

            case MESSAGE_TYPES.RELOAD:
                return { type: 'reload' };

            case MESSAGE_TYPES.GRENADE:
                return {
                    type: 'grenade',
                    targetX: decoder.readFloat32(),
                    targetY: decoder.readFloat32()
                };
                
            case MESSAGE_TYPES.MELEE:
                return {
                    type: 'melee',
                    targetX: decoder.readFloat32(),
                    targetY: decoder.readFloat32()
                };
                
            case MESSAGE_TYPES.RESPAWN:
                return { type: 'respawn' };
            
            case MESSAGE_TYPES.CHAT:
                return {
                    type: 'chatMessage',
                    content: decoder.readString()
                };
                
            case MESSAGE_TYPES.PING:
                return {
                    type: 'ping',
                    timestamp: decoder.readUint32()
                };
                
            default:
                console.log('未知的二进制消息类型:', messageType);
                return null;
        }
    } catch (error) {
        console.log('二进制解码错误:', error);
        return null;
    }
}

// 道具类型
const POWERUP_TYPES = {
    SHIELD: 'shield',
    RAPID_FIRE: 'rapid_fire',
    DAMAGE_BOOST: 'damage_boost',
    HEAL: 'heal',
    WEAPON_SMG: 'weapon_smg',
    WEAPON_SHOTGUN: 'weapon_shotgun',
    WEAPON_SNIPER: 'weapon_sniper',
    WEAPON_RPG: 'weapon_rpg',
    GRENADE_PACK: 'grenade_pack'
};

// 道具箱类型 → 武器 id（非武器箱返回 null）
function powerupWeapon(type) {
    switch (type) {
        case POWERUP_TYPES.WEAPON_SMG: return 'smg';
        case POWERUP_TYPES.WEAPON_SHOTGUN: return 'shotgun';
        case POWERUP_TYPES.WEAPON_SNIPER: return 'sniper';
        case POWERUP_TYPES.WEAPON_RPG: return 'rpg';
        default: return null;
    }
}

// 玩家颜色配置
const PLAYER_COLORS = [
    '#e74c3c', // 红色
    '#3498db', // 蓝色
    '#2ecc71', // 绿色
    '#f39c12', // 橙色
    '#9b59b6', // 紫色
    '#1abc9c', // 青色
    '#e67e22', // 深橙色
    '#34495e', // 深灰色
    '#f1c40f', // 黄色
    '#e91e63'  // 粉色
];

// ===================== 分队工具 =====================
function countTeamMembers(team) {
    let n = 0;
    gameState.players.forEach(p => { if (p.team === team) n++; });
    return n;
}

// 自动均衡：加入人数较少的一队，人数相同进红队
function pickBalancedTeam() {
    return countTeamMembers(1) <= countTeamMembers(2) ? 1 : 2;
}

function applyTeamColor(player) {
    if (player.team === 1 || player.team === 2) {
        const palette = TEAM_COLORS[player.team];
        player.color = palette[(player.id - 1) % palette.length];
    } else {
        player.color = PLAYER_COLORS[(player.id - 1) % PLAYER_COLORS.length];
    }
}

function isSameTeam(a, b) {
    return !!(a && b && a.team && b.team && a.team === b.team);
}

// 统一出生点选择：分队模式在本队出生区内取点，否则全图随机
function findSpawnPosition(team, selfId) {
    const size = GAME_CONFIG.PLAYER_SIZE;
    const map = MAPS[matchConfig.mapId] || MAPS[DEFAULT_MAP_ID];
    const zone = (matchConfig.teamMode && (team === 1 || team === 2) && map.teamZones) ? map.teamZones[team] : null;
    const randomPoint = () => zone
        ? { x: zone.x + Math.random() * (zone.w - size), y: zone.y + Math.random() * (zone.h - size) }
        : { x: Math.random() * (GAME_CONFIG.CANVAS_WIDTH - size), y: Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - size) };

    // 第一轮：避开地形且与其他存活玩家保持距离
    for (let i = 0; i < 100; i++) {
        const p = randomPoint();
        if (checkTerrainCollision(p.x, p.y, size, size)) continue;
        let nearOther = false;
        gameState.players.forEach(other => {
            if (other.id !== selfId && other.isAlive) {
                if (Math.hypot(p.x - other.x, p.y - other.y) < size * 2) nearOther = true;
            }
        });
        if (!nearOther) return p;
    }
    // 第二轮：只避开地形
    for (let i = 0; i < 50; i++) {
        const p = randomPoint();
        if (!checkTerrainCollision(p.x, p.y, size, size)) return p;
    }
    return { x: 60, y: 60 };
}

// 玩家类
class Player {
    constructor(id, nickname, x, y) {
        this.id = id;
        this.nickname = nickname;
        this.x = x;
        this.y = y;
        this.angle = 0;
        this.health = GAME_CONFIG.MAX_HEALTH;
        this.score = 0;
        this.isAlive = true;
        this.respawnTime = 0;
        this.lastShot = 0;
        this.lastMelee = 0;
        // 武器与弹药
        this.weapon = 'rifle';
        this.mag = WEAPONS.rifle.magSize;
        this.reserve = -1; // -1 = 无限备弹（步枪）
        this.reloading = false;
        this.reloadEnd = 0;
        // 手雷
        this.grenades = GRENADE.carry;
        this.lastGrenade = 0;
        this.meleeCooldown = GAME_CONFIG.MELEE_COOLDOWN; // 近战攻击冷却时间
        this.team = 0; // 0=无队伍（个人混战），1=红队，2=蓝队
        this.color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]; // 根据ID分配颜色（分队模式下由applyTeamColor覆盖）
        
        // 移动状态跟踪
        this.vx = 0;
        this.vy = 0;
        this.isMoving = false;
        this.lastMoveTime = 0;
        
        // 道具效果
        this.powerups = {
            shield: { active: false, endTime: 0 },
            rapidFire: { active: false, endTime: 0 },
            damageBoost: { active: false, endTime: 0 }
        };
    }

    update(deltaTime = 16) {
        if (!this.isAlive && this.respawnTime > 0) {
            this.respawnTime -= deltaTime; // 使用实际时间差
            if (this.respawnTime <= 0) {
                this.respawn();
            }
        }
        
        // 更新移动状态
        const now = Date.now();
        if (this.lastMoveTime && (now - this.lastMoveTime) > 100) {
            this.isMoving = false;
            this.vx = 0;
            this.vy = 0;
        }
        
        // 更新道具效果
        Object.keys(this.powerups).forEach(key => {
            if (this.powerups[key].active && now > this.powerups[key].endTime) {
                this.powerups[key].active = false;
            }
        });

        // 完成换弹
        if (this.reloading && now >= this.reloadEnd) {
            this.reloading = false;
            const magSize = WEAPONS[this.weapon].magSize;
            const need = magSize - this.mag;
            if (this.reserve < 0) {
                this.mag = magSize;
            } else {
                const take = Math.min(need, this.reserve);
                this.mag += take;
                this.reserve -= take;
            }
        }
    }

    // 换上武器（拾取武器箱时调用）
    equipWeapon(weaponId) {
        const w = WEAPONS[weaponId];
        if (!w) return;
        this.weapon = weaponId;
        this.mag = w.magSize;
        this.reserve = w.reserve;
        this.reloading = false;
        this.reloadEnd = 0;
    }

    // 开始换弹；弹尽的特殊武器自动换回步枪
    startReload() {
        if (!this.isAlive || this.reloading) return;
        const w = WEAPONS[this.weapon];
        if (this.mag >= w.magSize) return;
        if (this.reserve === 0) {
            // 备弹耗尽：换回默认步枪
            this.equipWeapon('rifle');
            return;
        }
        this.reloading = true;
        this.reloadEnd = Date.now() + w.reloadMs;
    }
    
    move(dx, dy) {
        if (!this.isAlive) return;
        
        const size = GAME_CONFIG.PLAYER_SIZE;
        let movedX = false, movedY = false;
        
        // 先沿X轴尝试移动（轴向分离），如果不碰撞则更新X
        if (dx !== 0) {
            const tryX = this.x + dx;
            const outOfBoundsX = (tryX < 0 || tryX + size > GAME_CONFIG.CANVAS_WIDTH);
            if (!outOfBoundsX && !checkTerrainCollision(tryX, this.y, size, size)) {
                this.x = tryX;
                this.vx = dx;
                movedX = true;
            } else {
                this.vx = 0;
            }
        } else {
            this.vx = 0;
        }
        
        // 再沿Y轴尝试移动
        if (dy !== 0) {
            const tryY = this.y + dy;
            const outOfBoundsY = (tryY < 0 || tryY + size > GAME_CONFIG.CANVAS_HEIGHT);
            if (!outOfBoundsY && !checkTerrainCollision(this.x, tryY, size, size)) {
                this.y = tryY;
                this.vy = dy;
                movedY = true;
            } else {
                this.vy = 0;
            }
        } else {
            this.vy = 0;
        }
        
        this.isMoving = movedX || movedY;
        if (this.isMoving) {
            this.lastMoveTime = Date.now();
        }
    }

    respawn() {
        // 统一出生点选择（分队模式回本队出生区复活）
        const spawn = findSpawnPosition(this.team, this.id);
        this.x = spawn.x;
        this.y = spawn.y;
        this.health = GAME_CONFIG.MAX_HEALTH;
        this.isAlive = true;
        this.respawnTime = 0;
        this.equipWeapon('rifle'); // 复活重置为默认武器
        this.grenades = GRENADE.carry;
    }

    // 投掷手雷：朝目标点飞行，到落点（或撞墙停驻）后由引信起爆
    throwGrenade(targetX, targetY) {
        const now = Date.now();
        if (!this.isAlive || this.grenades <= 0) return null;
        if (now - (this.lastGrenade || 0) < GRENADE.cooldownMs) return null;
        this.lastGrenade = now;
        this.grenades--;

        const cx = this.x + GAME_CONFIG.PLAYER_SIZE / 2;
        const cy = this.y + GAME_CONFIG.PLAYER_SIZE / 2;
        let dx = targetX - cx, dy = targetY - cy;
        let dist = Math.hypot(dx, dy);
        if (!dist || dist < 1e-3) {
            dx = Math.cos(this.angle || 0);
            dy = Math.sin(this.angle || 0);
            dist = 1;
        }
        const throwDist = Math.min(GRENADE.maxThrow, Math.max(60, dist));
        return new Bullet(
            cx + (dx / dist) * 14, cy + (dy / dist) * 14,
            (dx / dist) * GRENADE.speed, (dy / dist) * GRENADE.speed,
            this.id, 0, GRENADE.fuseMs,
            {
                kind: 2,
                blastRadius: GRENADE.blastRadius,
                blastDamage: GRENADE.blastDamage,
                weaponName: '手雷',
                originX: cx, originY: cy, throwDist
            }
        );
    }

    takeDamage(damage) {
        if (!this.isAlive) return;
        
        // 护盾效果：减少50%伤害
        if (this.powerups.shield.active) {
            damage = Math.floor(damage * 0.5);
        }
        
        this.health -= damage;
        if (this.health <= 0) {
            this.isAlive = false;
            this.respawnTime = GAME_CONFIG.RESPAWN_TIME;
        }
    }

    canShoot() {
        if (!this.isAlive || this.reloading) return false;
        if (this.mag <= 0) return false;
        const now = Date.now();
        let cooldown = WEAPONS[this.weapon].fireRate;

        // 快速射击效果：减少50%冷却时间
        if (this.powerups.rapidFire.active) {
            cooldown = Math.floor(cooldown * 0.5);
        }

        return (now - this.lastShot) >= cooldown;
    }

    // 开火；返回子弹数组（霰弹枪一次多发），不可开火返回 null
    shoot(targetX, targetY) {
        // 空仓时自动开始换弹
        if (this.isAlive && !this.reloading && this.mag <= 0) {
            this.startReload();
            return null;
        }
        if (!this.canShoot()) return null;

        this.lastShot = Date.now();
        this.mag--;
        
        // 计算子弹方向
        const centerX = this.x + GAME_CONFIG.PLAYER_SIZE / 2;
        const centerY = this.y + GAME_CONFIG.PLAYER_SIZE / 2;
        let dx = targetX - centerX;
        let dy = targetY - centerY;
        let distance = Math.sqrt(dx * dx + dy * dy);
        
        // 距离过小（例如点击在玩家中心）使用当前朝向作为方向，避免产生 NaN
        let dirX, dirY;
        if (!distance || distance < 1e-3) {
            const angle = this.angle || 0;
            dirX = Math.cos(angle);
            dirY = Math.sin(angle);
            // 备用，防止角度也异常
            if (!dirX && !dirY) {
                dirX = 1; dirY = 0;
            }
        } else {
            dirX = dx / distance;
            dirY = dy / distance;
        }
        
        // 将子弹出生点前移，避免与自身或紧贴的墙体立即发生碰撞
        const w = WEAPONS[this.weapon];
        const muzzleOffset = GAME_CONFIG.PLAYER_SIZE / 2 + 4;
        const startX = centerX + dirX * muzzleOffset;
        const startY = centerY + dirY * muzzleOffset;

        // 计算伤害
        let damage = w.damage;
        if (this.powerups.damageBoost.active) {
            damage = Math.floor(damage * 1.5);
        }

        // 按武器弹丸数与散布生成子弹（霰弹枪一次多发扇形）
        const baseAngle = Math.atan2(dirY, dirX);
        const bullets = [];
        for (let i = 0; i < w.pellets; i++) {
            let a = baseAngle;
            if (w.pellets > 1) {
                a += (i - (w.pellets - 1) / 2) * (w.spread / (w.pellets - 1) * 2)
                    + (Math.random() - 0.5) * 0.04;
            } else if (w.spread > 0) {
                a += (Math.random() - 0.5) * w.spread;
            }
            bullets.push(new Bullet(
                startX, startY,
                Math.cos(a) * w.speed,
                Math.sin(a) * w.speed,
                this.id,
                damage,
                w.lifeMs,
                w.kind ? { kind: w.kind, blastRadius: w.blastRadius, blastDamage: damage, weaponName: w.name } : undefined
            ));
        }

        // 打完最后一发自动换弹
        if (this.mag <= 0) this.startReload();

        return bullets;
    }

    canMelee() {
        if (!this.isAlive) return false;
        const now = Date.now();
        const cooldown = this.powerups.rapidFire.active ? this.meleeCooldown / 2 : this.meleeCooldown;
        return this.isAlive && (now - this.lastMelee) >= cooldown;
    }

    meleeAttack(targetX, targetY) {
        if (!this.canMelee()) return false;

        this.lastMelee = Date.now();
        
        // 计算攻击方向
        const dx = targetX - this.x;
        const dy = targetY - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // 近战攻击总是执行，不管目标距离多远
        
        // 计算伤害
        let damage = GAME_CONFIG.MELEE_DAMAGE;
        if (this.powerups.damageBoost.active) {
            damage = Math.floor(damage * 1.5);
        }
        
        // 查找攻击范围内的玩家（分队模式下不伤害队友）
        let hitPlayer = null;
        gameState.players.forEach(player => {
            if (player.id !== this.id && player.isAlive && !isSameTeam(player, this)) {
                const playerDx = player.x - this.x;
                const playerDy = player.y - this.y;
                const playerDistance = Math.sqrt(playerDx * playerDx + playerDy * playerDy);
                
                if (playerDistance <= GAME_CONFIG.MELEE_RANGE) {
                    hitPlayer = player;
                }
            }
        });
        
        if (hitPlayer) {
            const wasAlive = hitPlayer.isAlive;
            hitPlayer.takeDamage(damage);
            
            if (wasAlive && !hitPlayer.isAlive) {
                // 击杀
                this.score = Math.min(65535, (this.score || 0) + 100);
                // 添加击杀信息
                const killInfo = {
                    killer: this.nickname,
                    victim: hitPlayer.nickname,
                    weapon: '刀了',
                    timestamp: Date.now()
                };
                gameState.killFeed.push(killInfo);
                
                // 立即广播击杀信息
                broadcast({
                    type: 'killFeed',
                    killInfo: killInfo
                });
            } else {
                // 击中但未击杀
                this.score = Math.min(65535, (this.score || 0) + 10);
            }
            
            // 广播近战攻击事件
            broadcast({
                type: 'meleeAttack',
                attackerId: this.id,
                targetId: hitPlayer.id,
                targetX: targetX,
                targetY: targetY,
                damage: damage,
                isKill: wasAlive && !hitPlayer.isAlive,
                x: this.x,
                y: this.y
            });
        } else {
            // 广播近战攻击事件（未击中）
            broadcast({
                type: 'meleeAttack',
                attackerId: this.id,
                targetId: null,
                targetX: targetX,
                targetY: targetY,
                damage: 0,
                isKill: false,
                x: this.x,
                y: this.y
            });
        }
        
        return true;
    }
}

// 子弹类
class Bullet {
    constructor(x, y, vx, vy, ownerId, damage = 25, lifeMs = 2000, opts = undefined) {
        this.id = Date.now() + Math.random();
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.ownerId = ownerId;
        this.damage = damage;
        this.life = lifeMs; // 生命周期(毫秒)；霰弹枪较短形成射程限制
        this.createdTime = Date.now();
        this.kind = 0; // 0=子弹 1=火箭弹 2=手雷
        if (opts) {
            this.kind = opts.kind || 0;
            this.blastRadius = opts.blastRadius;
            this.blastDamage = opts.blastDamage;
            this.weaponName = opts.weaponName;
            this.originX = opts.originX;
            this.originY = opts.originY;
            this.throwDist = opts.throwDist;
        }
    }

    update(deltaTime = 16) {
        this.x += this.vx;
        this.y += this.vy;
        this.life -= deltaTime; // 使用时间差减少生命值
    }

    isDead() {
        return this.life <= 0 || 
               this.x < 0 || this.x > GAME_CONFIG.CANVAS_WIDTH ||
               this.y < 0 || this.y > GAME_CONFIG.CANVAS_HEIGHT;
    }
}

// 道具类
class Powerup {
    constructor(id, type, x, y) {
        this.id = id;
        this.type = type;
        this.x = x;
        this.y = y;
        this.size = GAME_CONFIG.POWERUP_SIZE;
        this.spawnTime = Date.now();
    }

    getColor() {
        switch (this.type) {
            case POWERUP_TYPES.SHIELD:
                return '#9b59b6'; // 紫色
            case POWERUP_TYPES.RAPID_FIRE:
                return '#e67e22'; // 橙色
            case POWERUP_TYPES.DAMAGE_BOOST:
                return '#e74c3c'; // 红色
            case POWERUP_TYPES.HEAL:
                return '#27ae60'; // 绿色
            case POWERUP_TYPES.WEAPON_SMG:
            case POWERUP_TYPES.WEAPON_SHOTGUN:
            case POWERUP_TYPES.WEAPON_SNIPER:
            case POWERUP_TYPES.WEAPON_RPG:
                return '#fbbf24'; // 金色：武器箱
            case POWERUP_TYPES.GRENADE_PACK:
                return '#84cc16'; // 橄榄绿：手雷补给
            default:
                return '#95a5a6'; // 灰色
        }
    }

    getIcon() {
        switch (this.type) {
            case POWERUP_TYPES.SHIELD:
                return '◊'; // 菱形，代表护盾
            case POWERUP_TYPES.RAPID_FIRE:
                return '▲'; // 三角形，代表快速
            case POWERUP_TYPES.DAMAGE_BOOST:
                return '●'; // 圆点，代表力量
            case POWERUP_TYPES.HEAL:
                return '+'; // 十字，代表回血
            case POWERUP_TYPES.WEAPON_SMG:
                return '冲';
            case POWERUP_TYPES.WEAPON_SHOTGUN:
                return '霰';
            case POWERUP_TYPES.WEAPON_SNIPER:
                return '狙';
            case POWERUP_TYPES.WEAPON_RPG:
                return '炮';
            case POWERUP_TYPES.GRENADE_PACK:
                return '雷';
            default:
                return '?';
        }
    }
}

// 碰撞检测
function checkCollision(rect1, rect2) {
    return rect1.x < rect2.x + rect2.width &&
           rect1.x + rect1.width > rect2.x &&
           rect1.y < rect2.y + rect2.height &&
           rect1.y + rect1.height > rect2.y;
}

// ===================== AI 机器人 =====================
const BOT_LIMIT = 8;
const BOT_NAMES = ['猎手', '疾风', '影子', '磐石', '夜枭', '闪电', '幽灵', '狂狼'];
const bots = new Map(); // playerId -> 机器人状态

function addBot() {
    if (bots.size >= BOT_LIMIT) return false;
    const playerId = gameState.nextPlayerId++;
    const team = matchConfig.teamMode ? pickBalancedTeam() : 0;
    const spawn = findSpawnPosition(team, playerId);
    const name = 'AI·' + BOT_NAMES[(playerId - 1) % BOT_NAMES.length];
    const player = new Player(playerId, name, spawn.x, spawn.y);
    player.isBot = true;
    player.team = team;
    applyTeamColor(player);
    gameState.players.set(playerId, player);
    bots.set(playerId, {
        waypointX: spawn.x,
        waypointY: spawn.y,
        enemyId: null,
        nextThink: 0,
        nextShot: 0,
        stuckCheckAt: 0,
        stuckX: spawn.x,
        stuckY: spawn.y,
        aimErr: 0.6 + Math.random() * 0.5 // 个体差异：散布系数，避免机器人枪法一致
    });
    const botWs = weaponNetState(player);
    broadcast({
        type: 'playerJoined',
        player: {
            id: player.id,
            nickname: player.nickname,
            x: player.x,
            y: player.y,
            angle: player.angle,
            health: player.health,
            score: player.score,
            isAlive: player.isAlive,
            color: player.color,
            team: player.team,
            powerups: player.powerups,
            weapon: botWs.w,
            mag: botWs.mag,
            reserve: botWs.res,
            reloadRem: botWs.rel,
            grenades: botWs.g
        }
    });
    return true;
}

function removeBot() {
    const ids = Array.from(bots.keys());
    if (ids.length === 0) return false;
    const id = ids[ids.length - 1];
    bots.delete(id);
    gameState.players.delete(id);
    gameState.lastPlayerStates.delete(id);
    broadcast({ type: 'playerLeft', playerId: id });
    return true;
}

function setBotCount(n) {
    const target = Math.max(0, Math.min(BOT_LIMIT, n | 0));
    while (bots.size < target) { if (!addBot()) break; }
    while (bots.size > target) { if (!removeBot()) break; }
    return bots.size;
}

function humanPlayerCount() {
    return gameState.players.size - bots.size;
}

// 简单视线检测：沿连线采样，看是否被地形挡住
function hasLineOfSight(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(1, Math.ceil(dist / 20));
    for (let i = 1; i < steps; i++) {
        const px = x1 + (dx * i) / steps;
        const py = y1 + (dy * i) / steps;
        if (checkTerrainCollision(px - 2, py - 2, 4, 4)) return false;
    }
    return true;
}

// 决策：选敌人、定路点（低频调用）
function botThink(me, bot) {
    const size = GAME_CONFIG.PLAYER_SIZE;
    const cx = me.x + size / 2, cy = me.y + size / 2;

    // 选最近的可见敌人（真人和其他机器人都打，分队模式下不打队友）
    let best = null, bestDist = Infinity;
    gameState.players.forEach(p => {
        if (p.id === me.id || !p.isAlive || isSameTeam(p, me)) return;
        const px = p.x + size / 2, py = p.y + size / 2;
        const d = Math.hypot(px - cx, py - cy);
        if (d < bestDist && d < 520 && hasLineOfSight(cx, cy, px, py)) {
            best = p;
            bestDist = d;
        }
    });
    bot.enemyId = best ? best.id : null;

    if (best) {
        // 交战走位：保持中距离并横向游走
        const px = best.x + size / 2, py = best.y + size / 2;
        const ang = Math.atan2(py - cy, px - cx);
        const strafe = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
        let ax = Math.cos(ang + strafe), ay = Math.sin(ang + strafe);
        if (bestDist > 280) { ax += Math.cos(ang); ay += Math.sin(ang); }
        else if (bestDist < 150) { ax -= Math.cos(ang); ay -= Math.sin(ang); }
        const alen = Math.hypot(ax, ay) || 1;
        bot.waypointX = cx + (ax / alen) * 140;
        bot.waypointY = cy + (ay / alen) * 140;
    } else {
        // 巡逻：优先去附近道具，否则随机换目标点
        let target = null, td = Infinity;
        gameState.powerups.forEach(p => {
            const d = Math.hypot(p.x - cx, p.y - cy);
            if (d < 420 && d < td && hasLineOfSight(cx, cy, p.x, p.y)) { target = p; td = d; }
        });
        if (target) {
            bot.waypointX = target.x;
            bot.waypointY = target.y;
        } else if (Math.hypot(bot.waypointX - cx, bot.waypointY - cy) < 40 || Math.random() < 0.25) {
            const m = 80;
            bot.waypointX = m + Math.random() * (GAME_CONFIG.CANVAS_WIDTH - m * 2);
            bot.waypointY = m + Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - m * 2);
        }
    }
}

// 每逻辑帧驱动机器人（移动/瞄准/开火走与真人相同的规则和冷却）
function updateBots(now) {
    if (bots.size === 0 || gameState.isGameEnded) return;
    const size = GAME_CONFIG.PLAYER_SIZE;
    const speed = GAME_CONFIG.PLAYER_SPEED;

    bots.forEach((bot, id) => {
        const me = gameState.players.get(id);
        if (!me) { bots.delete(id); return; }
        if (!me.isAlive) return; // 复活由 Player.update 自动处理

        if (now >= bot.nextThink) {
            bot.nextThink = now + 250 + Math.random() * 250;
            botThink(me, bot);
        }

        const cx = me.x + size / 2, cy = me.y + size / 2;

        // 朝路点移动（复用 Player.move，与真人一样受碰撞约束和速度限制）
        const wdx = bot.waypointX - cx, wdy = bot.waypointY - cy;
        const wd = Math.hypot(wdx, wdy);
        if (wd > 8) {
            me.move((wdx / wd) * speed, (wdy / wd) * speed);
        }

        // 卡住检测：一段时间没挪动就换随机路点
        if (now - bot.stuckCheckAt > 600) {
            if (wd > 12 && Math.hypot(me.x - bot.stuckX, me.y - bot.stuckY) < 6) {
                const m = 80;
                bot.waypointX = m + Math.random() * (GAME_CONFIG.CANVAS_WIDTH - m * 2);
                bot.waypointY = m + Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - m * 2);
            }
            bot.stuckX = me.x;
            bot.stuckY = me.y;
            bot.stuckCheckAt = now;
        }

        // 战斗（开火前再校验一次队伍，防止目标中途换队）
        const enemy = bot.enemyId ? gameState.players.get(bot.enemyId) : null;
        if (enemy && enemy.isAlive && !isSameTeam(enemy, me)) {
            const ex = enemy.x + size / 2, ey = enemy.y + size / 2;
            const d = Math.hypot(ex - cx, ey - cy);
            me.angle = Math.atan2(ey - cy, ex - cx);

            if (d <= GAME_CONFIG.MELEE_RANGE * 0.9 && me.canMelee()) {
                me.meleeAttack(ex, ey);
            } else if (now >= bot.nextShot && me.canShoot() && hasLineOfSight(cx, cy, ex, ey)) {
                // 简单移动预判 + 按距离放大的散布，保证打得中但不变态
                const lead = Math.min(30, d * 0.12);
                const tx = ex + (enemy.vx || 0) * lead + (Math.random() - 0.5) * d * 0.22 * bot.aimErr;
                const ty = ey + (enemy.vy || 0) * lead + (Math.random() - 0.5) * d * 0.22 * bot.aimErr;
                const botBullets = me.shoot(tx, ty);
                if (botBullets) botBullets.forEach(b => gameState.bullets.push(b));
                const botRate = Math.max(WEAPONS[me.weapon].fireRate, 220);
                bot.nextShot = now + botRate + Math.random() * 340;
            }
        } else if (wd > 8) {
            // 无敌人时面朝移动方向
            me.angle = Math.atan2(wdy, wdx);
        }
    });
}

// 高级消息压缩和序列化系统
const messageCache = new Map();
const messageIdCounter = { value: 0 };

// 检查是否应该使用二进制格式
function shouldUseBinary(messageType) {
    // 改为对核心高频与重要事件全部使用二进制
    return (
        messageType === 'gameState' ||
        messageType === 'gameUpdate' ||
        messageType === 'incrementalUpdate' ||
        messageType === 'gameEnd' ||
        messageType === 'newGameStart' ||
        messageType === 'gameStarted' ||
        messageType === 'playerJoined' ||
        messageType === 'playerLeft' ||
        messageType === 'chatMessage' ||
        messageType === 'playerHit' ||
        messageType === 'bulletHitWall' ||
        messageType === 'playerRespawn' ||
        messageType === 'killFeed' ||
        messageType === 'powerupPickedUp' ||
        messageType === 'powerupSpawned' ||
        messageType === 'meleeAttack'
    );
}

// 智能编码消息（二进制或JSON）
function encodeMessage(message) {
    if (shouldUseBinary(message.type)) {
        // 使用二进制编码
        switch (message.type) {
            case 'gameState':
                return encodeInitialGameState(gameState);
            case 'gameUpdate':
                return encodeGameStateUpdate(gameState);
            case 'incrementalUpdate':
                return encodeIncrementalUpdate(message);
            case 'gameEnd':
                return encodeGameEnd(message);
            case 'newGameStart':
                return encodeNewGameStart(message);
            case 'gameStarted':
                return encodeGameStarted();
            case 'playerJoined':
                return encodePlayerJoined(message.player);
            case 'playerLeft':
                return encodePlayerLeft(message.playerId);
            case 'chatMessage':
                return encodeChatMessage(message);
            case 'playerHit':
                return encodePlayerHit(message);
            case 'bulletHitWall':
                return encodeBulletHitWall(message);
            case 'playerRespawn':
                return encodePlayerRespawnMsg(message);
            case 'killFeed':
                return encodeKillFeedMsg(message);
            case 'powerupPickedUp':
                return encodePowerupPickedUpMsg(message);
            case 'powerupSpawned':
                return encodePowerupSpawnedMsg(message);
            case 'meleeAttack':
                return encodeMeleeAttack(message);
            default:
                // 暂时回退到JSON
                return JSON.stringify(message);
        }
    } else {
        // 使用JSON编码
        return JSON.stringify(message);
    }
}

// 广播消息给所有客户端 - 优化版本支持批处理和压缩
function broadcast(message, excludeId = null, priority = 1) {
    // 对于二进制消息，直接编码和发送
    if (shouldUseBinary(message.type)) {
        const binaryData = encodeMessage(message);
        sendToClients(binaryData, excludeId, priority, message.type);
        return;
    }
    
    // 对于JSON消息，使用现有逻辑
    const optimizedMessage = optimizeMessage(message);
    
    // 根据优先级决定是否立即发送还是批处理
    if (priority >= 3 || message.type === 'playerHit' || message.type === 'meleeAttack') {
        // 高优先级消息立即发送
        const serializedData = compressMessage(optimizedMessage);
        sendToClients(serializedData, excludeId, priority, message.type);
    } else {
        // 低优先级消息加入批处理队列
        addToBatchQueue(optimizedMessage, excludeId, priority);
    }
}

// 获取道具类型ID
function getPowerupTypeId(type) {
    const typeMap = {
        'shield': 1,
        'rapid_fire': 2,
        'damage_boost': 3,
        'heal': 4,
        'weapon_smg': 5,
        'weapon_shotgun': 6,
        'weapon_sniper': 7,
        'weapon_rpg': 8,
        'grenade_pack': 9
    };
    return typeMap[type] || 0;
}

// 简化的消息系统

// 发送消息到客户端 - 优化版本支持自适应发送
function sendToClients(data, excludeId, priority = 1, messageType = null) {
    connections.forEach(client => {
        if (client.isOpen && client.playerId !== excludeId) {
            const clientPing = gameState.clientPing.get(client.playerId) || 50;
            const networkQuality = gameState.clientNetworkQuality.get(client.playerId) || 'good';
            
            // 首次进入必须先收到一次GAME_STATE快照，否则跳过增量/全量更新
            if ((messageType === 'gameUpdate' || messageType === 'incrementalUpdate') && !client.hasInitialSnapshot) {
                return;
            }

            // 根据网络质量自适应发送
            if (networkQuality === 'poor' && priority < 2) {
                // 弱网环境下跳过低优先级消息
                return;
            }
            
            try {
                client.send(data);
                // 如果是GAME_STATE，标记该客户端已经拿到初始快照
                if (messageType === 'gameState') {
                    client.hasInitialSnapshot = true;
                }
            } catch (error) {
                console.error(`发送消息失败给客户端 ${client.playerId}:`, error);
            }
        }
    });
}

// 添加到批处理队列
function addToBatchQueue(message, excludeId, priority) {
    connections.forEach(client => {
        if (client.isOpen && client.playerId !== excludeId) {
            const playerId = client.playerId;
            if (!gameState.messageQueue.has(playerId)) {
                gameState.messageQueue.set(playerId, []);
            }
            
            const queue = gameState.messageQueue.get(playerId);
            queue.push({ message, priority, timestamp: Date.now() });
            
            // 限制队列大小，防止内存泄漏
            if (queue.length > 50) {
                queue.shift(); // 移除最旧的消息
            }
        }
    });
    
    // 启动批处理定时器
    startBatchTimer();
}

// 启动批处理定时器
function startBatchTimer() {
    if (gameState.batchTimer) return;
    
    gameState.batchTimer = setTimeout(() => {
        processBatchQueue();
        gameState.batchTimer = null;
    }, 16); // 16ms批处理间隔 (60fps)
}

// 处理批处理队列
function processBatchQueue() {
    const now = Date.now();
    
    gameState.messageQueue.forEach((queue, playerId) => {
        if (queue.length === 0) return;
        
        const client = Array.from(connections).find(c => c.playerId === playerId);
        if (!client || !client.isOpen) {
            gameState.messageQueue.delete(playerId);
            return;
        }
        
        const networkQuality = gameState.clientNetworkQuality.get(playerId) || 'good';
        const clientPing = gameState.clientPing.get(playerId) || 50;
        
        // 根据网络质量决定批处理大小
        let batchSize;
        if (networkQuality === 'poor') {
            batchSize = Math.min(3, queue.length); // 弱网最多3个消息
        } else if (networkQuality === 'medium') {
            batchSize = Math.min(8, queue.length); // 中等网络最多8个消息
        } else {
            batchSize = Math.min(15, queue.length); // 好网络最多15个消息
        }
        
        // 提取要发送的消息
        const batch = queue.splice(0, batchSize);
        
        if (batch.length === 1) {
            // 单条消息直接发送
            const data = compressMessage(batch[0].message);
            try {
                client.send(data);
            } catch (error) {
                console.error(`发送单条批处理消息失败:`, error);
            }
        } else if (batch.length > 1) {
            // 多条消息批处理发送
            const batchMessage = {
                type: 'batch',
                messages: batch.map(item => item.message),
                timestamp: now
            };
            
            const data = compressMessage(batchMessage);
            try {
                client.send(data);
            } catch (error) {
                console.error(`发送批处理消息失败:`, error);
            }
        }
    });
    
    gameState.lastBatchTime = now;
}

// 消息序列化（局域网直连无需压缩，直接JSON）
function compressMessage(message) {
    return JSON.stringify(message);
}


// 检查玩家状态是否发生变化
function hasPlayerChanged(playerId, currentPlayer) {
    const lastState = gameState.lastPlayerStates.get(playerId);
    if (!lastState) return true;
    
    return (
        Math.abs(currentPlayer.x - lastState.x) > 0.5 ||
        Math.abs(currentPlayer.y - lastState.y) > 0.5 ||
        Math.abs(currentPlayer.angle - lastState.angle) > 0.01 ||
        currentPlayer.health !== lastState.health ||
        currentPlayer.score !== lastState.score ||
        currentPlayer.isAlive !== lastState.isAlive ||
        currentPlayer.weapon !== lastState.weapon ||
        currentPlayer.mag !== lastState.mag ||
        currentPlayer.reserve !== lastState.reserve ||
        currentPlayer.reloading !== lastState.reloading ||
        currentPlayer.grenades !== lastState.grenades ||
        JSON.stringify(currentPlayer.powerups) !== JSON.stringify(lastState.powerups)
    );
}

// 检查子弹状态是否发生变化
function hasBulletChanged(bulletId, currentBullet) {
    const lastState = gameState.lastBulletStates.find(b => b.id === bulletId);
    if (!lastState) return true;
    
    return (
        Math.abs(currentBullet.x - lastState.x) > 0.5 ||
        Math.abs(currentBullet.y - lastState.y) > 0.5 ||
        Math.abs(currentBullet.vx - lastState.vx) > 0.01 ||
        Math.abs(currentBullet.vy - lastState.vy) > 0.01
    );
}

// 检查道具状态是否发生变化
function hasPowerupChanged(powerupId, currentPowerup) {
    const lastState = gameState.lastPowerupStates.find(p => p.id === powerupId);
    if (!lastState) return true;
    
    return (
        currentPowerup.x !== lastState.x ||
        currentPowerup.y !== lastState.y ||
        currentPowerup.type !== lastState.type
    );
}

// 高级增量更新系统 - 大幅优化网络性能
function generateIncrementalUpdate() {
    const currentTime = Date.now();
    const players = getPlayersWithBuffs();
    
    // 智能更新频率控制 - 保证同步优先
    const averagePing = Array.from(gameState.clientPing.values()).reduce((a, b) => a + b, 0) / gameState.clientPing.size || 50;
    const playerCount = gameState.players.size;
    const poorNetworkCount = Array.from(gameState.clientNetworkQuality.values()).filter(q => q === 'poor').length;
    
    // 强制同步检查 - 每5秒强制发送完整状态确保同步
    const shouldForceBroadcast = (currentTime - (gameState.lastForceBroadcast || 0)) > 5000;
    
    // 根据网络质量和玩家数量动态调整更新频率 - 提高同步频率
    let updateInterval;
    if (poorNetworkCount > playerCount * 0.5) {
        updateInterval = 10; // 大部分玩家网络质量差：10次更新一次完整状态
    } else if (averagePing > 200) {
        updateInterval = 8; // 高延迟：8次更新一次完整状态
    } else if (averagePing > 150) {
        updateInterval = 6; // 中高延迟：6次更新一次完整状态
    } else if (averagePing > 100) {
        updateInterval = 5; // 中等延迟：5次更新一次完整状态
    } else if (playerCount > 8) {
        updateInterval = 4; // 多玩家：4次更新一次完整状态
    } else {
        updateInterval = 3; // 低延迟少玩家：3次更新一次完整状态
    }
    
    // 检查玩家变化 - 激进优化，最小化数据传输
    const changedPlayers = [];
    const newPlayers = [];
    
    players.forEach(player => {
        if (hasPlayerChanged(player.id, player)) {
            if (gameState.lastPlayerStates.has(player.id)) {
                // 只发送关键变化 - 更严格的阈值
                const lastState = gameState.lastPlayerStates.get(player.id);
                const changes = { id: player.id }; // 始终包含id
                
                // 位置变化 - 1像素精度，降低量化抖动
                if (Math.abs(player.x - lastState.x) > 0.5) {
                    changes.x = Math.round(player.x);
                }
                if (Math.abs(player.y - lastState.y) > 0.5) {
                    changes.y = Math.round(player.y);
                }
                
                // 角度变化
                if (Math.abs(player.angle - lastState.angle) > 0.02) {
                    changes.angle = Math.round(player.angle * 100) / 100;
                }
                
                // 非位置属性
                if (player.health !== lastState.health) changes.health = player.health;
                if (player.score !== lastState.score) changes.score = player.score;
                if (player.isAlive !== lastState.isAlive) changes.isAlive = player.isAlive;
                
                // 检查powerups变化
                const powerupsChanged = JSON.stringify(player.powerups) !== JSON.stringify(lastState.powerups);
                if (powerupsChanged) changes.powerups = player.powerups;

                // 检查武器/弹药变化
                if (player.weapon !== lastState.weapon || player.mag !== lastState.mag ||
                    player.reserve !== lastState.reserve || player.reloading !== lastState.reloading ||
                    player.grenades !== lastState.grenades) {
                    changes.weaponState = weaponNetState(player);
                }

                // 只在有实际变化时添加（除了id之外）
                if (Object.keys(changes).length > 1) {
                    changedPlayers.push(changes);
                }
            } else {
                // 新玩家 - 优化精度
                const ws = weaponNetState(player);
                newPlayers.push({
                    id: player.id,
                    nickname: player.nickname,
                    x: Math.round(player.x),
                    y: Math.round(player.y),
                    angle: Math.round(player.angle * 100) / 100,
                    health: player.health,
                    score: player.score,
                    isAlive: player.isAlive,
                    color: player.color,
                    team: player.team || 0,
                    powerups: player.powerups,
                    weapon: ws.w,
                    mag: ws.mag,
                    reserve: ws.res,
                    reloadRem: ws.rel,
                    grenades: ws.g
                });
            }

            // 更新最后状态
            gameState.lastPlayerStates.set(player.id, {
                x: player.x,
                y: player.y,
                angle: player.angle,
                health: player.health,
                score: player.score,
                isAlive: player.isAlive,
                weapon: player.weapon,
                mag: player.mag,
                reserve: player.reserve,
                reloading: player.reloading,
                grenades: player.grenades,
                powerups: JSON.parse(JSON.stringify(player.powerups))
            });
        }
    });
    
    // 子弹更新 - 激进优化，只发送必要的子弹数据
    const newBullets = [];
    const removedBullets = [];
    
    // 检测新子弹 - 添加详细调试日志
    console.log(`当前子弹数量: ${gameState.bullets.length}, 上次记录的子弹数量: ${gameState.lastBulletStates.length}`);
    gameState.bullets.forEach(bullet => {
        if (!gameState.lastBulletStates.find(b => b.id === bullet.id)) {
            console.log(`发现新子弹: ID=${bullet.id}, 位置=(${bullet.x.toFixed(2)}, ${bullet.y.toFixed(2)})`);
            const newBullet = {
                id: bullet.id,
                x: Math.round(bullet.x * 2) / 2, // 0.5像素精度，提高平滑度
                y: Math.round(bullet.y * 2) / 2,
                vx: bullet.vx, // 保持完整速度精度
                vy: bullet.vy,
                ownerId: bullet.ownerId,
                kind: bullet.kind | 0
            };
            newBullets.push(newBullet);
            console.log(`新子弹已加入newBullets数组，当前数组长度: ${newBullets.length}`);
        }
    });
    
    // 检测移除的子弹
    gameState.lastBulletStates.forEach(lastBullet => {
        if (!gameState.bullets.find(b => b.id === lastBullet.id)) {
            removedBullets.push(lastBullet.id);
        }
    });
    
    // 更新子弹最后状态 - 只保存必要信息
    gameState.lastBulletStates = gameState.bullets.map(bullet => ({
        id: bullet.id,
        x: bullet.x,
        y: bullet.y
    }));
    
    // 道具更新 - 只发送新道具和移除的道具
    const newPowerups = [];
    const removedPowerups = [];
    
    // 检测新道具
    gameState.powerups.forEach(powerup => {
        if (!gameState.lastPowerupStates.find(p => p.id === powerup.id)) {
            newPowerups.push({
                id: powerup.id,
                x: Math.round(powerup.x),
                y: Math.round(powerup.y),
                type: powerup.type // 只发送类型，客户端自行计算颜色和图标
            });
        }
    });
    
    // 检测移除的道具
    gameState.lastPowerupStates.forEach(lastPowerup => {
        if (!gameState.powerups.find(p => p.id === lastPowerup.id)) {
            removedPowerups.push(lastPowerup.id);
        }
    });
    
    // 更新道具最后状态
    gameState.lastPowerupStates = gameState.powerups.map(powerup => ({
        id: powerup.id,
        x: powerup.x,
        y: powerup.y,
        type: powerup.type
    }));
    
    // 决定是否发送完整更新 - 添加强制同步检查
    const shouldSendFullUpdate = gameState.updateCounter % updateInterval === 0 || shouldForceBroadcast;
    
    // 更新强制广播时间戳
    if (shouldForceBroadcast) {
        gameState.lastForceBroadcast = currentTime;
    }
    
    if (shouldSendFullUpdate) {
        const update = {
            type: 'gameUpdate',
            fullUpdate: true,
            players: players.map(player => ({
                id: player.id,
                nickname: player.nickname,
                x: Math.round(player.x), // 1像素精度
                y: Math.round(player.y),
                angle: Math.round(player.angle * 100) / 100,
                health: player.health,
                score: player.score,
                isAlive: player.isAlive,
                color: player.color,
                powerups: player.powerups
            })),
            bullets: gameState.bullets.map(bullet => ({
                id: bullet.id,
                x: Math.round(bullet.x / 2) * 2,
                y: Math.round(bullet.y / 2) * 2,
                vx: Math.round(bullet.vx * 10) / 10,
                vy: Math.round(bullet.vy * 10) / 10,
                ownerId: bullet.ownerId,
                kind: bullet.kind | 0
            })),
            powerups: gameState.powerups.map(powerup => ({
                id: powerup.id,
                type: powerup.type,
                x: Math.round(powerup.x / 2) * 2,
                y: Math.round(powerup.y / 2) * 2,
                color: powerup.getColor(),
                icon: powerup.getIcon()
            })),
            remainingTime: Math.max(0, gameState.gameDuration - (currentTime - gameState.gameStartTime)),
            isGameEnded: gameState.isGameEnded
        };
        
        // 地形数据发送频率提高保证同步
        if (gameState.updateCounter % 60 === 0 || gameState.updateCounter === 1) {
            update.terrain = gameState.terrain;
        }
        
        return update;
    } else {
        // 增量更新 - 激进优化，只在有实际变化时发送
        const update = {
            type: 'incrementalUpdate', // 使用不同的类型名以区分增量和完整更新
            timestamp: currentTime,
            remainingTime: Math.max(0, gameState.gameDuration - (currentTime - gameState.gameStartTime)), // 始终包含剩余时间
            isGameEnded: gameState.isGameEnded
        };
        
        // 只添加有数据的字段
        if (newPlayers.length > 0) update.newPlayers = newPlayers;
        if (changedPlayers.length > 0) update.changedPlayers = changedPlayers;
        if (newBullets.length > 0) update.newBullets = newBullets;
        if (removedBullets.length > 0) update.removedBullets = removedBullets;
        if (newPowerups.length > 0) update.newPowerups = newPowerups;
        if (removedPowerups.length > 0) update.removedPowerups = removedPowerups;
        
        // 始终发送增量更新（因为包含剩余时间需要持续更新）
        
        // 调试日志：检查子弹更新
        if (newBullets.length > 0 || removedBullets.length > 0) {
            console.log(`增量更新包含子弹: 新增${newBullets.length}个, 移除${removedBullets.length}个`);
        }
        
        return update;
    }
}

// 优化消息数据包
function optimizeMessage(message) {
    if (message.type === 'gameUpdate') {
        // 对于增量更新，直接返回
        if (!message.fullUpdate) {
            return message;
        }
        
        // 优化完整游戏更新数据包
        const optimized = {
            type: message.type,
            fullUpdate: message.fullUpdate,
            players: message.players.map(player => ({
                id: player.id,
                x: Math.round(player.x),
                y: Math.round(player.y),
                angle: Math.round(player.angle * 100) / 100,
                health: player.health,
                score: player.score,
                isAlive: player.isAlive,
                powerups: player.powerups
            })),
            bullets: message.bullets.map(bullet => ({
                id: bullet.id,
                x: Math.round(bullet.x),
                y: Math.round(bullet.y),
                vx: Math.round(bullet.vx * 100) / 100,
                vy: Math.round(bullet.vy * 100) / 100,
                ownerId: bullet.ownerId
            })),
            powerups: message.powerups,
            terrain: message.terrain,
            remainingTime: message.remainingTime,
            isGameEnded: message.isGameEnded,
            countdown: message.countdown,
            killFeed: message.killFeed
        };
        return optimized;
    }
    return message;
}

// 获取玩家列表
function getPlayersList() {
    return Array.from(gameState.players.values()).map(player => ({
        id: player.id,
        nickname: player.nickname,
        score: player.score,
        isAlive: player.isAlive,
        health: player.health,
        team: player.team || 0
    })).sort((a, b) => b.score - a.score);
}

// 获取包含buff信息的玩家列表
function getPlayersWithBuffs() {
    return Array.from(gameState.players.values()).map(player => ({
        id: player.id,
        nickname: player.nickname,
        x: player.x,
        y: player.y,
        angle: player.angle,
        score: player.score,
        isAlive: player.isAlive,
        health: player.health,
        color: player.color,
        team: player.team || 0,
        powerups: player.powerups,
        vx: player.vx || 0,
        vy: player.vy || 0,
        isMoving: player.isMoving || false
    }));
}

// 接入一个玩家连接（本地回环或 WebRTC DataChannel）
// sendFn(data): 主机把要发给该玩家的数据（string 或 ArrayBuffer）交给传输层
// 返回的连接对象提供 deliver(data) 接收该玩家发来的数据，close() 处理断开
function addConnection(sendFn) {
    console.log('新客户端连接');
    const ws = {
        isOpen: true,
        playerId: null,
        hasInitialSnapshot: false, // 首次进入尚未收到GAME_STATE
        lastPingTime: Date.now(),
        messageCount: 0,
        lastMessageTimes: {},
        send(data) {
            if (!ws.isOpen) return;
            sendFn(data);
        },
        deliver(data) {
            if (ws.isOpen) handleClientData(ws, data);
        },
        close() {
            handleClientClose(ws);
        }
    };
    connections.add(ws);

    // 发送连接确认
    ws.send(JSON.stringify({
        type: 'connected',
        serverTime: Date.now(),
        maxMessageSize: 1024 * 10
    }));
    return ws;
}

// 处理玩家发来的原始数据（string 为JSON，ArrayBuffer 为二进制协议）
function handleClientData(ws, data) {
    try {
        // 统计计数（用于监控）
        ws.messageCount++;

        let message;
        if (typeof data === 'string') {
            message = JSON.parse(data);
        } else {
            // ArrayBuffer 或 TypedArray
            const arrayBuffer = data instanceof ArrayBuffer
                ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            // 限制消息大小
            if (arrayBuffer.byteLength > 1024 * 10) { // 最大10KB
                console.log('消息过大，忽略');
                return;
            }
            message = decodeMessage(arrayBuffer);
            if (!message) {
                throw new Error('二进制解码失败');
            }
        }

        // 按类型限速（在解码之后执行）：
        // - move: 16ms（~60FPS）
        // - chatMessage: 200ms
        // - ping: 500ms
        // - shoot / melee / respawn / 其他: 不限速（由游戏内部CD控制）
        {
            const now = Date.now();
            const type = message && message.type;
            let minInterval = 0;
            if (type === 'move') minInterval = 16;
            else if (type === 'chatMessage') minInterval = 200;
            else if (type === 'ping') minInterval = 500;
            const lastTs = ws.lastMessageTimes[type] || 0;
            if (minInterval > 0 && now - lastTs < minInterval) {
                return; // 丢弃被限速的非关键消息
            }
            ws.lastMessageTimes[type] = now;
        }

        handleMessage(ws, message);
    } catch (error) {
        console.error('解析消息错误:', error);
        // 发送错误响应（使用JSON格式以确保兼容性）
        ws.send(JSON.stringify({
            type: 'error',
            message: '消息格式错误'
        }));
    }
}

// 处理玩家断开
function handleClientClose(ws) {
    if (!ws.isOpen) return;
    ws.isOpen = false;
    connections.delete(ws);
    console.log('客户端断开连接');

    if (ws.playerId) {
        console.log(`玩家 ${ws.playerId} 断开连接`);
        gameState.players.delete(ws.playerId);
        gameState.clientPing.delete(ws.playerId);
        gameState.clientUpdateRates.delete(ws.playerId);
        gameState.messageQueue.delete(ws.playerId);

        broadcast({
            type: 'playerLeft',
            playerId: ws.playerId
        });
    }
}

// 处理客户端消息
function handleMessage(ws, message) {
    switch (message.type) {
        case 'join':
            handleJoin(ws, message);
            break;
        case 'move':
            handleMove(ws, message);
            break;
        case 'shoot':
            handleShoot(ws, message);
            break;
        case 'reload': {
            const rp = gameState.players.get(ws.playerId);
            if (rp) rp.startReload();
            break;
        }
        case 'grenade': {
            const gp = gameState.players.get(ws.playerId);
            if (gp) {
                const g = gp.throwGrenade(message.targetX, message.targetY);
                if (g) gameState.bullets.push(g);
            }
            break;
        }
        case 'melee':
            handleMelee(ws, message);
            break;
        case 'respawn':
            handleRespawn(ws, message);
            break;
            
        case 'chatMessage':
            // 处理聊天消息
            const chatPlayer = gameState.players.get(ws.playerId);
            if (chatPlayer && message.content && message.content.trim()) {
                // 机器人指令：/bot N 设定数量，/bot 加一个
                const cmdText = message.content.trim();
                if (cmdText.startsWith('/bot')) {
                    const arg = cmdText.slice(4).trim();
                    const n = arg === '' ? bots.size + 1 : parseInt(arg, 10);
                    const count = setBotCount(isNaN(n) ? bots.size : n);
                    broadcast({
                        type: 'chatMessage',
                        playerId: 0,
                        playerName: '系统',
                        content: `机器人数量: ${count}/${BOT_LIMIT}（输入 /bot 数字 调整）`,
                        timestamp: Date.now()
                    });
                    break;
                }
                // 地图指令：/map 查看列表，/map 地图ID 下一局切换
                if (cmdText.startsWith('/map')) {
                    const arg = cmdText.slice(4).trim();
                    let content;
                    if (arg && MAPS[arg]) {
                        matchConfig.pendingMapId = arg;
                        content = `下一局将切换到地图「${MAPS[arg].name}」`;
                    } else {
                        const list = Object.keys(MAPS).map(k => `${k}=${MAPS[k].name}`).join('，');
                        content = `当前地图: ${(MAPS[matchConfig.mapId] || MAPS[DEFAULT_MAP_ID]).name}。可用地图: ${list}。输入 /map 地图ID 下一局切换`;
                    }
                    broadcast({ type: 'chatMessage', playerId: 0, playerName: '系统', content, timestamp: Date.now() });
                    break;
                }
                // 武器指令：/weapon 武器ID 立即换枪（娱乐/调试）
                if (cmdText.startsWith('/weapon')) {
                    const arg = cmdText.slice(7).trim().toLowerCase();
                    let content;
                    if (WEAPONS[arg]) {
                        chatPlayer.equipWeapon(arg);
                        content = `${chatPlayer.nickname} 换上了「${WEAPONS[arg].name}」`;
                    } else {
                        const list = WEAPON_IDS.map(k => `${k}=${WEAPONS[k].name}`).join('，');
                        content = `可用武器: ${list}。输入 /weapon 武器ID 切换`;
                    }
                    broadcast({ type: 'chatMessage', playerId: 0, playerName: '系统', content, timestamp: Date.now() });
                    break;
                }
                // 分队指令：/team on 开启红蓝对抗，/team off 恢复个人混战
                if (cmdText.startsWith('/team')) {
                    const arg = cmdText.slice(5).trim().toLowerCase();
                    let content;
                    if (arg === 'on' || arg === '开') {
                        matchConfig.pendingTeamMode = true;
                        content = '下一局开启红蓝对抗模式';
                    } else if (arg === 'off' || arg === '关') {
                        matchConfig.pendingTeamMode = false;
                        content = '下一局恢复个人混战模式';
                    } else {
                        content = `当前模式: ${matchConfig.teamMode ? '红蓝对抗' : '个人混战'}。输入 /team on 或 /team off 下一局切换`;
                    }
                    broadcast({ type: 'chatMessage', playerId: 0, playerName: '系统', content, timestamp: Date.now() });
                    break;
                }
                const chatMessage = {
                    type: 'chatMessage',
                    playerId: chatPlayer.id,
                    playerName: chatPlayer.nickname,
                    content: message.content.trim().substring(0, 100), // 限制长度
                    timestamp: Date.now()
                };
                
                console.log(`聊天消息: ${chatPlayer.nickname}: ${chatMessage.content}`);
                
                // 广播给所有玩家
                broadcast(chatMessage);
            }
            break;
            
        case 'ping':
            // 处理ping检测和网络质量分析 - 增强版
            const serverTime = Date.now();
            const clientPing = serverTime - message.timestamp;
            
            // 更新客户端ping记录和网络质量评估
            if (ws.playerId) {
                gameState.clientPing.set(ws.playerId, clientPing);
                
                // 评估网络质量
                let networkQuality;
                if (clientPing < 50) {
                    networkQuality = 'excellent';
                } else if (clientPing < 100) {
                    networkQuality = 'good';
                } else if (clientPing < 200) {
                    networkQuality = 'medium';
                } else {
                    networkQuality = 'poor';
                }
                
                gameState.clientNetworkQuality.set(ws.playerId, networkQuality);
                
                // 计算客户端更新率
                const lastPingTime = ws.lastPingTime || serverTime;
                const pingInterval = serverTime - lastPingTime;
                ws.lastPingTime = serverTime;
                
                if (pingInterval > 0) {
                    const updateRate = 1000 / pingInterval;
                    gameState.clientUpdateRates.set(ws.playerId, updateRate);
                }
            }
            
            const pongMessage = {
                type: 'pong',
                timestamp: message.timestamp,
                serverTime: serverTime,
                clientPing: clientPing,
                networkQuality: gameState.clientNetworkQuality.get(ws.playerId) || 'good'
            };
            ws.send(JSON.stringify(pongMessage));
            break;
    }
}

// 处理玩家加入
function handleJoin(ws, message) {
    console.log('处理玩家加入请求:', message);
    const { nickname } = message;
    const playerId = gameState.nextPlayerId++;

    // 分队模式自动均衡分队，并在本队出生区找生成位置
    const team = matchConfig.teamMode ? pickBalancedTeam() : 0;
    const spawn = findSpawnPosition(team, playerId);

    // 创建玩家
    const player = new Player(
        playerId,
        nickname,
        spawn.x,
        spawn.y
    );
    player.team = team;
    applyTeamColor(player);

    gameState.players.set(playerId, player);
    ws.playerId = playerId;
    
    // 发送玩家ID和配置（二进制）
    try {
        ws.send(encodeJoined(playerId));
    } catch (e) {
        console.error('发送JOINED失败:', e);
    }
    
    // 广播新玩家加入
    const joinWs = weaponNetState(player);
    broadcast({
        type: 'playerJoined',
        player: {
            id: player.id,
            nickname: player.nickname,
            x: player.x,
            y: player.y,
            angle: player.angle,
            health: player.health,
            score: player.score,
            isAlive: player.isAlive,
            color: player.color,
            powerups: player.powerups,
            weapon: joinWs.w,
            mag: joinWs.mag,
            reserve: joinWs.res,
            reloadRem: joinWs.rel,
            grenades: joinWs.g
        }
    }, playerId);
    
    // 发送当前游戏完整状态（二进制）
    try {
        ws.send(encodeInitialGameState(gameState));
        // 标记该玩家已收到初始快照，允许后续增量/全量更新
        ws.hasInitialSnapshot = true;
    } catch (e) {
        console.error('发送初始游戏状态失败:', e);
    }
    
    console.log(`玩家 ${nickname} (ID: ${playerId}) 加入游戏`);
}

// 处理玩家移动
function handleMove(ws, message) {
    const player = gameState.players.get(ws.playerId);
    if (!player || !player.isAlive) return;
    
    const { x, y, angle } = message;
    
    // 计算移动距离
    const dx = x - player.x;
    const dy = y - player.y;
    
    // 使用新的move方法，包含碰撞检测
    player.move(dx, dy);
    player.angle = angle;
}

// 处理射击
function handleShoot(ws, message) {
    console.log('收到射击请求:', message);
    const player = gameState.players.get(ws.playerId);
    if (!player || !player.isAlive) {
        console.log('射击失败: 玩家不存在或已死亡', ws.playerId);
        return;
    }
    
    const { targetX, targetY } = message;
    
    // 服务器端防重复射击检查（轻量去重，避免网络抖动导致的重复帧）
    const now = Date.now();
    if (!gameState.lastShootRequests) {
        gameState.lastShootRequests = new Map();
    }
    const lastShootTime = gameState.lastShootRequests.get(ws.playerId) || 0;
    // 50ms 窗口内的重复消息直接丢弃（远小于服务器射击冷却200ms）
    if (now - lastShootTime < 50) {
        console.log('短时间重复射击消息，已去重');
        return;
    }
    gameState.lastShootRequests.set(ws.playerId, now);
    
    console.log(`玩家 ${player.nickname} 射击到 (${targetX}, ${targetY})`);
    
    const bullets = player.shoot(targetX, targetY);

    if (bullets && bullets.length) {
        bullets.forEach(b => gameState.bullets.push(b));
        // 子弹将通过游戏状态更新自动发送给客户端，无需重复广播
    }
}

// 处理近战攻击
function handleMelee(ws, message) {
    console.log('收到近战攻击请求:', message);
    const player = gameState.players.get(ws.playerId);
    if (!player || !player.isAlive) {
        console.log('近战攻击失败: 玩家不存在或已死亡', ws.playerId);
        return;
    }
    
    const { targetX, targetY } = message;
    console.log(`玩家 ${player.nickname} 近战攻击到 (${targetX}, ${targetY})`);
    
    const success = player.meleeAttack(targetX, targetY);
    if (!success) {
        console.log('近战攻击失败: 可能还在冷却中或超出范围');
    }
}

// 处理复活
function handleRespawn(ws, message) {
    const player = gameState.players.get(ws.playerId);
    if (!player || player.isAlive) return;
    
    player.respawn();
    
    // 广播复活信息
    broadcast({
        type: 'playerRespawn',
        playerId: player.id,
        x: player.x,
        y: player.y,
        health: player.health
    });
}

// 碰撞检测函数
function checkTerrainCollision(x, y, width, height) {
    for (const block of gameState.terrain) {
        if (x < block.x + block.width &&
            x + width > block.x &&
            y < block.y + block.height &&
            y + height > block.y) {
            return true;
        }
    }
    return false;
}

// ===================== 地图构建 =====================
// 网格坐标转地形块（gx, gy 为 40px 格坐标，画布共 30x20 格）
function gridBlock(gx, gy, type) {
    const size = GAME_CONFIG.TERRAIN_SIZE;
    return { x: gx * size, y: gy * size, width: size, height: size, type };
}

// 横排 / 竖排结构，skip 为要留出的缺口格坐标
function gridRow(blocks, gy, gx1, gx2, type, skip = []) {
    for (let gx = gx1; gx <= gx2; gx++) {
        if (!skip.includes(gx)) blocks.push(gridBlock(gx, gy, type));
    }
}
function gridCol(blocks, gx, gy1, gy2, type, skip = []) {
    for (let gy = gy1; gy <= gy2; gy++) {
        if (!skip.includes(gy)) blocks.push(gridBlock(gx, gy, type));
    }
}

// 经典竞技场：随机散块 + 固定L/T结构（原版地图）
function buildClassicBlocks() {
    const blocks = [];
    const size = GAME_CONFIG.TERRAIN_SIZE;
    const terrainTypes = ['wall', 'rock', 'crate', 'barrel'];

    for (let i = 0; i < 20; i++) {
        const x = Math.random() * (GAME_CONFIG.CANVAS_WIDTH - size);
        const y = Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - size);
        // 确保地形不会生成在边缘
        if (x > 50 && x < GAME_CONFIG.CANVAS_WIDTH - 50 &&
            y > 50 && y < GAME_CONFIG.CANVAS_HEIGHT - 50) {
            const type = terrainTypes[Math.floor(Math.random() * terrainTypes.length)];
            blocks.push({
                x: Math.floor(x / size) * size,
                y: Math.floor(y / size) * size,
                width: size,
                height: size,
                type: type
            });
        }
    }

    // L形和T形结构
    const complexStructures = [
        { x: 200, y: 200, pattern: 'L1' },
        { x: 800, y: 300, pattern: 'L2' },
        { x: 400, y: 500, pattern: 'T1' },
        { x: 900, y: 600, pattern: 'T2' }
    ];
    complexStructures.forEach(structure => {
        switch (structure.pattern) {
            case 'L1': // L形 (左下)
                blocks.push({ x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x, y: structure.y + size, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x + size, y: structure.y + size, width: size, height: size, type: 'wall' });
                break;
            case 'L2': // L形 (右上)
                blocks.push({ x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x + size, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x + size, y: structure.y + size, width: size, height: size, type: 'wall' });
                break;
            case 'T1': // T形
                blocks.push({ x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x - size, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x + size, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x, y: structure.y + size, width: size, height: size, type: 'wall' });
                break;
            case 'T2': // 倒T形
                blocks.push({ x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x, y: structure.y - size, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x - size, y: structure.y, width: size, height: size, type: 'wall' });
                blocks.push({ x: structure.x + size, y: structure.y, width: size, height: size, type: 'wall' });
                break;
        }
    });
    return blocks;
}

// 双子要塞：中线双层城墙留上下两个突破口，两侧对称要塞掩体（为红蓝对抗设计）
function buildFortressBlocks() {
    const b = [];
    // 中线城墙（两列厚），上下两个突破口
    gridCol(b, 14, 1, 18, 'wall', [4, 5, 14, 15]);
    gridCol(b, 15, 1, 18, 'wall', [4, 5, 14, 15]);
    // 两侧基地掩体（左右镜像）
    gridCol(b, 6, 6, 8, 'crate');
    gridCol(b, 23, 6, 8, 'crate');
    gridCol(b, 6, 11, 13, 'crate');
    gridCol(b, 23, 11, 13, 'crate');
    // 突破口前的岩石掩体
    gridRow(b, 3, 10, 11, 'rock');
    gridRow(b, 3, 18, 19, 'rock');
    gridRow(b, 16, 10, 11, 'rock');
    gridRow(b, 16, 18, 19, 'rock');
    // 散布油桶
    [[4, 3], [25, 3], [4, 16], [25, 16], [10, 9], [19, 10]].forEach(([gx, gy]) => {
        b.push(gridBlock(gx, gy, 'barrel'));
    });
    return b;
}

// 迷宫回廊：多重走廊与房间，中央长廊留缺口
function buildMazeBlocks() {
    const b = [];
    // 上下两条横向长墙（各留两个门）
    gridRow(b, 4, 3, 12, 'wall', [7, 8]);
    gridRow(b, 4, 17, 26, 'wall', [21, 22]);
    gridRow(b, 15, 3, 12, 'wall', [7, 8]);
    gridRow(b, 15, 17, 26, 'wall', [21, 22]);
    // 中央双层岩石长廊（中间留大缺口）
    gridRow(b, 9, 10, 19, 'rock', [14, 15]);
    gridRow(b, 10, 10, 19, 'rock', [14, 15]);
    // 纵向隔断
    gridCol(b, 7, 7, 12, 'wall', [9, 10]);
    gridCol(b, 22, 7, 12, 'wall', [9, 10]);
    // 木箱与油桶点缀
    [[4, 9], [4, 10], [25, 9], [25, 10], [14, 2], [15, 2], [14, 17], [15, 17]].forEach(([gx, gy]) => {
        b.push(gridBlock(gx, gy, 'crate'));
    });
    [[10, 6], [19, 6], [10, 13], [19, 13]].forEach(([gx, gy]) => {
        b.push(gridBlock(gx, gy, 'barrel'));
    });
    return b;
}

// 十字堡垒：中央十字要塞 + 四角L形碉堡，全对称
function buildCrossfireBlocks() {
    const b = [];
    // 中央十字（岩石）
    gridCol(b, 14, 6, 13, 'rock');
    gridCol(b, 15, 6, 13, 'rock');
    gridRow(b, 9, 11, 18, 'rock', [14, 15]);
    gridRow(b, 10, 11, 18, 'rock', [14, 15]);
    // 四角L形碉堡（木箱）
    gridRow(b, 4, 4, 6, 'crate');
    gridCol(b, 4, 5, 6, 'crate');
    gridRow(b, 4, 23, 25, 'crate');
    gridCol(b, 25, 5, 6, 'crate');
    gridRow(b, 15, 4, 6, 'crate');
    gridCol(b, 4, 13, 14, 'crate');
    gridRow(b, 15, 23, 25, 'crate');
    gridCol(b, 25, 13, 14, 'crate');
    // 上下通道隔墙
    gridCol(b, 9, 2, 3, 'wall');
    gridCol(b, 20, 2, 3, 'wall');
    gridCol(b, 9, 16, 17, 'wall');
    gridCol(b, 20, 16, 17, 'wall');
    // 油桶
    [[12, 4], [17, 4], [12, 15], [17, 15]].forEach(([gx, gy]) => {
        b.push(gridBlock(gx, gy, 'barrel'));
    });
    return b;
}

// 生成地形（按地图ID）
function generateTerrain(mapId) {
    const map = MAPS[mapId] || MAPS[DEFAULT_MAP_ID];
    const size = GAME_CONFIG.TERRAIN_SIZE;
    const terrain = map.buildBlocks();

    // 四周边界墙（所有地图共用）
    for (let x = 0; x < GAME_CONFIG.CANVAS_WIDTH; x += size) {
        terrain.push({ x: x, y: 0, width: size, height: size, type: 'wall' });
        terrain.push({ x: x, y: GAME_CONFIG.CANVAS_HEIGHT - size, width: size, height: size, type: 'wall' });
    }
    for (let y = size; y < GAME_CONFIG.CANVAS_HEIGHT - size; y += size) {
        terrain.push({ x: 0, y: y, width: size, height: size, type: 'wall' });
        terrain.push({ x: GAME_CONFIG.CANVAS_WIDTH - size, y: y, width: size, height: size, type: 'wall' });
    }

    // 统一分配ID，避免随机块与边界墙撞号
    terrain.forEach((t, i) => { t.id = i; });
    return terrain;
}

// 生成道具
function spawnPowerup() {
    // 限制同时存在的道具箱数量不超过5个
    if (gameState.powerups.length >= 5) {
        return;
    }

    // 50% 武器箱 / 50% 增益箱（含手雷补给）
    let type;
    if (Math.random() < 0.5) {
        const weapons = [POWERUP_TYPES.WEAPON_SMG, POWERUP_TYPES.WEAPON_SHOTGUN, POWERUP_TYPES.WEAPON_SNIPER, POWERUP_TYPES.WEAPON_RPG];
        type = weapons[Math.floor(Math.random() * weapons.length)];
    } else {
        const buffs = [POWERUP_TYPES.SHIELD, POWERUP_TYPES.RAPID_FIRE, POWERUP_TYPES.DAMAGE_BOOST, POWERUP_TYPES.HEAL, POWERUP_TYPES.GRENADE_PACK];
        type = buffs[Math.floor(Math.random() * buffs.length)];
    }
    
    // 尝试多次生成道具，确保不在地形内
    let attempts = 0;
    let x, y;
    let validPosition = false;
    
    while (attempts < 50 && !validPosition) {
        x = Math.random() * (GAME_CONFIG.CANVAS_WIDTH - GAME_CONFIG.POWERUP_SIZE);
        y = Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.POWERUP_SIZE);
        
        // 检查是否与地形碰撞（四周留 20px 空隙，避免贴墙难拾取）
        if (!checkTerrainCollision(x - 20, y - 20, GAME_CONFIG.POWERUP_SIZE + 40, GAME_CONFIG.POWERUP_SIZE + 40)) {
            // 检查是否与玩家碰撞
            let playerCollision = false;
            gameState.players.forEach(player => {
                if (player.isAlive) {
                    const playerRect = {
                        x: player.x,
                        y: player.y,
                        width: GAME_CONFIG.PLAYER_SIZE,
                        height: GAME_CONFIG.PLAYER_SIZE
                    };
                    const powerupRect = {
                        x: x,
                        y: y,
                        width: GAME_CONFIG.POWERUP_SIZE,
                        height: GAME_CONFIG.POWERUP_SIZE
                    };
                    if (checkCollision(powerupRect, playerRect)) {
                        playerCollision = true;
                    }
                }
            });
            
            if (!playerCollision) {
                validPosition = true;
            }
        }
        
        attempts++;
    }
    
    // 如果找不到合适位置，就不生成道具
    if (!validPosition) {
        console.log('无法找到合适的道具生成位置');
        return;
    }
    
    const powerup = new Powerup(gameState.nextPowerupId++, type, x, y);
    gameState.powerups.push(powerup);
    
    // 广播新道具生成
    broadcast({
        type: 'powerupSpawned',
        powerup: {
            id: powerup.id,
            type: powerup.type,
            x: powerup.x,
            y: powerup.y,
            color: powerup.getColor(),
            icon: powerup.getIcon()
        }
    });
}

// 检查道具拾取
function checkPowerupPickup() {
    gameState.powerups = gameState.powerups.filter(powerup => {
        let pickedUp = false;
        
        gameState.players.forEach(player => {
            if (player.isAlive && !pickedUp) {
                const powerupRect = {
                    x: powerup.x,
                    y: powerup.y,
                    width: GAME_CONFIG.POWERUP_SIZE,
                    height: GAME_CONFIG.POWERUP_SIZE
                };
                
                const playerRect = {
                    x: player.x,
                    y: player.y,
                    width: GAME_CONFIG.PLAYER_SIZE,
                    height: GAME_CONFIG.PLAYER_SIZE
                };
                
                if (checkCollision(powerupRect, playerRect)) {
                    // 应用道具效果
                    const now = Date.now();
                    const duration = GAME_CONFIG.POWERUP_DURATION;
                    
                    const weaponId = powerupWeapon(powerup.type);
                    if (weaponId) {
                        player.equipWeapon(weaponId);
                    } else {
                        switch (powerup.type) {
                            case POWERUP_TYPES.SHIELD:
                                player.powerups.shield = { active: true, endTime: now + duration };
                                break;
                            case POWERUP_TYPES.RAPID_FIRE:
                                player.powerups.rapidFire = { active: true, endTime: now + duration };
                                break;
                            case POWERUP_TYPES.DAMAGE_BOOST:
                                player.powerups.damageBoost = { active: true, endTime: now + duration };
                                break;
                            case POWERUP_TYPES.HEAL:
                                player.health = Math.min(GAME_CONFIG.MAX_HEALTH, player.health + GAME_CONFIG.MAX_HEALTH);
                                break;
                            case POWERUP_TYPES.GRENADE_PACK:
                                player.grenades = Math.min(GRENADE.carryMax, (player.grenades | 0) + 2);
                                break;
                        }
                    }
                    
                    // 广播道具拾取
                    broadcast({
                        type: 'powerupPickedUp',
                        powerupId: powerup.id,
                        playerId: player.id,
                        powerupType: powerup.type
                    });
                    
                    pickedUp = true;
                }
            }
        });
        
        return !pickedUp;
    });
}

// 对单个玩家结算伤害（含击杀计分与播报），供子弹直击与爆炸复用
function applyDamageTo(player, damage, shooterId, weaponName) {
    const shooter = gameState.players.get(shooterId);
    const wasAlive = player.isAlive;
    player.takeDamage(damage);

    if (shooter) {
        if (wasAlive && !player.isAlive) {
            shooter.score = Math.min(65535, (shooter.score || 0) + 100);
            const killInfo = {
                killer: shooter.nickname,
                victim: player.nickname,
                weapon: weaponName,
                timestamp: Date.now()
            };
            gameState.killFeed.push(killInfo);
            broadcast({ type: 'killFeed', killInfo });
        } else {
            shooter.score = Math.min(65535, (shooter.score || 0) + 10);
        }
    }

    broadcast({
        type: 'playerHit',
        targetId: player.id,
        shooterId: shooterId,
        damage: damage,
        isKill: wasAlive && !player.isAlive
    });
}

// 范围爆炸：按距离衰减伤害（中心全额→边缘35%），不伤及投掷者与队友
function explodeAt(x, y, radius, damageBase, shooterId, weaponName) {
    const shooter = gameState.players.get(shooterId);
    gameState.players.forEach(player => {
        if (player.id === shooterId || !player.isAlive || isSameTeam(player, shooter)) return;
        const dx = (player.x + GAME_CONFIG.PLAYER_SIZE / 2) - x;
        const dy = (player.y + GAME_CONFIG.PLAYER_SIZE / 2) - y;
        const dist = Math.hypot(dx, dy);
        if (dist > radius + GAME_CONFIG.PLAYER_SIZE / 2) return;
        let damage = Math.max(1, Math.round(damageBase * (1 - 0.65 * Math.min(1, dist / radius))));
        if (shooter && shooter.powerups.damageBoost && shooter.powerups.damageBoost.active) {
            damage = Math.floor(damage * 1.5);
        }
        applyDamageTo(player, damage, shooterId, weaponName);
    });
    broadcast({ type: 'explosion', x: Math.round(x), y: Math.round(y), radius: Math.round(radius) });
}

function explodeBullet(bullet) {
    explodeAt(
        bullet.x, bullet.y,
        bullet.blastRadius || 90,
        bullet.blastDamage || bullet.damage || 80,
        bullet.ownerId,
        bullet.weaponName || '火箭筒'
    );
}

// 子弹碰撞处理函数
function processBulletCollisions(bullet) {
    const isRocket = bullet.kind === 1;

    // 手雷：飞抵落点或遇墙/边界即停驻，等 life 引信起爆（不参与碰撞伤害）
    if (bullet.kind === 2) {
        if (bullet.vx || bullet.vy) {
            const traveled = Math.hypot(bullet.x - bullet.originX, bullet.y - bullet.originY);
            const nextX = bullet.x + bullet.vx;
            const nextY = bullet.y + bullet.vy;
            if (traveled >= bullet.throwDist ||
                nextX <= 6 || nextX >= GAME_CONFIG.CANVAS_WIDTH - 6 ||
                nextY <= 6 || nextY >= GAME_CONFIG.CANVAS_HEIGHT - 6 ||
                checkTerrainCollision(nextX - 3, nextY - 3, 6, 6)) {
                bullet.vx = 0;
                bullet.vy = 0;
            }
        }
        return true;
    }

    // 检查子弹边界
    if (bullet.x <= 0 || bullet.x >= GAME_CONFIG.CANVAS_WIDTH ||
        bullet.y <= 0 || bullet.y >= GAME_CONFIG.CANVAS_HEIGHT) {
        if (isRocket) explodeBullet(bullet);
        return false; // 移除子弹
    }

    // 检查地形碰撞
    const bulletSize = GAME_CONFIG.BULLET_SIZE;
    const nextX = bullet.x + bullet.vx;
    const nextY = bullet.y + bullet.vy;

    if (checkTerrainCollision(nextX - bulletSize / 2, nextY - bulletSize / 2, bulletSize, bulletSize)) {
        if (isRocket) {
            explodeBullet(bullet);
        } else {
            broadcast({
                type: 'bulletHitWall',
                x: bullet.x,
                y: bullet.y,
                bulletId: bullet.id
            });
        }
        return false; // 移除子弹
    }

    // 检查玩家碰撞（分队模式下子弹穿过队友，不造成伤害）
    let bulletHitPlayer = false;
    const shooter = gameState.players.get(bullet.ownerId);

    gameState.players.forEach(player => {
        if (bulletHitPlayer) return;
        if (player.id !== bullet.ownerId && player.isAlive && !isSameTeam(player, shooter)) {
            const dx = bullet.x - (player.x + GAME_CONFIG.PLAYER_SIZE / 2);
            const dy = bullet.y - (player.y + GAME_CONFIG.PLAYER_SIZE / 2);
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < (GAME_CONFIG.PLAYER_SIZE / 2 + GAME_CONFIG.BULLET_SIZE / 2)) {
                bulletHitPlayer = true;
                if (isRocket) {
                    // 火箭弹直击：转为爆炸结算（命中者位于爆心，吃满伤害）
                    explodeBullet(bullet);
                    return;
                }
                let damage = bullet.damage || 25;
                if (shooter && shooter.powerups.damageBoost && shooter.powerups.damageBoost.active) {
                    damage = Math.floor(damage * 1.5);
                }
                applyDamageTo(player, damage, bullet.ownerId, (WEAPONS[shooter && shooter.weapon] || WEAPONS.rifle).name);
            }
        }
    });

    return !bulletHitPlayer; // 击中玩家则移除子弹
}

// 结束游戏
function endGame() {
    console.log('游戏结束');
    gameState.isGameEnded = true;
    gameState.showingResults = true;
    gameState.countdown = 5; // 5秒结果展示
    gameState.countdownStartTime = Date.now();
    
    // 获取最终排行榜
    const finalPlayers = getPlayersList();

    // 分队模式：播报团队胜负
    if (matchConfig.teamMode) {
        const totals = { 1: 0, 2: 0 };
        gameState.players.forEach(p => {
            if (p.team === 1 || p.team === 2) totals[p.team] += p.score || 0;
        });
        const content = totals[1] === totals[2]
            ? `本局平局！红队 ${totals[1]} : ${totals[2]} 蓝队`
            : `${TEAM_NAMES[totals[1] > totals[2] ? 1 : 2]}获胜！红队 ${totals[1]} : ${totals[2]} 蓝队`;
        broadcast({ type: 'chatMessage', playerId: 0, playerName: '系统', content, timestamp: Date.now() });
    }

    // 广播游戏结束
    broadcast({
        type: 'gameEnd',
        countdown: gameState.countdown,
        showingResults: true,
        players: finalPlayers,
        killFeed: gameState.killFeed.slice(-10),
        terrain: gameState.terrain
    });
}

// 重置游戏状态
function resetGameState() {
    console.log('重置游戏状态');
    gameState.gameStartTime = Date.now();
    gameState.isGameEnded = false;
    gameState.showingResults = false;
    gameState.countdown = 0;

    // 应用下一局的地图/模式变更（由 /map、/team 指令设定）
    let mapChanged = false;
    if (matchConfig.pendingMapId && MAPS[matchConfig.pendingMapId]) {
        if (matchConfig.pendingMapId !== matchConfig.mapId) {
            matchConfig.mapId = matchConfig.pendingMapId;
            mapChanged = true;
        }
    }
    matchConfig.pendingMapId = null;
    if (matchConfig.pendingTeamMode !== null) {
        matchConfig.teamMode = matchConfig.pendingTeamMode;
        matchConfig.pendingTeamMode = null;
    }
    if (mapChanged) {
        gameState.terrain = generateTerrain(matchConfig.mapId);
        console.log(`地图切换为 ${MAPS[matchConfig.mapId].name}，生成 ${gameState.terrain.length} 个地形块`);
    }

    // 分队维护：开启分队时给没有队伍的玩家均衡补队，关闭时清空队伍并恢复个人配色
    gameState.players.forEach(player => {
        if (matchConfig.teamMode) {
            if (player.team !== 1 && player.team !== 2) {
                player.team = pickBalancedTeam();
                applyTeamColor(player);
            }
        } else if (player.team) {
            player.team = 0;
            applyTeamColor(player);
        }
    });

    // 重置所有玩家
    gameState.players.forEach(player => {
        player.health = GAME_CONFIG.MAX_HEALTH;
        player.score = 0;
        player.isAlive = true;
        player.respawnTime = 0;
        player.respawn();
        
        // 清除所有道具效果
        Object.keys(player.powerups).forEach(key => {
            player.powerups[key].active = false;
            player.powerups[key].endTime = 0;
        });
    });
    
    // 清空子弹和击杀记录
    gameState.bullets = [];
    gameState.killFeed = [];
    
    // 重新生成道具
    gameState.powerups = [];
    
    console.log('游戏状态重置完成');
}

// 游戏状态管理函数（从原gameLoop提取）
function updateGameCountdown() {
    // 处理倒计时逻辑（基于实际时间）
    if (gameState.countdown > 0) {
        const currentTime = Date.now();
        const elapsedTime = currentTime - gameState.countdownStartTime;
        const totalCountdownSeconds = gameState.showingResults ? 5 : 3; // 根据阶段确定总倒计时秒数
        const remainingSeconds = Math.max(0, Math.ceil(totalCountdownSeconds - (elapsedTime / 1000)));
        
        // 更新倒计时显示
        if (remainingSeconds !== gameState.countdown) {
            gameState.countdown = remainingSeconds;
            
            // 广播倒计时更新给所有客户端
            if (gameState.showingResults) {
                // 游戏结束倒计时更新
                broadcast({
                    type: 'gameEnd',
                    countdown: gameState.countdown,
                    showingResults: true,
                    players: getPlayersWithBuffs(),
                    killFeed: gameState.killFeed.slice(-10),
                    terrain: gameState.terrain
                });
            } else {
                // 新游戏开始倒计时更新
                broadcast({
                    type: 'newGameStart',
                    countdown: gameState.countdown,
                    players: getPlayersWithBuffs(),
                    terrain: gameState.terrain
                });
            }
            console.log(`倒计时更新: ${gameState.countdown}秒 (${gameState.showingResults ? '结果展示' : '新游戏开始'})`);
        }
        
        if (gameState.countdown <= 0) {
            if (gameState.showingResults) {
                // 排行榜展示时间结束，开始新游戏倒计时
                console.log('结果展示倒计时结束，开始新游戏倒计时');
                gameState.showingResults = false;
                gameState.countdown = 3; // 3秒新游戏开始倒计时
                gameState.countdownStartTime = Date.now();
                
                // 广播新游戏开始倒计时
                console.log('发送 newGameStart 消息，倒计时:', gameState.countdown);
                broadcast({
                    type: 'newGameStart',
                    countdown: gameState.countdown,
                    players: getPlayersWithBuffs(),
                    terrain: gameState.terrain
                });
                return;
            } else {
                // 新游戏倒计时结束，正式开始游戏
                console.log('新游戏倒计时结束，正式开始游戏');
                gameState.isGameEnded = false;
                
                // 重置游戏状态
                resetGameState();
                
                // 广播游戏正式开始
                console.log('发送 gameStarted 消息');
                broadcast({
                    type: 'gameStarted',
                    players: getPlayersWithBuffs(),
                    terrain: gameState.terrain
                });

                // 紧接着广播一次完整快照，确保所有客户端与新地形、初始状态同步
                broadcast({ type: 'gameState' }, null, 3);
                return;
            }
        }
    }
    
}

// 游戏逻辑和网络推送分离
let gameLogicInterval = 16; // 游戏逻辑60FPS（子弹按tick步进，同时决定弹速手感）
let networkUpdateInterval = 16; // 网络推送60FPS，流畅同步
let lastPerformanceCheck = Date.now();
let frameCount = 0;
let adaptiveCounter = 0;

// 游戏逻辑更新函数（独立于渲染）
function updateGameLogic() {
    const now = Date.now();
    const deltaTime = gameState.lastGameLogicUpdate ? now - gameState.lastGameLogicUpdate : gameLogicInterval;
    gameState.lastGameLogicUpdate = now;

    // 如果没有真人玩家，游戏保持停止状态（机器人不计入）
    if (humanPlayerCount() === 0) {
        if (!gameState.isGameEnded) {
            gameState.isGameEnded = true;
            gameState.gameStartTime = null;
        }
        return;
    }

    // 如果有真人玩家但游戏未开始，开始游戏
    if (gameState.isGameEnded && humanPlayerCount() > 0 && !gameState.gameStartTime) {
        console.log('有玩家加入，开始新游戏');
        gameState.gameStartTime = now;
        gameState.isGameEnded = false;
    }

    // 检查游戏时间
    if (!gameState.isGameEnded && gameState.gameStartTime) {
        const remainingTime = gameState.gameDuration - (now - gameState.gameStartTime);
        
        if (remainingTime <= 0) {
            console.log('游戏时间结束，触发endGame()');
            endGame();
            return;
        }
    }
    
    // 计算delta时间
    const currentTime = Date.now();
    const playerDeltaTime = gameState.lastUpdateTime ? currentTime - gameState.lastUpdateTime : gameLogicInterval;
    gameState.lastUpdateTime = currentTime;
    
    // 更新玩家
    gameState.players.forEach(player => {
        player.update(playerDeltaTime);
    });
    
    // 更新AI机器人
    updateBots(currentTime);
    
    // 更新子弹
    gameState.bullets = gameState.bullets.filter(bullet => {
        bullet.update(playerDeltaTime);
        if (bullet.life <= 0) {
            // 火箭弹/手雷寿命到期（引信）时起爆
            if (bullet.kind === 1 || bullet.kind === 2) explodeBullet(bullet);
            return false;
        }

        // 子弹物理更新（碰撞检测等）
        return processBulletCollisions(bullet);
    });
    
    // 检查道具拾取
    checkPowerupPickup();
    
    // 更新游戏倒计时
    updateGameCountdown();
}

// 网络状态推送函数（独立于游戏逻辑）
function broadcastGameState() {
    // 结果展示阶段不推送位置状态，减少无意义数据
    if (gameState.showingResults) return;
    
    // 生成更新（增量或完整）
    const update = generateIncrementalUpdate();
    if (update && update.type === 'incrementalUpdate') {
        broadcast(update, null, 3);
    } else {
        broadcast({ type: 'gameUpdate' }, null, 3);
    }
    gameState.updateCounter++;
}

// 性能监控和自适应调整
function adaptiveGameLoop() {
    const now = Date.now();
    frameCount++;
    adaptiveCounter++;
    
    // 每5秒检查一次性能
    if (now - lastPerformanceCheck > 5000) {
        const averagePing = Array.from(gameState.clientPing.values()).reduce((a, b) => a + b, 0) / gameState.clientPing.size || 50;
        const playerCount = gameState.players.size;
        const poorNetworkCount = Array.from(gameState.clientNetworkQuality.values()).filter(q => q === 'poor').length;
        
        // 游戏逻辑保持60FPS稳定
        gameLogicInterval = 16;
        
        // 根据网络状况调整推送频率
        if (poorNetworkCount > playerCount * 0.5) {
            networkUpdateInterval = 25; // 40FPS for poor network
        } else if (averagePing > 200) {
            networkUpdateInterval = 20; // 50FPS for high latency
        } else {
            networkUpdateInterval = 16; // 60FPS for good network
        }
        
        console.log(`游戏逻辑: ${Math.round(1000/gameLogicInterval)}FPS, 网络推送: ${Math.round(1000/networkUpdateInterval)}FPS (Ping: ${Math.round(averagePing)}ms, 玩家: ${playerCount})`);
        
        lastPerformanceCheck = now;
        frameCount = 0;
    }
    
    // 继续循环
    setTimeout(adaptiveGameLoop, Math.min(gameLogicInterval, networkUpdateInterval));
}

// 启动分离的游戏循环
function startGameSystems() {
    // 游戏逻辑循环 - 固定30FPS
    setInterval(updateGameLogic, gameLogicInterval);
    
    // 自适应网络推送循环 - 使用setTimeout以便动态调整
    (function networkLoop() {
        broadcastGameState();
        setTimeout(networkLoop, networkUpdateInterval);
    })();
    
    // 性能监控和自适应调整（会动态更新networkUpdateInterval）
    adaptiveGameLoop();
}

// 启动主机（仅房主页面调用一次）
// opts: { mapId, teamMode } — 房主创建房间时选择的地图与对战模式
let started = false;
function start(opts) {
    if (started) return;
    started = true;

    if (opts && opts.mapId && MAPS[opts.mapId]) {
        matchConfig.mapId = opts.mapId;
    }
    if (opts && typeof opts.teamMode === 'boolean') {
        matchConfig.teamMode = opts.teamMode;
    }
    console.log(`对局配置：地图=${MAPS[matchConfig.mapId].name}，模式=${matchConfig.teamMode ? '红蓝对抗' : '个人混战'}`);

    // 初始化地形
    gameState.terrain = generateTerrain(matchConfig.mapId);
    console.log(`地形初始化完成，生成了 ${gameState.terrain.length} 个地形块`);

    // 启动游戏系统
    startGameSystems();

    // 启动道具生成定时器
    setInterval(spawnPowerup, GAME_CONFIG.POWERUP_SPAWN_INTERVAL);

    // 启动批处理清理定时器
    setInterval(() => {
        // 清理空的消息队列
        gameState.messageQueue.forEach((queue, playerId) => {
            if (queue.length === 0) {
                gameState.messageQueue.delete(playerId);
            }
        });

        // 清理压缩缓存
        if (gameState.compressionCache.size > 100) {
            gameState.compressionCache.clear();
        }
    }, 30000); // 每30秒清理一次
}

return {
    start,
    addConnection,
    addBot,
    removeBot,
    setBotCount,
    getMaps: () => Object.keys(MAPS).map(id => ({ id, name: MAPS[id].name })),
    get botCount() { return bots.size; },
    get playerCount() { return gameState.players.size; },
    get connectionCount() { return connections.size; },
    get matchConfig() { return { mapId: matchConfig.mapId, teamMode: matchConfig.teamMode }; }
};
})();
