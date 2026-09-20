const { Transform } = require('stream');

/**
 * 限速 Transform。
 * 维护 nextAllowedTime：下一个 chunk 最早可发出的时间戳。
 * 每个 chunk 按大小累加时间，误差不累积。
 */
class ThrottleStream extends Transform {
    constructor(bytesPerSecond) {
        super();
        this.bytesPerSecond = bytesPerSecond;
        this.nextAllowedTime = Date.now();
        this.timer = null;
        this.destroyed = false;
    }

    _transform(chunk, encoding, callback) {
        if (!this.bytesPerSecond || this.bytesPerSecond <= 0) {
            this.push(chunk);
            return callback();
        }

        const now = Date.now();
        const costMs = (chunk.length / this.bytesPerSecond) * 1000;
        const allowedAt = Math.max(this.nextAllowedTime, now);
        const wait = allowedAt - now;

        this.nextAllowedTime = allowedAt + costMs;

        if (wait <= 0) {
            this.push(chunk);
            callback();
        } else {
            this.timer = setTimeout(() => {
                this.timer = null;
                if (this.destroyed) return;
                this.push(chunk);
                callback();
            }, wait);
        }
    }

    _destroy(err, callback) {
        this.destroyed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        callback(err);
    }
}

module.exports = ThrottleStream;