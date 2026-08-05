# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

CUBEFIRE·立方火线：多人局域网2.5D俯视角射击游戏，支持两种联机模式：
- **无服务器模式（默认）**：直接打开`index.html`，房主浏览器运行权威游戏逻辑（`host-core.js`），其他玩家通过WebRTC DataChannel直连。信令两种：6位房间码（PeerJS公共信令云自动握手，默认）或手动交换邀请码/应答码（纯离线后备，无需任何网络服务）
- **服务器模式（原版）**：Node.js WebSocket服务器（`server.js`）

## 开发命令

- `npm start` - 启动生产服务器
- `npm run dev` - 启动开发服务器（使用nodemon自动重启）
- `npm install` - 安装依赖包

## 项目架构

### 核心文件
- `server.js` - WebSocket服务器，处理游戏逻辑、玩家连接和实时通信（服务器模式）
- `host-core.js` - 浏览器端游戏主机，从`server.js`移植的权威游戏逻辑（无服务器模式，两份`GAME_CONFIG`需保持一致）
- `lan.js` - 房间码信令（PeerJS）、选举制房间列表（玩家页面竞争认领`cubefire-v1-lobby`固定ID兼任目录节点，房主心跳注册、访客轮询拉取、目录死亡自动补位）、WebRTC手动信令（邀请码/应答码）、传输层封装（本地回环/DataChannel）和大厅UI逻辑
- `game.js` - 客户端游戏逻辑，包含粒子系统、特效、渲染和输入处理；通过`window.createGameTransport`工厂选择传输方式，未设置时回退WebSocket
- `index.html` - 游戏主页面，包含完整的用户界面、样式和联机大厅

### 架构模式
- **客户端-服务器架构**：服务器管理游戏状态，客户端负责渲染和输入
- **实时通信**：通过WebSocket进行双向通信
- **游戏循环**：服务器端60FPS游戏循环，客户端渲染循环

### 地图与对战模式
- 地图注册表`MAPS`定义在`server.js`/`host-core.js`（两份需保持一致）：`classic`经典竞技场、`fortress`双子要塞、`maze`迷宫回廊、`crossfire`十字堡垒，均为1200x800网格地图
- 对战模式：个人混战（默认）、红蓝对抗（`matchConfig.teamMode`）或感染模式（`matchConfig.infectMode`，复用team字段：1=感染者/2=幸存者，随机一人感染、仅近战150血绿色、被杀转阵营、全灭感染胜/撑到时间幸存胜，`updateInfectMode`惰性分配）；分队模式下自动均衡分队、按队分色、分区出生（`teamZones`）、友军伤害豁免、机器人不打队友
- 可破坏地形：木箱(crate)被爆炸摧毁、油桶(barrel)被子弹/爆炸引爆连锁（`destroyTerrainInRadius`/`detonateBarrelByBullet`，`terrainRemove`/`terrainSync`走JSON广播），回合重置恢复地形
- 连杀系统：`registerKill`（含近战路径），`killstreak`/`streakEnd`消息JSON广播，客户端中央横幅
- 机甲空投：`mechTick`定时空投（`/mech`立即召唤），机甲复用武器索引5同步（WEAPONS.mech infinite），进入即`player.mech={hp:400}`、伤害由takeDamage装甲吸收、受弹半径2倍、G键发火箭；事件走JSON（heliDrop/mechSpawn/mechEnter/mechHp/mechDestroyed）
- 房主在大厅创建房间时选择地图/模式；服务器模式通过环境变量`MAP_ID`/`TEAM_MODE=1`指定
- 游戏内聊天命令：`/map 地图ID`、`/team on|off`（下一局生效）、`/bot N`
- 协议中玩家数据的`color`字符串后新增`team`字节(uint8)，改动编码时三个文件需同步

### 武器与弹药系统
- `WEAPONS`武器表定义在`server.js`/`host-core.js`（两份需一致），经`JOINED`消息的配置JSON下发给客户端：rifle步枪(默认,备弹无限)/smg冲锋枪/shotgun霰弹枪(6弹丸扇形,短射程用短life实现)/sniper狙击枪
- Player新增字段：`weapon/mag/reserve(-1=无限)/reloading/reloadEnd`；空仓自动换弹、备弹耗尽自动回步枪、复活重置步枪；`RELOAD`(=8)为客户端消息类型
- 协议：玩家增量更新bitmask新增`0x80`=武器状态（weapon uint8 + mag uint8 + reserve uint8(255=无限) + reloadRem uint16 ms + grenades uint8）；newPlayers/playerJoined/全量状态在team字节后追加同样5个字段；子弹（newBullets与全量）尾部追加kind uint8(0=子弹 1=火箭弹 2=手雷)，改动时三个文件需同步
- 爆炸系统：`explodeAt`范围伤害衰减（中心全额→边缘35%），不伤投掷者与队友；`explosion`消息走JSON广播{x,y,radius}；火箭弹撞墙/命中/超时爆炸，手雷（GRENADE=9消息，G键）飞抵落点或撞墙停驻后引信起爆
- 道具改为道具箱：`POWERUP_TYPES`新增weapon_smg/shotgun/sniper/rpg与grenade_pack（typeId 5-9），50%武器箱/50%增益箱，客户端渲染为2.5D悬浮箱、内容拾取时揭示
- 聊天命令`/weapon 武器ID`立即换枪；JOINED配置JSON含WEAPONS表（encodeJoined缓冲4096）

### 游戏状态管理
服务器维护全局游戏状态：
- `players` - 所有玩家信息（位置、生命值、分数等）
- `bullets` - 所有子弹对象
- `powerups` - 道具系统
- `terrain` - 地形障碍物

### 客户端组件
- **粒子系统** - `Particle`类处理视觉特效
- **特效系统** - `Effect`类管理爆炸、击中等效果
- **Canvas渲染** - 使用HTML5 Canvas进行2D渲染
- **输入处理** - 键盘（WASD移动）和鼠标（瞄准射击）控制

## 网络协议

客户端-服务器通过JSON消息通信，主要消息类型：
- `join` - 玩家加入游戏
- `move` - 玩家移动
- `shoot` - 玩家射击
- `respawn` - 玩家复活
- `gameState` - 服务器广播游戏状态更新

## 游戏配置

所有游戏参数在server.js中的`GAME_CONFIG`对象中配置：
- 画布尺寸：1200x800
- 玩家大小、速度、生命值
- 子弹大小、速度
- 复活时间等

## 本地开发

1. 确保端口38080未被占用
2. 运行`npm run dev`启动开发服务器
3. 浏览器访问`http://localhost:38080`
4. 支持多个浏览器标签页同时游戏测试

## 代码约定

- 游戏逻辑集中在服务器端确保游戏公平性
- 客户端主要负责渲染和用户交互
- 使用ES6+语法特性
- Canvas坐标系为标准2D坐标系
- 实时性要求高，避免阻塞操作