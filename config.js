const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 会话密钥：优先环境变量，否则读取/生成本地随机密钥（不再硬编码）。
function resolveSessionSecret() {
    if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
    const secretFile = path.join(__dirname, 'data', '.session-secret');
    try {
        if (fs.existsSync(secretFile)) {
            const s = fs.readFileSync(secretFile, 'utf8').trim();
            if (s.length >= 32) return s;
        }
        const fresh = crypto.randomBytes(48).toString('hex');
        fs.mkdirSync(path.dirname(secretFile), { recursive: true });
        fs.writeFileSync(secretFile, fresh, { mode: 0o600 });
        return fresh;
    } catch (e) {
        return crypto.randomBytes(48).toString('hex');
    }
}

module.exports = {
    PORT: 8080,
    HOST: '0.0.0.0',

    ROOT_DIR: __dirname,
    PUBLIC_DIR: path.join(__dirname, 'public'),

    // ===== 新数据结构 =====
    DATA_DIR: path.join(__dirname, 'data'),
    USER_FILE: path.join(__dirname, 'data', 'user.json'),
    MESSAGE_DIR: path.join(__dirname, 'data', 'message'),

    // ===== 旧数据（用于自动迁移） =====
    LEGACY_DATA_FILE: path.join(__dirname, 'data.json'),

    // ===== 其他配置 =====
    PASSWORD_FILE: path.join(__dirname, 'password.txt'),
    PATH_FILE: path.join(__dirname, 'path.txt'),
    DEFAULT_UPLOAD_DIR: path.join(__dirname, 'uploads'),

    SESSION_SECRET: resolveSessionSecret(),
    SESSION_MAX_AGE: 30 * 24 * 3600 * 1000,

    // 输入长度限制（防止超大消息导致存储/渲染 DoS）
    MAX_USERNAME_LEN: 32,
    MAX_MESSAGE_LEN: 10000,
    MIN_PASSWORD_LEN: 6,

    HEARTBEAT_INTERVAL: 30 * 1000,
    SAVE_DEBOUNCE_MS: 300,

    DEFAULT_SETTINGS: {
        maxSimultaneousUploads: 1,
        userSpeedLimitMB: 2,
        maxFileSizeMB: 100,
        allowedExtensions: []
    },

    PAGES: {
        LOGIN: '/login',
        REGISTER: '/register',
        CHATROOM: '/chatroom'
    }
};
