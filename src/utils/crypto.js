const crypto = require('crypto');

// scrypt 哈希，返回 "salt:hash"（hex）
function hashPassword(plain) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(plain, salt, 64);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

// 兼容旧明文数据的校验
function verifyPassword(plain, stored) {
    if (typeof stored !== 'string') return false;
    if (!stored.includes(':')) return stored === plain;

    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;

    try {
        const salt = Buffer.from(saltHex, 'hex');
        const expected = Buffer.from(hashHex, 'hex');
        const actual = crypto.scryptSync(plain, salt, expected.length);
        return crypto.timingSafeEqual(expected, actual);
    } catch (e) {
        return false;
    }
}

function isHashed(stored) {
    return typeof stored === 'string'
        && stored.includes(':')
        && /^[0-9a-f]+:[0-9a-f]+$/i.test(stored);
}

module.exports = { hashPassword, verifyPassword, isHashed };