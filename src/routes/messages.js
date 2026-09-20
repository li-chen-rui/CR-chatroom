const express = require('express');
const fsp = require('fs/promises');
const router = express.Router();
const dbStore = require('../store/db');
const sockets = require('../services/sockets');
const uploadsService = require('../services/uploads');
const { genMessageId } = require('../utils/id');
const config = require('../../config');
const { rateLimit } = require('../middleware/rateLimit');

// 限流：发消息 30 次 / 分钟 / 用户
const sendLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyFn: req => 'msg:' + (req.currentUser ? req.currentUser.username : req.ip),
    message: '发言过于频繁，请稍后再试'
});

/* ---------------- 时间工具 ---------------- */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function dayKey(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayKey() { return dayKey(Date.now()); }

function formatFull(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function dayStartMs(date) {
    // date 是 YYYY-MM-DD
    return new Date(date + 'T00:00:00').getTime();
}

/* ---------------- 二分查找 ---------------- */
/**
 * 消息数组按 timestampMs 升序，二分找第一个 >= target 的下标
 */
function lowerBound(arr, target) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((arr[mid].timestampMs || 0) < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * 取某天消息（升序），O(log N + K)
 */
function filterByDay(date) {
    const msgs = dbStore.db.messages;
    if (!msgs.length) return [];

    const start = dayStartMs(date);
    const end = start + 24 * 3600 * 1000;

    const s = lowerBound(msgs, start);
    const e = lowerBound(msgs, end);

    return msgs.slice(s, e);
}

/* ---------------- 天数列表缓存 ---------------- */
let daysCache = null;

function invalidateDaysCache() {
    daysCache = null;
}

/**
 * 有消息的日期降序（带缓存）
 */
function collectDaysDesc() {
    if (daysCache) return daysCache;

    const set = new Set();
    const msgs = dbStore.db.messages;
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m.timestampMs) set.add(dayKey(m.timestampMs));
    }
    daysCache = Array.from(set).sort().reverse();
    return daysCache;
}

/* ============================================================
   加载最新一天
   ============================================================ */
router.get('/latest-day', (req, res) => {
    try {
        const days = collectDaysDesc();
        if (days.length === 0) {
            return res.json({ success: true, date: null, messages: [], hasMore: false });
        }

        const today = todayKey();
        let target = null;
        for (const d of days) {
            if (d <= today) { target = d; break; }
        }
        if (!target) target = days[0];

        const list = filterByDay(target);
        const hasMore = days.some(d => d < target);

        res.json({ success: true, date: target, messages: list, hasMore });
    } catch (e) {
        console.error('[error] /latest-day 失败', e);
        res.status(500).json({ error: '加载失败' });
    }
});

/* ============================================================
   加载某天之前的一天
   ============================================================ */
router.get('/day-before', (req, res) => {
    try {
        const date = req.query.date;
        if (!date) return res.status(400).json({ error: '缺少 date 参数' });

        const days = collectDaysDesc();
        let target = null;
        for (const d of days) {
            if (d < date) { target = d; break; }
        }
        if (!target) {
            return res.json({ success: true, date: null, messages: [], hasMore: false });
        }

        const list = filterByDay(target);
        const hasMore = days.some(d => d < target);

        res.json({ success: true, date: target, messages: list, hasMore });
    } catch (e) {
        console.error('[error] /day-before 失败', e);
        res.status(500).json({ error: '加载失败' });
    }
});

/* ---------------- 兼容旧接口 ---------------- */
router.get('/days', (req, res) => {
    res.json({ success: true, days: collectDaysDesc() });
});

router.get('/by-day', (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: '缺少 date 参数' });
    res.json({ success: true, date, messages: filterByDay(date) });
});

/* ============================================================
   发送
   ============================================================ */
router.post('/send', sendLimiter, (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const { content, markdown } = req.body || {};
    if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: '发送内容不能为空' });
    if (content.length > config.MAX_MESSAGE_LEN) {
        return res.status(400).json({ error: `内容过长（最多 ${config.MAX_MESSAGE_LEN} 字）` });
    }

    const mdFlag = markdown === true || markdown === 'true' || markdown === 1 || markdown === '1';
    const now = Date.now();
    const msg = {
        id: genMessageId(),
        username: user.username,
        content: content.trim(),
        markdown: mdFlag,
        timestamp: formatFull(now),
        timestampMs: now,
        createdAt: new Date(now).toISOString(),
        edited: false,
        recalled: false
    };

    // 追加并保持排序（实际上新消息一定在末尾）
    dbStore.db.messages.push(msg);
    dbStore.saveMessageOf(msg);   // 只写当天文件
    invalidateDaysCache();         // 天数可能变化

    sockets.broadcastMessageNew(msg);
    res.json({ success: true, message: msg });
});

/* ============================================================
   编辑
   ============================================================ */
router.post('/edit', (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const { id, content, markdown } = req.body || {};
    if (!id || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: '参数错误' });
    }
    if (content.length > config.MAX_MESSAGE_LEN) {
        return res.status(400).json({ error: `内容过长（最多 ${config.MAX_MESSAGE_LEN} 字）` });
    }

    const msg = dbStore.db.messages.find(m => m.id === id);
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    if (msg.username !== user.username) {
        return res.status(403).json({ error: '只能编辑自己的消息' });
    }

    msg.content = content.trim();
    msg.markdown = markdown === true || markdown === 'true' || markdown === 1 || markdown === '1';
    msg.edited = true;

    dbStore.saveMessageOf(msg);
    sockets.broadcastMessageUpdate(msg);
    res.json({ success: true, message: msg });
});

