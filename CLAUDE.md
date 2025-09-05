# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个基于WebSocket的多人局域网2D俯视角射击游戏。项目结构简单，采用纯前端JavaScript + Node.js WebSocket服务器的架构。

## 开发命令

- `npm start` - 启动生产服务器
- `npm run dev` - 启动开发服务器（使用nodemon自动重启）
- `npm install` - 安装依赖包

## 项目架构

### 核心文件
- `server.js` - WebSocket服务器，处理游戏逻辑、玩家连接和实时通信
- `game.js` - 客户端游戏逻辑，包含粒子系统、特效、渲染和输入处理
- `index.html` - 游戏主页面，包含完整的用户界面和样式

### 架构模式
- **客户端-服务器架构**：服务器管理游戏状态，客户端负责渲染和输入
- **实时通信**：通过WebSocket进行双向通信
- **游戏循环**：服务器端60FPS游戏循环，客户端渲染循环

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