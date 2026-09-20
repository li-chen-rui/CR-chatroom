const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

// 读取邀请码列表。
// 若文件缺失：生成随机邀请码写入，并打印到控制台（移除硬编码默认码 CR666/CR888/ADMIN123 的后门）。
function readInviteCodes() {
    if (!fs.existsSync(config.PASSWORD_FILE)) {
        const code = crypto.randomBytes(4).toString('hex').toUpperCase();
        try {
            fs.writeFileSync(config.PASSWORD_FILE, code + '\n', 'utf8');
            console.log(`[info] 已生成随机邀请码并写入 password.txt：${code}`);
        } catch (e) {
            console.error('[error] 无法写入邀请码文件', e.message);
        }
        return [code];
    }
    return fs.readFileSync(config.PASSWORD_FILE, 'utf8')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * 解析上传目录。
 * 规则（按需求简化）：
 *  - 读取 path.txt 内容，trim 后作为上传目录。
 *  - 若为空，回退到默认目录 config.DEFAULT_UPLOAD_DIR。
 *  - 相对路径按 server.js 所在目录（__dirname 上一级）解析。
 *  - 目录不存在时自动创建。
 */
function resolveUploadDir() {
    const { PATH_FILE, DEFAULT_UPLOAD_DIR, ROOT_DIR } = config;

    if (!fs.existsSync(PATH_FILE)) {
        fs.writeFileSync(PATH_FILE, DEFAULT_UPLOAD_DIR, 'utf8');
    }

    let custom = '';
    try {
        custom = fs.readFileSync(PATH_FILE, 'utf8').trim();
    } catch (e) {
        custom = '';
    }

    if (!custom) custom = DEFAULT_UPLOAD_DIR;

    // 相对路径基于项目根目录解析；绝对路径直接使用
    const resolved = path.isAbsolute(custom)
        ? path.normalize(custom)
        : path.resolve(ROOT_DIR, custom);

    if (!fs.existsSync(resolved)) {
        try {
            fs.mkdirSync(resolved, { recursive: true });
        } catch (e) {
            console.error('[error] 无法创建上传目录，回退到默认目录:', e.message);
            if (!fs.existsSync(DEFAULT_UPLOAD_DIR)) {
                fs.mkdirSync(DEFAULT_UPLOAD_DIR, { recursive: true });
            }
            return DEFAULT_UPLOAD_DIR;
        }
    }

    return resolved;
}

const MAX_FILENAME_LEN = 200;

// 清洗文件名：去路径分隔符、去目录部分、去控制字符、限制长度
function sanitizeFileName(raw) {
    let name = 'file';
    try {
        name = decodeURIComponent(String(raw || 'file'));
    } catch (e) {
        name = 'file';
    }
    // 去掉控制字符（含 NUL）
    name = name.replace(/[\u0000-\u001f\u007f]/g, '');
    // 去掉目录部分与路径分隔符
    name = path.basename(name).replace(/[/\\]/g, '_');
    name = name.replace(/^\.+$/, '_'); // 全点文件名
    if (!name) name = 'file';
    // 限制长度，保留扩展名
    if (name.length > MAX_FILENAME_LEN) {
        const ext = path.extname(name);
        const base = path.basename(name, ext);
        name = base.slice(0, MAX_FILENAME_LEN - ext.length) + ext;
    }
    return name;
}

// 扩展名白名单校验
function isExtensionAllowed(fileName, allowedExtensions) {
    if (!Array.isArray(allowedExtensions) || allowedExtensions.length === 0) return true;
    const ext = path.extname(fileName).toLowerCase().replace(/^\./, '');
    return allowedExtensions.includes(ext);
}

module.exports = {
    readInviteCodes,
    resolveUploadDir,
    sanitizeFileName,
    isExtensionAllowed
};
