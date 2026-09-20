const WebSocket = require('ws');
const config = require('../../config');
const dbStore = require('../store/db');
const sockets = require('../services/sockets');

function setupWebSocket(server, sessionMiddleware) {
    const wss = new WebSocket.Server({ server });
    sockets.bindWss(wss);

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;
        ws.username = null;

        sessionMiddleware(req, {}, () => {
            const username = req.session ? req.session.username : null;
            if (username) {
                const user = dbStore.findUser(username);
                if (user && !dbStore.isBanned(user)) {
                    ws.username = username;
                    sockets.addSocket(username, ws);
                }
            }
            sockets.sendStateTo(ws);
            sockets.broadcastState(wss);
        });

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('close', () => {
            if (ws.username) sockets.removeSocket(ws.username, ws);
            sockets.broadcastState(wss);
        });

        ws.on('error', () => {
            try { ws.terminate(); } catch (e) {}
        });
    });

    const heartbeatTimer = setInterval(() => {
        wss.clients.forEach(ws => {
            if (ws.isAlive === false) {
                try { ws.terminate(); } catch (e) {}
                return;
            }
            ws.isAlive = false;
            try { ws.ping(); } catch (e) {}
        });
    }, config.HEARTBEAT_INTERVAL);

    wss.on('close', () => clearInterval(heartbeatTimer));

    return wss;
}

module.exports = { setupWebSocket };