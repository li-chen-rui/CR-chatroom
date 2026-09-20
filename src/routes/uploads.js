const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const router = express.Router();
const dbStore = require('../store/db');
const sockets = require('../services/sockets');
const uploadsService = require('../services/uploads');
const ThrottleStream = require('../streams/ThrottleStream');
const { genUploadId, genMessageId } = require('../utils/id');
const { sanitizeFileName, isExtensionAllowed, resolveUploadDir } = require('../utils/file');

const UPLOAD_DIR = resolveUploadDir();
const CHUNK_TMP_DIR = path.join(UPLOAD_DIR, '.chunks');
if (!fs.existsSync(CHUNK_TMP_DIR)) fs.mkdirSync(CHUNK_TMP_DIR, { recursive: true });

const chunkSessions = new Map();
function getUploadDir() { return UPLOAD_DIR; }

function formatFull(ms) {
    const d = new Date(ms);
    const p = n => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ============================================================
   整体流式上传
   ============================================================ */
router.post('/', (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const settings = dbStore.db.settings;

    if (user.role !== 'admin'
        && uploadsService.countByUser(user.username) >= settings.maxSimultaneousUploads) {
        return res.status(400).json({
            error: `同时上传数超限！最大允许 ${settings.maxSimultaneousUploads} 个任务`
        });
    }

    const uploadId = genUploadId();
    const fileName = sanitizeFileName(req.headers['x-file-name']);

    if (user.role !== 'admin' && !isExtensionAllowed(fileName, settings.allowedExtensions)) {
        const ext = path.extname(fileName).toLowerCase() || '(无)';
        return res.status(400).json({ error: `不支持的文件类型：${ext}` });
    }

    const declaredSize = parseInt(req.headers['content-length'] || '0', 10);
    const maxBytes = settings.maxFileSizeMB * 1024 * 1024;

    if (user.role !== 'admin' && Number.isFinite(declaredSize) && declaredSize > maxBytes) {
        return res.status(400).json({ error: `普通用户单个文件限制最大 ${settings.maxFileSizeMB} MB！` });
    }

    const saveFilePath = path.join(UPLOAD_DIR, `${Date.now()}_${fileName}`);
    const now = Date.now();

    const placeholderMsg = {
        id: genMessageId(),
        username: user.username,
        content: `正在上传: ${fileName}`,
        fileName,
        filePath: saveFilePath,
        fileUrl: '',
        fileSize: declaredSize ? (declaredSize / 1024 / 1024).toFixed(2) + ' MB' : '',
        timestamp: formatFull(now),
        timestampMs: now,
        createdAt: new Date(now).toISOString(),
        edited: false,
        recalled: false,
        uploadId,
        uploading: true
    };
    dbStore.db.messages.push(placeholderMsg);
    dbStore.db.messages.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    dbStore.saveMessageOf(placeholderMsg);

    const task = {
        id: uploadId,
        username: user.username,
        fileName,
        size: declaredSize,
        uploaded: 0,
        speed: 0,
        filePath: saveFilePath,
        messageId: placeholderMsg.id,
        req,
        aborted: false
    };
    uploadsService.add(task);

    sockets.broadcastMessageNew(placeholderMsg);
    uploadsService.broadcast();

    let writeStream;
    try {
        writeStream = fs.createWriteStream(saveFilePath);
    } catch (e) {
        console.error('[error] 创建写流失败', e.message);
        uploadsService.cancelById(uploadId, true);
        return res.status(500).json({ error: '无法创建文件' });
    }

    let pipeTarget = req;
    if (user.role !== 'admin' && settings.userSpeedLimitMB > 0) {
        const throttle = new ThrottleStream(settings.userSpeedLimitMB * 1024 * 1024);
        req.pipe(throttle);
        pipeTarget = throttle;
    }

    let sizeExceeded = false;
    let speedBaseTime = 0;
    let speedBaseUploaded = 0;

    req.on('data', (chunk) => {
        task.uploaded += chunk.length;

        if (user.role !== 'admin' && task.uploaded > maxBytes) {
            sizeExceeded = true;
            uploadsService.cancelById(uploadId, true);
            if (!res.headersSent) {
                res.status(400).json({ error: `文件超过 ${settings.maxFileSizeMB} MB 限制，已中断` });
            }
            return;
        }

        const t = Date.now();
        if (speedBaseTime === 0) {
            speedBaseTime = t;
            speedBaseUploaded = task.uploaded;
        }
        if (t - speedBaseTime >= 500) {
            const dt = (t - speedBaseTime) / 1000;
            const dBytes = task.uploaded - speedBaseUploaded;
            task.speed = dt > 0 ? dBytes / dt : 0;
            speedBaseTime = t;
            speedBaseUploaded = task.uploaded;

            const progress = task.size ? Math.min(100, (task.uploaded / task.size) * 100) : 0;
            sockets.broadcastUploadProgress(uploadId, {
                uploaded: task.uploaded,
                size: task.size,
                speed: task.speed,
                progress: Number(progress.toFixed(2))
            });
        }
    });

    pipeTarget.pipe(writeStream);

    req.on('aborted', () => {
        task.aborted = true;
        uploadsService.cancelById(uploadId, true);
    });

    writeStream.on('finish', () => {
        if (sizeExceeded || task.aborted) {
            fsp.unlink(saveFilePath).catch(() => {});
            return;
        }
        uploadsService.remove(uploadId);

        const msg = dbStore.db.messages.find(m => m.id === placeholderMsg.id);
        if (msg) {
            msg.content = `分享了文件: ${fileName}`;
            msg.fileUrl = `/files/${path.basename(saveFilePath)}`;
            msg.fileSize = ((task.uploaded || declaredSize) / 1024 / 1024).toFixed(2) + ' MB';
            msg.uploading = false;
        }
        dbStore.saveMessageOf(msg);
        sockets.broadcastMessageUpdate(msg);
        uploadsService.broadcast();

        if (!res.headersSent) res.json({ success: true, message: msg });
    });

    writeStream.on('error', (err) => {
        console.error('[error] 写入失败', err.message);
        uploadsService.cancelById(uploadId, true);
        if (!res.headersSent) res.status(500).json({ error: '上传中断或错误' });
    });
});

/* ============================================================
   取消上传
   ============================================================ */
router.post('/cancel', (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const { uploadIds } = req.body || {};
    if (!Array.isArray(uploadIds)) return res.status(400).json({ error: '参数错误' });

    uploadIds.forEach(id => {
        const task = uploadsService.get(id);
        if (task && (user.role === 'admin' || task.username === user.username)) {
            uploadsService.cancelById(id, true);
        }
        const sess = chunkSessions.get(id);
        if (sess && (user.role === 'admin' || sess.username === user.username)) {
            cleanupChunkSession(id, true);
        }
    });
    res.json({ success: true });
});

/* ============================================================
   分片续传：初始化
   ============================================================ */
router.post('/init', (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const settings = dbStore.db.settings;
    const { fileName: rawName, size, chunkSize } = req.body || {};

    const fileName = sanitizeFileName(rawName);
    const fileSize = parseInt(size, 10);
    const cSize = parseInt(chunkSize, 10) || 2 * 1024 * 1024;

    if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0) {
        return res.status(400).json({ error: '参数错误' });
    }
    if (user.role !== 'admin' && fileSize > settings.maxFileSizeMB * 1024 * 1024) {
        return res.status(400).json({ error: `普通用户单个文件限制最大 ${settings.maxFileSizeMB} MB！` });
    }
    if (user.role !== 'admin' && !isExtensionAllowed(fileName, settings.allowedExtensions)) {
        const ext = path.extname(fileName).toLowerCase() || '(无)';
        return res.status(400).json({ error: `不支持的文件类型：${ext}` });
    }

    const totalChunks = Math.max(1, Math.ceil(fileSize / cSize));

    // 查找可复用会话（同名同大小同分片数，且还没完成）
    let uploadId = null;
    for (const [id, sess] of chunkSessions.entries()) {
        if (sess.username === user.username
            && sess.fileName === fileName
            && sess.size === fileSize
            && sess.totalChunks === totalChunks) {
            uploadId = id;
            break;
        }
    }

    let sess;
    let isNew = false;

    if (!uploadId) {
        isNew = true;
        uploadId = genUploadId();
        const dir = path.join(CHUNK_TMP_DIR, uploadId);
        fs.mkdirSync(dir, { recursive: true });

        const now = Date.now();
        const placeholderMsg = {
            id: genMessageId(),
            username: user.username,
            content: `正在上传: ${fileName}`,
            fileName,
            filePath: null,
            fileUrl: '',
            fileSize: (fileSize / 1024 / 1024).toFixed(2) + ' MB',
            timestamp: formatFull(now),
            timestampMs: now,
            createdAt: new Date(now).toISOString(),
            edited: false,
            recalled: false,
            uploadId,
            uploading: true
        };
        dbStore.db.messages.push(placeholderMsg);
        dbStore.db.messages.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
        dbStore.saveMessageOf(placeholderMsg);

        sess = {
            id: uploadId,
            username: user.username,
            fileName,
            size: fileSize,
            chunkSize: cSize,
            totalChunks,
            received: new Set(),
            dir,
            createdAt: Date.now(),
            messageId: placeholderMsg.id
        };
        chunkSessions.set(uploadId, sess);

        sockets.broadcastMessageNew(placeholderMsg);
    } else {
        sess = chunkSessions.get(uploadId);
    }

    // 无论新建还是复用，都确保 uploads 服务里有这个 task，并广播
    let task = uploadsService.get(uploadId);
    if (!task) {
        // 计算已上传字节
        let uploadedBytes = 0;
        for (const i of sess.received) {
            try {
                const st = fs.statSync(path.join(sess.dir, `${i}.part`));
                uploadedBytes += st.size;
            } catch (e) {}
        }
        task = {
            id: uploadId,
            username: user.username,
            fileName: sess.fileName,
            size: sess.size,
            uploaded: uploadedBytes,
            speed: 0,
            filePath: null,
            messageId: sess.messageId || null,
            req: null,
            aborted: false,
            chunkMode: true
        };
        uploadsService.add(task);
    }
    uploadsService.broadcast();

    res.json({
        success: true,
        uploadId,
        totalChunks,
        chunkSize: cSize,
        received: Array.from(sess.received),
        isNew
    });
});

