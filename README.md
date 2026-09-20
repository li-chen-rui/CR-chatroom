# CR-chatroom

一个支持 Markdown 与 LaTeX 的实时聊天室，基于 Express + WebSocket。

## 功能

- 🔐 邀请码注册、Session 登录、管理员封禁
- 💬 实时聊天（WebSocket 长连接）
- 📝 Markdown 渲染 + KaTeX 数学公式（含 mhchem 化学公式）
- 📁 文件上传（整体流式 + 分片续传）
- 📅 按天加载历史消息，支持"加载前一天"
- 👥 用户列表、上传进程管理、聊天管理（管理员）
- 🎨 Fluent / Mica 主题，浅色 / 深色切换
- 📱 响应式布局

## 快速开始

### 环境要求

- Node.js ≥ 16
- npm 或 yarn

### 安装

```bash
git clone https://github.com/<your-name>/cr-chatroom.git
cd cr-chatroom
npm install