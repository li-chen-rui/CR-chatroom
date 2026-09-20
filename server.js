const express = require('express');
const http = require('http');
const config = require('./config');
const dbStore = require('./src/store/db');
const sessionMiddleware = require('./src/middleware/session');
const { authMiddleware } = require('./src/middleware/auth');
const { securityHeaders, csrfCheck } = require('./src/middleware/security');
const { setupWebSocket } = require('./src/ws');

const pagesRouter = require('./src/routes/pages');
const authRouter = require('./src/routes/auth');
const messagesRouter = require('./src/routes/messages');
const uploadsRouter = require('./src/routes/uploads');
const adminRouter = require('./src/routes/admin');

const app = express();
const server = http.createServer(app);

// 信任反向代理（如需正确取 req.ip）；无代理部署时无副作用。
app.set('trust proxy', 'loopback');

app.use(securityHeaders);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);
app.use(authMiddleware);
app.use(csrfCheck);

// 页面
app.use('/', pagesRouter);

// 静态资源：带缓存头（CSS/JS/图片 1 小时，HTML 不缓存）
app.use(express.static(config.PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res, filePath) {
        const ext = (require('path').extname(filePath) || '').toLowerCase();
        if (['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.map'].includes(ext)) {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        } else {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

// 上传文件：强制下载，防止上传 HTML/SVG 导致同源存储型 XSS
app.use('/files', (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    next();
}, express.static(uploadsRouter.getUploadDir(), {
    dotfiles: 'deny',
    index: false
}));

// API
app.use('/api', authRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/upload', uploadsRouter);
app.use('/api/admin', adminRouter);

// 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
});

// 统一错误处理
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
    }
    console.error('[error] 未捕获异常', err && err.message);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: '服务器内部错误' });
});

// WS
const wss = setupWebSocket(server, sessionMiddleware);
app.set('wss', wss);

server.listen(config.PORT, config.HOST, () => {
    console.log(`========================================`);
    console.log(`CR-chatroom 服务器已启动: http://localhost:${config.PORT}`);
    console.log(`  登录:   http://localhost:${config.PORT}/login`);
    console.log(`  注册:   http://localhost:${config.PORT}/register`);
    console.log(`  聊天室: http://localhost:${config.PORT}/chatroom`);
    console.log(`  管理页: http://localhost:${config.PORT}/admin`);
    console.log(`========================================`);
});

process.on('SIGINT', async () => {
    await dbStore.flush();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('[error] uncaughtException', err && err.message);
});
