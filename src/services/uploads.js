const activeUploads = new Map();
let broadcastUploadStateFn = () => {};

function setUploadBroadcaster(fn) { broadcastUploadStateFn = fn; }

function add(task) { activeUploads.set(task.id, task); }
function get(id) { return activeUploads.get(id); }
function remove(id) { activeUploads.delete(id); }
function list() { return Array.from(activeUploads.values()); }
function countByUser(username) { return list().filter(u => u.username === username).length; }

function cancelById(uploadId, removeFiles = true) {
    const task = activeUploads.get(uploadId);
    if (task) {
        try { task.req && task.req.destroy(); } catch (e) {}
        if (removeFiles && task.filePath) {
            require('fs/promises').unlink(task.filePath).catch(() => {});
        }
        activeUploads.delete(uploadId);
    }
    // 移除关联消息并广播
    const dbStore = require('../store/db');
    const sockets = require('./sockets');
    const before = dbStore.db.messages.length;
    const removedIds = [];
    dbStore.db.messages = dbStore.db.messages.filter(m => {
        if (m.uploadId === uploadId) { removedIds.push(m.id); return false; }
        return true;
    });
    if (dbStore.db.messages.length !== before) {
        dbStore.saveData();
        sockets.broadcastMessagesDeleted(removedIds);
    }
    // 关键：广播 upload_update，让 admin 端刷新列表
    broadcast();
}

function buildPayload() {
    const uploadList = list().map(u => ({
        id: u.id,
        username: u.username,
        fileName: u.fileName,
        size: u.size,
        uploaded: u.uploaded,
        speed: (u.speed / 1024 / 1024).toFixed(2) + ' MB/s',
        progress: u.size ? Math.min(100, (u.uploaded / u.size) * 100).toFixed(1) : 0,
        messageId: u.messageId || null
    }));
    return JSON.stringify({ type: 'upload_update', uploads: uploadList });
}

function broadcast() { broadcastUploadStateFn(buildPayload()); }

module.exports = {
    setUploadBroadcaster,
    add, get, remove, list, countByUser,
    cancelById,
    buildPayload, broadcast
};