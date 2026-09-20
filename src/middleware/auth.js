const dbStore = require('../store/db');
const config = require('../../config');

function isPublicPath(p) {
    if (p === '/' || p === config.PAGES.LOGIN || p === config.PAGES.REGISTER) return true;
    if (p === '/api/login' || p === '/api/register' || p === '/api/logout') return true;
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(p)) return true;
    return false;
}

function isPageRequest(p) {
    if (p.startsWith('/api/') || p.startsWith('/files/')) return false;
    if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)$/i.test(p)) return false;
    return true;
}

function authMiddleware(req, res, next) {
    const p = req.path;

    if (isPublicPath(p)) {
        const username = req.session ? req.session.username : null;
        const user = username ? dbStore.findUser(username) : null;
        const validUser = user && !dbStore.isBanned(user);

        if (validUser && (p === config.PAGES.LOGIN || p === config.PAGES.REGISTER)) {
            return res.redirect(config.PAGES.CHATROOM);
        }
        if (validUser && p === '/') return res.redirect(config.PAGES.CHATROOM);
        if (!validUser && p === '/') return res.redirect(config.PAGES.LOGIN);
        return next();
    }

    const username = req.session ? req.session.username : null;
    const user = username ? dbStore.findUser(username) : null;
    const validUser = user && !dbStore.isBanned(user);

    if (isPageRequest(p)) {
        if (!validUser) return res.redirect(config.PAGES.LOGIN);
        req.currentUser = user;
        return next();
    }

    if (!validUser) {
        if (p.startsWith('/files')) return res.status(401).send('未登录');
        return res.status(401).json({ error: '未登录' });
    }

    req.currentUser = user;
    next();
}

function requireAdmin(req, res, next) {
    if (!req.currentUser || req.currentUser.role !== 'admin') {
        return res.status(403).json({ error: '权限不足！' });
    }
    next();
}

module.exports = { authMiddleware, requireAdmin };