/* ============================================================
   分片续传：接收单个分片（流式接收，边收边广播）
   ============================================================ */
router.post('/chunk', (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const uploadId = req.headers['x-upload-id'];
    const index = parseInt(req.headers['x-chunk-index'], 10);

    const sess = chunkSessions.get(uploadId);
    if (!sess) return res.status(404).json({ error: '上传会话不存在或已过期' });
    if (sess.username !== user.username && user.role !== 'admin') {
        return res.status(403).json({ error: '无权操作此上传' });
    }
    if (!Number.isFinite(index) || index < 0 || index >= sess.totalChunks) {
        return res.status(400).json({ error: '分片序号非法' });
    }
    if (sess.received.has(index)) {
        return res.json({ success: true, index, duplicated: true });
    }

    const task = uploadsService.get(uploadId);
    const chunkPath = path.join(sess.dir, `${index}.part`);
    const writeStream = fs.createWriteStream(chunkPath);

    // 单分片大小上限：不得超过声明 chunkSize 的 2 倍，防止恶意超大分片撑爆磁盘
    const MAX_CHUNK_BYTES = Math.max(sess.chunkSize, 4 * 1024 * 1024) * 2;

    // 已完成的其它分片总字节（用于合并进度）
    let baseUploaded = 0;
    for (const i of sess.received) {
        try {
            const st = fs.statSync(path.join(sess.dir, `${i}.part`));
            baseUploaded += st.size;
        } catch (e) {}
    }

    let chunkReceived = 0;
    let lastBroadcast = Date.now();
    let aborted = false;

    req.on('data', (chunk) => {
        if (aborted) return;
        chunkReceived += chunk.length;

        if (chunkReceived > MAX_CHUNK_BYTES) {
            aborted = true;
            try { writeStream.destroy(); } catch (e) {}
            try { fsp.unlink(chunkPath).catch(() => {}); } catch (e) {}
            if (!res.headersSent) res.status(413).json({ error: '分片过大' });
            return;
        }

        const now = Date.now();
        if (now - lastBroadcast >= 200) {
            lastBroadcast = now;
            const totalUploaded = baseUploaded + chunkReceived;
            if (task) task.uploaded = totalUploaded;
            const progress = sess.size ? Math.min(100, (totalUploaded / sess.size) * 100) : 0;
            sockets.broadcastUploadProgress(uploadId, {
                uploaded: totalUploaded,
                size: sess.size,
                speed: 0,
                progress: Number(progress.toFixed(2))
            });
        }
    });

    req.pipe(writeStream);

    req.on('end', () => {
        if (aborted) return;

        sess.received.add(index);

        // 汇总已上传字节
        let uploaded = 0;
        for (const i of sess.received) {
            try {
                const st = fs.statSync(path.join(sess.dir, `${i}.part`));
                uploaded += st.size;
            } catch (e) {}
        }
        if (task) task.uploaded = uploaded;

        const progress = sess.size ? Math.min(100, (uploaded / sess.size) * 100) : 0;
        sockets.broadcastUploadProgress(uploadId, {
            uploaded,
            size: sess.size,
            speed: 0,
            progress: Number(progress.toFixed(2))
        });

        if (!res.headersSent) {
            res.json({ success: true, index, received: sess.received.size, total: sess.totalChunks });
        }
    });

    req.on('error', () => {
        aborted = true;
        try { writeStream.destroy(); } catch (e) {}
        try { fsp.unlink(chunkPath).catch(() => {}); } catch (e) {}
        if (!res.headersSent) res.status(500).json({ error: '分片接收失败' });
    });

    writeStream.on('error', () => {
        aborted = true;
        try { fsp.unlink(chunkPath).catch(() => {}); } catch (e) {}
        if (!res.headersSent) res.status(500).json({ error: '分片写入失败' });
    });
});

