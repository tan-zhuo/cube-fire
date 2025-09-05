const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const compression = require('compression');

// 创建HTTP服务器
const server = http.createServer((req, res) => {
    // 使用压缩中间件
    compression()(req, res, () => {
        let filePath = req.url === '/' ? 'index.html' : req.url.substring(1);
        const fullPath = path.join(__dirname, filePath);
    
    // 设置MIME类型
    const ext = path.extname(fullPath);
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css'
    };
    
    const contentType = mimeTypes[ext] || 'text/plain';
    
    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
    });
});

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// 游戏状态
const gameState = {
    players: new Map(),
    bullets: [],
    powerups: [],
    terrain: [],
    nextPlayerId: 1,
    nextPowerupId: 1,
    gameStartTime: Date.now(),
    gameDuration: 120000, // 120秒 = 120000毫秒
    isGameEnded: false,
    killFeed: [],
    countdown: 0,
    showingResults: false,
    countdownStartTime: 0 // 倒计时开始时间
};

// 确保游戏状态正确初始化
console.log('游戏状态初始化:', {
    isGameEnded: gameState.isGameEnded,
    countdown: gameState.countdown,
    showingResults: gameState.showingResults
});

// 游戏配置
const GAME_CONFIG = {
    CANVAS_WIDTH: 1200,
    CANVAS_HEIGHT: 800,
    PLAYER_SIZE: 20,
    BULLET_SIZE: 4,
    BULLET_SPEED: 8,
    PLAYER_SPEED: 5,
    MAX_HEALTH: 100,
    RESPAWN_TIME: 3000, // 3秒复活时间
    POWERUP_SIZE: 15,
    POWERUP_SPAWN_INTERVAL: 20000, // 20秒生成一个道具
    POWERUP_DURATION: 15000, // 道具持续时间15秒
    TERRAIN_SIZE: 40, // 地形块大小
    MELEE_RANGE: 50, // 近战攻击范围
    MELEE_DAMAGE: 100, // 近战攻击伤害（一刀秒杀）
    MELEE_COOLDOWN: 1000 // 近战攻击冷却时间1秒
};

