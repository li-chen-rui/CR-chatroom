const express = require('express');
const path = require('path');
const config = require('../../config');

const router = express.Router();

router.get('/login', (req, res) => {
    res.sendFile(path.join(config.PUBLIC_DIR, 'login.html'));
});

router.get('/register', (req, res) => {
    res.sendFile(path.join(config.PUBLIC_DIR, 'register.html'));
});

router.get('/chatroom', (req, res) => {
    res.sendFile(path.join(config.PUBLIC_DIR, 'chatroom.html'));
});

// 管理员页：需登录 + admin
router.get('/admin', (req, res) => {
    const user = req.currentUser;
    if (!user || user.role !== 'admin') {
        return res.redirect('/chatroom');
    }
    res.sendFile(path.join(config.PUBLIC_DIR, 'admin.html'));
});

module.exports = router;