/* ============================================================
   分片续传：完成合并
   ============================================================ */
router.post('/complete', async (req, res) => {
    const user = req.currentUser;
    if (!user) return res.status(401).json({ error: '未登录' });

    const { uploadId } = req.body || {};
    const sess = chunkSessions.get(uploadId);
    if (!sess) return res.status(404).json({ error: '上传会话不存在' });
    if (sess.username !== user.username && user.role !== 'admin') {
        return res.status(403).json({ error: '无权操作此上传' });
    }
    if (sess.received.size !== sess.totalChunks) {
        return res.status(400).json({
            error: `分片不完整：${sess.received.size}/${sess.totalChunks}`
        });
    }

    const saveFilePath = path.join(UPLOAD_DIR, `${Date.now()}_${sess.fileName}`);

    try {
        const writeStream = fs.createWriteStream(saveFilePath);
        for (let i = 0; i < sess.totalChunks; i++) {
            const chunkPath = path.join(sess.dir, `${i}.part`);
            const buf = await fsp.readFile(chunkPath);
            await new Promise((resolve, reject) => {
                writeStream.write(buf, err => err ? reject(err) : resolve());
            });
        }
        await new Promise((resolve, reject) => {
            writeStream.end(err => err ? reject(err) : resolve());
        });
    } catch (e) {
        console.error('[error] 合并分片失败', e.message);
        return res.status(500).json({ error: '合并分片失败' });
    }

    await fsp.rm(sess.dir, { recursive: true, force: true }).catch(() => {});
    chunkSessions.delete(uploadId);

    const task = uploadsService.get(uploadId);
    const messageId = task ? task.messageId : null;
    uploadsService.remove(uploadId);

    let msg = null;
    if (messageId) {
        msg = dbStore.db.messages.find(m => m.id === messageId);
    }
    if (!msg) {
        const now = Date.now();
        msg = {
            id: genMessageId(),
            username: user.username,
            content: `分享了文件: ${sess.fileName}`,
            fileName: sess.fileName,
            filePath: saveFilePath,
            fileUrl: `/files/${path.basename(saveFilePath)}`,
            fileSize: (sess.size / 1024 / 1024).toFixed(2) + ' MB',
            timestamp: formatFull(now),
            timestampMs: now,
            createdAt: new Date(now).toISOString(),
            edited: false,
            recalled: false,
            uploading: false
        };
        dbStore.db.messages.push(msg);
        dbStore.db.messages.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
        dbStore.saveMessageOf(msg);
        sockets.broadcastMessageNew(msg);
    } else {
        msg.content = `分享了文件: ${sess.fileName}`;
        msg.filePath = saveFilePath;
        msg.fileUrl = `/files/${path.basename(saveFilePath)}`;
        msg.fileSize = (sess.size / 1024 / 1024).toFixed(2) + ' MB';
        msg.uploading = false;
        dbStore.saveMessageOf(msg);
        sockets.broadcastMessageUpdate(msg);
    }

    uploadsService.broadcast();
    res.json({ success: true, message: msg });
});

/* ============================================================
   辅助
   ============================================================ */
function cleanupChunkSession(uploadId, removeFiles = true) {
    const sess = chunkSessions.get(uploadId);
    if (!sess) return;
    if (removeFiles) {
        fsp.rm(sess.dir, { recursive: true, force: true }).catch(() => {});
    }
    chunkSessions.delete(uploadId);
    uploadsService.remove(uploadId);
}

module.exports = router;
module.exports.getUploadDir = getUploadDir;