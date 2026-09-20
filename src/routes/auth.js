const express = require('express');
const router = express.Router();
const dbStore = require('../store/db');
const config = require('../../config');
const { hashPassword, verifyPassword, isHashed } = require('../utils/crypto');
const { readInviteCodes } = require('../utils/file');
const sockets = require('../services/sockets');
const { rateLimit } = require('../middleware/rateLimit');

// 限流：登录 15 次 / 10 分钟 / IP；注册 5 次 / 10 分钟 / IP
const loginLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 15, message: '登录尝试过于频繁，请稍后再试' });
const registerLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, message: '注册尝试过于频繁，请稍后再试' });

// 用户名校验：字母/数字/下划线/连字符/中文，长度 1-32
function isValidUsername(name) {
    if (typeof name !== 'string') return false;
    if (!name || name.length > config.MAX_USERNAME_LEN) return false;
    return /^[\w\u4e00-\u9fa5-]{1,32}$/.test(name);
}

function normalizeUsername(name) {
    return String(name || '').trim();
}

// 注册
router.post('/register', registerLimiter, (req, res) => {
    const { username: rawUsername, password, inviteCode } = req.body || {};
    const username = normalizeUsername(rawUsername);

    if (!isValidUsername(username)) {
        return res.status(400).json({ error: '账号仅支持 1-32 位的字母、数字、下划线、连字符或中文' });
    }
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: '账号和密码不能为空！' });
    }
    if (password.length < config.MIN_PASSWORD_LEN) {
        return res.status(400).json({ error: `密码至少 ${config.MIN_PASSWORD_LEN} 位！` });
    }
    if (password.length > 128) {
        return res.status(400).json({ error: '密码过长！' });
    }

    const codes = readInviteCodes();
    if (typeof inviteCode !== 'string' || !inviteCode.trim() || !codes.includes(inviteCode.trim())) {
        return res.status(400).json({ error: '邀请码错误！' });
    }
    if (dbStore.findUser(username)) return res.status(400).json({ error: '用户名已存在！' });

    const role = dbStore.db.users.length === 0 ? 'admin' : 'user';
    const newUser = { username, password: hashPassword(password), role };
    dbStore.db.users.push(newUser);
    dbStore.saveData();

    req.session.regenerate(err => {
        if (err) {
            req.session.username = username;
        } else {
            req.session.username = username;
        }
        res.json({ success: true, user: { username, role } });
        sockets.broadcastState(req.app.get('wss'));
    });
});

// 登录
router.post('/login', loginLimiter, (req, res) => {
    const { username: rawUsername, password } = req.body || {};
    const username = normalizeUsername(rawUsername);

    if (!username || !password || typeof password !== 'string') {
        return res.status(400).json({ error: '账号和密码不能为空！' });
    }
    if (username.length > config.MAX_USERNAME_LEN) {
        return res.status(400).json({ error: '账号或密码错误！' });
    }

    const user = dbStore.findUser(username);
    if (!user || !verifyPassword(password, user.password)) {
        return res.status(400).json({ error: '账号或密码错误！' });
    }
    if (dbStore.isBanned(user)) {
        return res.status(403).json({ error: '该账号已被封禁！' });
    }

    // 旧明文升级
    if (!isHashed(user.password)) {
        user.password = hashPassword(password);
        dbStore.saveData();
    }

    req.session.regenerate(err => {
        if (err) {
            // 兜底：regenerate 失败仍尝试直接赋值
            req.session.username = username;
        } else {
            req.session.username = username;
        }
        res.json({ success: true, user: { username, role: user.role } });
        sockets.broadcastState(req.app.get('wss'));
    });
});

// 当前用户
router.get('/me', (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录或已封禁' });
    res.json({ username: user.username, role: user.role });
});

// 登出
router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

module.exports = router;
