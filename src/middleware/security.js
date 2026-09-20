/* ============================================================
   安全响应头 + 基础 CSRF（同源校验）
   ============================================================ */

// 安全响应头：nosniff / 防点击劫持 / CSP / Referrer
function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self' ws: wss:",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'"
        ].join('; ')
    );
    next();
}

// 同源校验：POST/PUT/DELETE 等写请求，若带 Origin 则必须与 Host 一致。
// 非浏览器客户端（无 Origin）放行。
function csrfCheck(req, res, next) {
    const method = (req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    const origin = req.headers.origin;
    if (!origin) return next();

    const host = req.headers.host;
    try {
        const o = new URL(origin);
        if (o.host === host) return next();
    } catch (e) { /* fallthrough to reject */ }

    return res.status(403).json({ error: '非法请求来源' });
}

module.exports = { securityHeaders, csrfCheck };
