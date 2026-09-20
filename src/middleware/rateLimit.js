/* ============================================================
   轻量内存限流（固定窗口），避免暴力破解与消息刷屏。
   ============================================================ */

const buckets = new Map();
const MAX_BUCKETS = 20000;

function prune(now) {
    if (buckets.size <= MAX_BUCKETS) return;
    for (const [key, b] of buckets) {
        if (now >= b.resetAt) buckets.delete(key);
    }
}

/**
 * 创建一个限流中间件。
 * @param {object} opts
 *   - windowMs: 窗口毫秒数
 *   - max: 窗口内最大请求数
 *   - keyFn(req): 返回限流 key（默认按 IP）
 */
function rateLimit(opts) {
    const windowMs = opts.windowMs;
    const max = opts.max;
    const keyFn = opts.keyFn || (req => req.ip || 'global');
    const message = opts.message || '请求过于频繁，请稍后再试';

    return function (req, res, next) {
        const now = Date.now();
        prune(now);

        let key;
        try { key = String(keyFn(req)); } catch (e) { key = 'global'; }

        let b = buckets.get(key);
        if (!b || now >= b.resetAt) {
            b = { count: 0, resetAt: now + windowMs };
            buckets.set(key, b);
        }

        b.count++;
        if (b.count > max) {
            res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
            return res.status(429).json({ error: message });
        }
        next();
    };
}

module.exports = { rateLimit };
