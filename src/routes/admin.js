const express = require('express');
const router = express.Router();
const dbStore = require('../store/db');
const sockets = require('../services/sockets');
const { requireAdmin } = require('../middleware/auth');

router.post('/settings', requireAdmin, (req, res) => {
    const { maxSimultaneousUploads, userSpeedLimitMB, maxFileSizeMB, allowedExtensions } = req.body || {};

    if (maxSimultaneousUploads !== undefined) {
        const v = parseInt(maxSimultaneousUploads);
        dbStore.db.settings.maxSimultaneousUploads = Number.isFinite(v) && v > 0 ? v : 1;
    }
    if (userSpeedLimitMB !== undefined) {
        const v = parseFloat(userSpeedLimitMB);
        dbStore.db.settings.userSpeedLimitMB = Number.isFinite(v) && v >= 0 ? v : 2;
    }
    if (maxFileSizeMB !== undefined) {
        const v = parseFloat(maxFileSizeMB);
        dbStore.db.settings.maxFileSizeMB = Number.isFinite(v) && v > 0 ? v : 100;
    }
    if (Array.isArray(allowedExtensions)) {
        dbStore.db.settings.allowedExtensions = allowedExtensions
            .map(s => String(s).trim().toLowerCase().replace(/^\./, ''))
            .filter(Boolean);
    }

    dbStore.saveData();
    sockets.broadcastState(req.app.get('wss'));
    res.json({ success: true });
});

router.post('/users/action', requireAdmin, (req, res) => {
    const { usernames, action } = req.body || {};
    if (!Array.isArray(usernames)) return res.status(400).json({ error: '参数错误' });

    usernames.forEach(name => {
        const target = dbStore.findUser(name);
        if (!target || target.role === 'admin') return;

        if (action === 'ban') {
            target.role = 'banned';
            if (!dbStore.db.bannedUsernames.includes(target.username)) {
                dbStore.db.bannedUsernames.push(target.username);
            }
        } else if (action === 'unban') {
            target.role = 'user';
            dbStore.db.bannedUsernames = dbStore.db.bannedUsernames.filter(u => u !== target.username);
        } else if (action === 'delete') {
            dbStore.db.bannedUsernames = dbStore.db.bannedUsernames.filter(u => u !== target.username);
            dbStore.db.users = dbStore.db.users.filter(u => u.username !== target.username);
        }
    });

    dbStore.saveData();
    sockets.broadcastState(req.app.get('wss'));
    res.json({ success: true });
});

// 上传总览
router.get('/uploads', requireAdmin, (req, res) => {
    const uploadsService = require('../services/uploads');
    res.json({
        success: true,
        uploads: uploadsService.list().map(u => ({
            id: u.id,
            username: u.username,
            fileName: u.fileName,
            size: u.size,
            uploaded: u.uploaded,
            speed: (u.speed / 1024 / 1024).toFixed(2) + ' MB/s',
            progress: u.size ? Math.min(100, (u.uploaded / u.size) * 100).toFixed(1) : 0
        }))
    });
});

module.exports = router;