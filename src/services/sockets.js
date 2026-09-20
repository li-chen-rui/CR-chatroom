const WebSocket = require('ws');
const dbStore = require('../store/db');
const uploadsService = require('./uploads');

const activeSockets = new Map();

function addSocket(username, ws) {
    if (!activeSockets.has(username)) activeSockets.set(username, new Set());
    activeSockets.get(username).add(ws);
}
function removeSocket(username, ws) {
    if (!activeSockets.has(username)) return;
    const set = activeSockets.get(username);
    set.delete(ws);
    if (set.size === 0) activeSockets.delete(username);
}
function isOnline(username) {
    return activeSockets.has(username) && activeSockets.get(username).size > 0;
}
function buildSafeUsers() {
    return dbStore.db.users.map(u => ({
        username: u.username,
        role: u.role,
        isOnline: isOnline(u.username)
    }));
}
function buildStatePayload() {
    return JSON.stringify({
        type: 'state_update',
        users: buildSafeUsers(),
        settings: dbStore.db.settings
    });
}
function broadcastState(wss) {
    const payload = buildStatePayload();
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
}
function broadcastMessageNew(msg) { broadcastAll({ type: 'message_new', message: msg }); }
function broadcastMessageUpdate(msg) { broadcastAll({ type: 'message_update', message: msg }); }
function broadcastMessagesDeleted(ids) { broadcastAll({ type: 'messages_deleted', ids }); }
function broadcastUploadProgress(uploadId, info) { broadcastAll({ type: 'upload_progress', uploadId, info }); }
function broadcastUploadState() { broadcastAll(JSON.parse(uploadsService.buildPayload())); }

let _wss = null;
function broadcastAll(obj) {
    if (!_wss) return;
    const payload = JSON.stringify(obj);
    _wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
}
function bindWss(wss) {
    _wss = wss;
    uploadsService.setUploadBroadcaster(function (payloadStr) {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(payloadStr);
        });
    });
}
function sendStateTo(ws) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(buildStatePayload());
    ws.send(uploadsService.buildPayload());
}

module.exports = {
    addSocket, removeSocket, isOnline,
    broadcastState, sendStateTo,
    broadcastMessageNew, broadcastMessageUpdate, broadcastMessagesDeleted,
    broadcastUploadProgress, broadcastUploadState,
    bindWss
};