// 道具类型
const POWERUP_TYPES = {
    SHIELD: 'shield',
    RAPID_FIRE: 'rapid_fire',
    DAMAGE_BOOST: 'damage_boost',
    HEAL: 'heal'
};

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
        this.shotCooldown = 200; // 射击冷却时间(毫秒)
        this.lastMelee = 0;
        this.meleeCooldown = GAME_CONFIG.MELEE_COOLDOWN; // 近战攻击冷却时间
        this.color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]; // 根据ID分配颜色
        
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

    update() {
        if (!this.isAlive && this.respawnTime > 0) {
            this.respawnTime -= 16; // 假设60FPS
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
    }
    
    move(dx, dy) {
        if (!this.isAlive) return;
        
        const newX = this.x + dx;
        const newY = this.y + dy;
        const playerSize = GAME_CONFIG.PLAYER_SIZE;
        
        // 检查边界碰撞
        if (newX < 0 || newX + playerSize > GAME_CONFIG.CANVAS_WIDTH ||
            newY < 0 || newY + playerSize > GAME_CONFIG.CANVAS_HEIGHT) {
            return;
        }
        
        // 检查地形碰撞
        if (checkTerrainCollision(newX, newY, playerSize, playerSize)) {
            return;
        }
        
        // 更新位置和移动状态
        this.x = newX;
        this.y = newY;
        this.vx = dx;
        this.vy = dy;
        this.isMoving = true;
        this.lastMoveTime = Date.now();
    }

    respawn() {
        // 尝试多次找到合适的复活位置
        let attempts = 0;
        let validPosition = false;
        let newX, newY;
        
        while (attempts < 50 && !validPosition) {
            newX = Math.random() * (GAME_CONFIG.CANVAS_WIDTH - GAME_CONFIG.PLAYER_SIZE);
            newY = Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.PLAYER_SIZE);
            
            // 检查是否与地形碰撞
            if (!checkTerrainCollision(newX, newY, GAME_CONFIG.PLAYER_SIZE, GAME_CONFIG.PLAYER_SIZE)) {
                // 检查是否与其他玩家碰撞
                let playerCollision = false;
                gameState.players.forEach(player => {
                    if (player.id !== this.id && player.isAlive) {
                        const distance = Math.sqrt((newX - player.x) ** 2 + (newY - player.y) ** 2);
                        if (distance < GAME_CONFIG.PLAYER_SIZE * 2) {
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
        
        // 如果找不到合适位置，使用默认位置
        if (!validPosition) {
            newX = GAME_CONFIG.CANVAS_WIDTH / 2;
            newY = GAME_CONFIG.CANVAS_HEIGHT / 2;
        }
        
        this.x = newX;
        this.y = newY;
        this.health = GAME_CONFIG.MAX_HEALTH;
        this.isAlive = true;
        this.respawnTime = 0;
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
        const now = Date.now();
        let cooldown = this.shotCooldown;
        
        // 快速射击效果：减少50%冷却时间
        if (this.powerups.rapidFire.active) {
            cooldown = Math.floor(cooldown * 0.5);
        }
        
        return this.isAlive && (now - this.lastShot) >= cooldown;
    }

    shoot(targetX, targetY) {
        if (!this.canShoot()) return null;

        this.lastShot = Date.now();
        
        // 计算子弹方向
        const dx = targetX - this.x;
        const dy = targetY - this.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // 计算伤害
        let damage = 25;
        if (this.powerups.damageBoost.active) {
            damage = Math.floor(damage * 1.5);
        }
        
        const bullet = {
            id: Date.now() + Math.random(),
            x: this.x + GAME_CONFIG.PLAYER_SIZE / 2,
            y: this.y + GAME_CONFIG.PLAYER_SIZE / 2,
            vx: (dx / distance) * GAME_CONFIG.BULLET_SPEED,
            vy: (dy / distance) * GAME_CONFIG.BULLET_SPEED,
            ownerId: this.id,
            damage: damage,
            life: 120 // 子弹存活时间(帧数)
        };
        
        return bullet;
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
        
        // 查找攻击范围内的玩家
        let hitPlayer = null;
        gameState.players.forEach(player => {
            if (player.id !== this.id && player.isAlive) {
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
                this.score += 100;
                // 添加击杀信息
                const killInfo = {
                    killer: this.nickname,
                    victim: hitPlayer.nickname,
                    weapon: '近战',
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
                this.score += 10;
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
    constructor(x, y, vx, vy, ownerId, damage = 25) {
        this.id = Date.now() + Math.random();
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.ownerId = ownerId;
        this.damage = damage;
        this.life = 120;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.life--;
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
                return '❤'; // 心形，代表回血
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

// 广播消息给所有客户端 - 优化数据包
function broadcast(message, excludeId = null) {
    // 压缩数据包
    const data = JSON.stringify(message);
    
    // 如果数据包太大，进行优化
    if (data.length > 1024) {
        // 对于大数据包，只发送必要信息
        const optimizedMessage = optimizeMessage(message);
        const optimizedData = JSON.stringify(optimizedMessage);
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.playerId !== excludeId) {
                client.send(optimizedData);
            }
        });
    } else {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.playerId !== excludeId) {
                client.send(data);
            }
        });
    }
}

// 优化消息数据包
function optimizeMessage(message) {
    if (message.type === 'gameUpdate') {
        // 优化游戏更新数据包
        const optimized = {
            type: message.type,
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
        health: player.health
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
        powerups: player.powerups,
        vx: player.vx || 0,
        vy: player.vy || 0,
        isMoving: player.isMoving || false
    }));
}

// 处理客户端连接
wss.on('connection', (ws) => {
    console.log('新客户端连接');
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('解析消息错误:', error);
        }
    });

    ws.on('close', () => {
        if (ws.playerId) {
            console.log(`玩家 ${ws.playerId} 断开连接`);
            gameState.players.delete(ws.playerId);
            broadcast({
                type: 'playerLeft',
                playerId: ws.playerId
            });
        }
    });
});

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
    }
}

