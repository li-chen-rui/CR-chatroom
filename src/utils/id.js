const crypto = require('crypto');

// 上传任务 id：时间戳 + 随机 hex
function genUploadId() {
    return Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// 消息 id：UUID v4
function genMessageId() {
    return crypto.randomUUID();
}

module.exports = { genUploadId, genMessageId };