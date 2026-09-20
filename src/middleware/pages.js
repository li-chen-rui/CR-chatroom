const path = require('path');
const express = require('express');
const config = require('../../config');

const router = express.Router();

// 判断登录态
function getSessionUser(req) {
    const username = req.session ? req.session.username : null;
    return username || null;
}

// 根路径：按登录态重定向
router.get('/', (req, res) => {
    if (getSessionUser(req)) return res.redirect('/chatroom');
    return res.redirect('/login');
});

// 登录页：已登录则跳聊天室
router.get('/login', (req, res) => {
    if (getSessionUser(req)) return res.redirect('/chatroom');
    res.sendFile(path.join(config.PUBLIC_DIR, 'login.html'));
});

// 注册页：已登录则跳聊天室
router.get('/register', (req, res) => {
    if (getSessionUser(req)) return res.redirect('/chatroom');
    res.sendFile(path.join(config.PUBLIC_DIR, 'register.html'));
});

// 聊天室：未登录则跳登录页
router.get('/chatroom', (req, res) => {
    if (!getSessionUser(req)) return res.redirect('/login');
    res.sendFile(path.join(config.PUBLIC_DIR, 'chatroom.html'));
});

module.exports = router;