// 处理玩家加入
function handleJoin(ws, message) {
    const { nickname } = message;
    const playerId = gameState.nextPlayerId++;
    
    // 为新玩家找一个安全的生成位置
    let spawnX, spawnY;
    let spawnAttempts = 0;
    let validSpawnFound = false;
    
    while (spawnAttempts < 100 && !validSpawnFound) {
        spawnX = Math.random() * (GAME_CONFIG.CANVAS_WIDTH - GAME_CONFIG.PLAYER_SIZE);
        spawnY = Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.PLAYER_SIZE);
        
        // 检查是否与地形碰撞
        if (!checkTerrainCollision(spawnX, spawnY, GAME_CONFIG.PLAYER_SIZE, GAME_CONFIG.PLAYER_SIZE)) {
            // 检查是否与其他玩家距离过近
            let tooCloseToOthers = false;
            gameState.players.forEach(existingPlayer => {
                if (existingPlayer.isAlive) {
                    const distance = Math.sqrt((spawnX - existingPlayer.x) ** 2 + (spawnY - existingPlayer.y) ** 2);
                    if (distance < GAME_CONFIG.PLAYER_SIZE * 3) {
                        tooCloseToOthers = true;
                    }
                }
            });
            
            if (!tooCloseToOthers) {
                validSpawnFound = true;
            }
        }
        
        spawnAttempts++;
    }
    
    // 如果找不到合适位置，使用默认的安全位置
    if (!validSpawnFound) {
        spawnX = 50;
        spawnY = 50;
    }
    
    // 创建玩家
    const player = new Player(
        playerId,
        nickname,
        spawnX,
        spawnY
    );
    
    gameState.players.set(playerId, player);
    ws.playerId = playerId;
    
    // 发送玩家ID
    ws.send(JSON.stringify({
        type: 'joined',
        playerId: playerId,
        gameConfig: GAME_CONFIG
    }));
    
    // 广播新玩家加入
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
            powerups: player.powerups
        }
    }, playerId);
    
    // 发送当前游戏状态
    const gameStateData = {
        type: 'gameState',
        players: Array.from(gameState.players.values()).map(p => ({
            id: p.id,
            nickname: p.nickname,
            x: p.x,
            y: p.y,
            angle: p.angle,
            health: p.health,
            score: p.score,
            isAlive: p.isAlive,
            color: p.color,
            powerups: p.powerups
        })),
        bullets: gameState.bullets.map(b => ({
            id: b.id,
            x: b.x,
            y: b.y,
            vx: b.vx,
            vy: b.vy,
            ownerId: b.ownerId
        })),
        powerups: gameState.powerups.map(p => ({
            id: p.id,
            type: p.type,
            x: p.x,
            y: p.y,
            color: p.getColor(),
            icon: p.getIcon()
        })),
        terrain: gameState.terrain
    };
    
    ws.send(JSON.stringify(gameStateData));
    
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
    
    // 广播移动信息
    broadcast({
        type: 'playerMove',
        playerId: player.id,
        x: player.x,
        y: player.y,
        angle: player.angle
    });
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
    console.log(`玩家 ${player.nickname} 射击到 (${targetX}, ${targetY})`);
    
    const bullet = player.shoot(targetX, targetY);
    
    if (bullet) {
        gameState.bullets.push(bullet);
        console.log(`子弹创建成功: ID=${bullet.id}, 位置=(${bullet.x}, ${bullet.y}), 速度=(${bullet.vx}, ${bullet.vy})`);
        
        // 广播子弹信息
        broadcast({
            type: 'bulletShot',
            bullet: {
                id: bullet.id,
                x: bullet.x,
                y: bullet.y,
                vx: bullet.vx,
                vy: bullet.vy,
                ownerId: bullet.ownerId
            }
        });
    } else {
        console.log('子弹创建失败: 可能还在冷却中');
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

// 生成地形
function generateTerrain() {
    const terrain = [];
    const size = GAME_CONFIG.TERRAIN_SIZE;
    
    // 地形类型
    const terrainTypes = ['wall', 'rock', 'crate', 'barrel'];
    
    // 生成一些随机的地形块
    for (let i = 0; i < 20; i++) {
        const x = Math.random() * (GAME_CONFIG.CANVAS_WIDTH - size);
        const y = Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - size);
        
        // 确保地形不会生成在边缘
        if (x > 50 && x < GAME_CONFIG.CANVAS_WIDTH - 50 && 
            y > 50 && y < GAME_CONFIG.CANVAS_HEIGHT - 50) {
            
            const type = terrainTypes[Math.floor(Math.random() * terrainTypes.length)];
            terrain.push({
                id: i,
                x: Math.floor(x / size) * size,
                y: Math.floor(y / size) * size,
                width: size,
                height: size,
                type: type
            });
        }
    }
    
    // 添加一些L形和T形结构
    const complexStructures = [
        // L形结构1
        { x: 200, y: 200, pattern: 'L1' },
        { x: 800, y: 300, pattern: 'L2' },
        { x: 400, y: 500, pattern: 'T1' },
        { x: 900, y: 600, pattern: 'T2' }
    ];
    
    complexStructures.forEach((structure, index) => {
        const baseId = 100 + index * 10;
        switch (structure.pattern) {
            case 'L1':
                // L形 (左下)
                terrain.push({ id: baseId, x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 1, x: structure.x, y: structure.y + size, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 2, x: structure.x + size, y: structure.y + size, width: size, height: size, type: 'wall' });
                break;
            case 'L2':
                // L形 (右上)
                terrain.push({ id: baseId, x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 1, x: structure.x + size, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 2, x: structure.x + size, y: structure.y + size, width: size, height: size, type: 'wall' });
                break;
            case 'T1':
                // T形
                terrain.push({ id: baseId, x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 1, x: structure.x - size, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 2, x: structure.x + size, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 3, x: structure.x, y: structure.y + size, width: size, height: size, type: 'wall' });
                break;
            case 'T2':
                // 倒T形
                terrain.push({ id: baseId, x: structure.x, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 1, x: structure.x, y: structure.y - size, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 2, x: structure.x - size, y: structure.y, width: size, height: size, type: 'wall' });
                terrain.push({ id: baseId + 3, x: structure.x + size, y: structure.y, width: size, height: size, type: 'wall' });
                break;
        }
    });
    
    // 添加一些边界墙
    // 顶部和底部
    for (let x = 0; x < GAME_CONFIG.CANVAS_WIDTH; x += size) {
        terrain.push({
            id: terrain.length,
            x: x,
            y: 0,
            width: size,
            height: size,
            type: 'wall'
        });
        terrain.push({
            id: terrain.length,
            x: x,
            y: GAME_CONFIG.CANVAS_HEIGHT - size,
            width: size,
            height: size,
            type: 'wall'
        });
    }
    
    // 左侧和右侧
    for (let y = 0; y < GAME_CONFIG.CANVAS_HEIGHT; y += size) {
        terrain.push({
            id: terrain.length,
            x: 0,
            y: y,
            width: size,
            height: size,
            type: 'wall'
        });
        terrain.push({
            id: terrain.length,
            x: GAME_CONFIG.CANVAS_WIDTH - size,
            y: y,
            width: size,
            height: size,
            type: 'wall'
        });
    }
    
    return terrain;
}