/* ============================================================
   删除
   ============================================================ */
router.post('/delete', async (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const { ids } = req.body || {};
    if (!Array.isArray(ids)) return res.status(400).json({ error: '参数错误' });

    const idSet = new Set(ids);
    const removedFiles = [];
    const removedIds = [];
    const uploadsToCancel = [];
    const affectedDays = new Set();

    const before = dbStore.db.messages.length;
    dbStore.db.messages = dbStore.db.messages.filter(msg => {
        if (!idSet.has(msg.id)) return true;
        if (user.role === 'admin' || msg.username === user.username) {
            if (msg.filePath) removedFiles.push(msg.filePath);
            if (msg.uploadId) uploadsToCancel.push(msg.uploadId);
            if (msg.timestampMs) affectedDays.add(dayKey(msg.timestampMs));
            removedIds.push(msg.id);
            return false;
        }
        return true;
    });

    const changed = dbStore.db.messages.length !== before;

    uploadsToCancel.forEach(uid => uploadsService.cancelById(uid, true));
    removedFiles.forEach(fp => fsp.unlink(fp).catch(() => {}));

    if (changed) {
        // 只写受影响的天（可能是好几天）
        dbStore.saveMessagesOfDays(Array.from(affectedDays));
        invalidateDaysCache();
    }

    sockets.broadcastMessagesDeleted(removedIds);
    res.json({ success: true, removed: removedIds });
});

/* ============================================================
   管理员：按时间段+关键字查询
   ============================================================ */
router.post('/admin/query-range', (req, res) => {
    const user = req.currentUser;
    if (!user || user.role !== 'admin') return res.status(403).json({ error: '权限不足' });

    const { mode, before, after, from, to, keyword } = req.body || {};

    // 先按时间范围二分
    const msgs = dbStore.db.messages;
    let s = 0, e = msgs.length;

    if (mode === 'before' && Number.isFinite(before)) {
        s = 0; e = lowerBound(msgs, before);
    } else if (mode === 'after' && Number.isFinite(after)) {
        s = lowerBound(msgs, after + 1); e = msgs.length;
    } else if (mode === 'range' && Number.isFinite(from) && Number.isFinite(to)) {
        s = lowerBound(msgs, from);
        e = lowerBound(msgs, to + 1);
    } else {
        return res.status(400).json({ error: '时间段参数不合法' });
    }

    let list = msgs.slice(s, e);

    if (keyword) {
        const kw = String(keyword).toLowerCase();
        list = list.filter(m =>
            (m.content && m.content.toLowerCase().indexOf(kw) >= 0) ||
            (m.username && m.username.toLowerCase().indexOf(kw) >= 0) ||
            (m.fileName && m.fileName.toLowerCase().indexOf(kw) >= 0)
        );
    }

    const preview = list.slice(-200);
    res.json({ success: true, count: list.length, messages: preview });
});

/* ============================================================
   管理员：按时间段+关键字删除
   ============================================================ */
router.post('/admin/delete-range', async (req, res) => {
    const user = req.currentUser;
    if (!user || user.role !== 'admin') return res.status(403).json({ error: '权限不足' });

    const { mode, before, after, from, to, keyword } = req.body || {};
    const msgs = dbStore.db.messages;

    let s = 0, e = msgs.length;
    if (mode === 'before' && Number.isFinite(before)) {
        s = 0; e = lowerBound(msgs, before);
    } else if (mode === 'after' && Number.isFinite(after)) {
        s = lowerBound(msgs, after + 1); e = msgs.length;
    } else if (mode === 'range' && Number.isFinite(from) && Number.isFinite(to)) {
        s = lowerBound(msgs, from);
        e = lowerBound(msgs, to + 1);
    } else {
        return res.status(400).json({ error: '时间段参数不合法' });
    }

    let list = msgs.slice(s, e);

    if (keyword) {
        const kw = String(keyword).toLowerCase();
        list = list.filter(m =>
            (m.content && m.content.toLowerCase().indexOf(kw) >= 0) ||
            (m.username && m.username.toLowerCase().indexOf(kw) >= 0) ||
            (m.fileName && m.fileName.toLowerCase().indexOf(kw) >= 0)
        );
    }

    const removedIds = [];
    const removedFiles = [];
    const uploadsToCancel = [];
    const affectedDays = new Set();

    list.forEach(msg => {
        if (msg.filePath) removedFiles.push(msg.filePath);
        if (msg.uploadId) uploadsToCancel.push(msg.uploadId);
        if (msg.timestampMs) affectedDays.add(dayKey(msg.timestampMs));
        removedIds.push(msg.id);
    });

    const idSet = new Set(removedIds);
    dbStore.db.messages = dbStore.db.messages.filter(m => !idSet.has(m.id));

    uploadsToCancel.forEach(uid => uploadsService.cancelById(uid, true));
    removedFiles.forEach(fp => fsp.unlink(fp).catch(() => {}));

    dbStore.saveMessagesOfDays(Array.from(affectedDays));
    invalidateDaysCache();

    sockets.broadcastMessagesDeleted(removedIds);
    res.json({ success: true, removed: removedIds.length });
});

module.exports = router;