// 生成道具
function spawnPowerup() {
    // 限制同时存在的道具数量不超过4个
    if (gameState.powerups.length >= 4) {
        return;
    }
    
    const types = Object.values(POWERUP_TYPES);
    const type = types[Math.floor(Math.random() * types.length)];
    
    // 尝试多次生成道具，确保不在地形内
    let attempts = 0;
    let x, y;
    let validPosition = false;
    
    while (attempts < 50 && !validPosition) {
        x = Math.random() * (GAME_CONFIG.CANVAS_WIDTH - GAME_CONFIG.POWERUP_SIZE);
        y = Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.POWERUP_SIZE);
        
        // 检查是否与地形碰撞
        if (!checkTerrainCollision(x, y, GAME_CONFIG.POWERUP_SIZE, GAME_CONFIG.POWERUP_SIZE)) {
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
                            // 回血道具立即生效
                            const healAmount = Math.floor(GAME_CONFIG.MAX_HEALTH);
                            player.health = Math.min(GAME_CONFIG.MAX_HEALTH, player.health + healAmount);
                            break;
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

// 游戏主循环
function gameLoop() {
    const loopTime = Date.now();
    
    // 处理倒计时逻辑（基于实际时间）
    if (gameState.countdown > 0) {
        const currentTime = Date.now();
        const elapsedTime = currentTime - gameState.countdownStartTime;
        const totalCountdownSeconds = gameState.showingResults ? 5 : 3; // 根据阶段确定总倒计时秒数
        const remainingSeconds = Math.max(0, Math.ceil(totalCountdownSeconds - (elapsedTime / 1000)));
        
        // 更新倒计时显示
        if (remainingSeconds !== gameState.countdown) {
            gameState.countdown = remainingSeconds;
        }
        
        if (gameState.countdown <= 0) {
            if (gameState.showingResults) {
                // 排行榜展示时间结束，直接开始新游戏
                gameState.showingResults = false;
                gameState.isGameEnded = false;
                
                // 重置游戏状态
                resetGameState();
                
                // 广播游戏正式开始
                broadcast({
                    type: 'gameStarted',
                    players: getPlayersWithBuffs(),
                    terrain: gameState.terrain
                });
                return;
            }
        }
    }
    
    // 蒙版关闭延迟逻辑已移除，游戏结束5秒后直接开始新游戏
    
    if (!gameState.isGameEnded) {
        // 检查游戏时间
        const elapsedTime = loopTime - gameState.gameStartTime;
        const remainingTime = Math.max(0, gameState.gameDuration - elapsedTime);
        
        // 如果时间到了，结束游戏
        if (remainingTime <= 0) {
            endGame();
            return;
        }
    }
    
    // 更新玩家
    gameState.players.forEach(player => {
        player.update();
    });
    
    // 更新子弹
    gameState.bullets = gameState.bullets.filter(bullet => {
        // 检查生命周期
        bullet.life--;
        if (bullet.life <= 0) {
            return false; // 移除子弹
        }
        
        // 检查子弹下一个位置是否会擞墙
        const nextX = bullet.x + bullet.vx;
        const nextY = bullet.y + bullet.vy;
        
        // 检查边界
        if (nextX <= 0 || nextX >= GAME_CONFIG.CANVAS_WIDTH ||
            nextY <= 0 || nextY >= GAME_CONFIG.CANVAS_HEIGHT) {
            return false; // 移除子弹
        }
        
        // 检查地形碰撞 - 简化但更可靠的检测
        const bulletSize = GAME_CONFIG.BULLET_SIZE;
        const checkX = nextX - bulletSize / 2;
        const checkY = nextY - bulletSize / 2;
        
        if (checkTerrainCollision(checkX, checkY, bulletSize, bulletSize)) {
            // 广播子弹击中墙体特效
            console.log(`子弹击中墙体: (${bullet.x}, ${bullet.y}) -> (${nextX}, ${nextY})`);
            broadcast({
                type: 'bulletHitWall',
                x: bullet.x,
                y: bullet.y
            });
            return false; // 移除子弹
        }
        
        // 如果通过了所有检查，更新位置
        bullet.x = nextX;
        bullet.y = nextY;
        
        // 检查子弹与玩家碰撞
        if (bullet.ownerId) {
            gameState.players.forEach(player => {
                if (player.id !== bullet.ownerId && player.isAlive) {
                    const bulletRect = {
                        x: bullet.x - GAME_CONFIG.BULLET_SIZE / 2,
                        y: bullet.y - GAME_CONFIG.BULLET_SIZE / 2,
                        width: GAME_CONFIG.BULLET_SIZE,
                        height: GAME_CONFIG.BULLET_SIZE
                    };
                    
                    const playerRect = {
                        x: player.x,
                        y: player.y,
                        width: GAME_CONFIG.PLAYER_SIZE,
                        height: GAME_CONFIG.PLAYER_SIZE
                    };
                    
                    if (checkCollision(bulletRect, playerRect)) {
                        // 计算伤害
                        let damage = bullet.damage;
                        const shooter = gameState.players.get(bullet.ownerId);
                        if (shooter && shooter.powerups.damageBoost.active) {
                            damage = Math.floor(damage * 1.5); // 伤害提升50%
                        }
                        
                        const wasAlive = player.isAlive;
                        player.takeDamage(damage);
                        
                        // 增加射击者分数
                        if (shooter) {
                            if (wasAlive && !player.isAlive) {
                                // 击杀
                                shooter.score += 100;
                                // 添加击杀信息
                                const killInfo = {
                                    killer: shooter.nickname,
                                    victim: player.nickname,
                                    weapon: '枪械',
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
                                shooter.score += 10;
                            }
                        }
                        
                        // 广播击中事件
                        broadcast({
                            type: 'playerHit',
                            targetId: player.id,
                            shooterId: bullet.ownerId,
                            damage: damage,
                            isKill: wasAlive && !player.isAlive
                        });
                        
                        return false; // 移除子弹
                    }
                }
            });
        }
        
        // 检查子弹边界和生命周期
        if (bullet.life <= 0 || 
            bullet.x <= 0 || bullet.x >= GAME_CONFIG.CANVAS_WIDTH ||
            bullet.y <= 0 || bullet.y >= GAME_CONFIG.CANVAS_HEIGHT) {
            return false; // 移除子弹
        }
        
        return true; // 保留子弹
    });
    
    // 检查道具拾取
    checkPowerupPickup();
    
    // 广播游戏状态更新
    const gameTime = Date.now();
    const elapsedTime = gameTime - gameState.gameStartTime;
    const remainingTime = Math.max(0, gameState.gameDuration - elapsedTime);
    
    const gameUpdateMessage = {
        type: 'gameUpdate',
        players: getPlayersWithBuffs(),
        bullets: gameState.bullets,
        powerups: gameState.powerups,
        terrain: gameState.terrain,
        remainingTime: remainingTime,
        isGameEnded: gameState.isGameEnded
    };
    
    // 只有在倒计时大于0时才发送倒计时信息
    if (gameState.countdown > 0) {
        gameUpdateMessage.countdown = gameState.countdown;
        gameUpdateMessage.showingResults = gameState.showingResults;
    }
    
    broadcast(gameUpdateMessage);
}

// 游戏结束函数
function endGame() {
    gameState.isGameEnded = true;
    gameState.countdown = 5; // 5秒展示排行榜时间
    gameState.showingResults = true; // 标记正在展示结果
    gameState.countdownStartTime = Date.now(); // 设置倒计时开始时间
    
    // 广播游戏结束消息
    broadcast({
        type: 'gameEnd',
        players: getPlayersWithBuffs(),
        killFeed: gameState.killFeed.slice(-10),
        countdown: gameState.countdown,
        showingResults: gameState.showingResults
    });
}

// 重置游戏状态（游戏结束后直接开始新游戏时调用）
function resetGameState() {
    gameState.gameStartTime = Date.now();
    
    // 重置所有玩家
    gameState.players.forEach(player => {
        player.score = 0;
        player.health = GAME_CONFIG.MAX_HEALTH;
        player.isAlive = true;
        player.respawnTime = 0; // 重置复活时间
        player.powerups = {
            shield: { active: false, endTime: 0 },
            rapidFire: { active: false, endTime: 0 },
            damageBoost: { active: false, endTime: 0 }
        };
        
        // 随机重置位置
        player.x = Math.random() * (GAME_CONFIG.CANVAS_WIDTH - GAME_CONFIG.PLAYER_SIZE);
        player.y = Math.random() * (GAME_CONFIG.CANVAS_HEIGHT - GAME_CONFIG.PLAYER_SIZE);
    });
    
    // 清空子弹和道具
    gameState.bullets = [];
    gameState.powerups = [];
    
    // 清空击杀信息
    gameState.killFeed = [];
    
    // 重新生成地形
    gameState.terrain = generateTerrain();
}

// 初始化地形
gameState.terrain = generateTerrain();

// 启动游戏循环
setInterval(gameLoop, 16); // 约60FPS

// 启动道具生成定时器
setInterval(spawnPowerup, GAME_CONFIG.POWERUP_SPAWN_INTERVAL);

// 启动服务器
const PORT = process.env.PORT || 38080;
const HOST = '0.0.0.0'; // 监听所有网络接口
server.listen(PORT, HOST, () => {
    console.log(`游戏服务器运行在 http://0.0.0.0:${PORT}`);
    console.log(`本地访问: http://localhost:${PORT}`);
    console.log(`网络访问: http://[你的IP地址]:${PORT}`);
    console.log('等待玩家连接...');
});
