const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../../config');

/* ============================================================
   目录准备
   ============================================================ */
function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(config.DATA_DIR);
ensureDir(config.MESSAGE_DIR);

/* ============================================================
   时间工具
   ============================================================ */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function dayKeyOf(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatFull(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function normalizeMessage(m) {
    if (!m.timestampMs) {
        if (m.createdAt) m.timestampMs = new Date(m.createdAt).getTime();
        else m.timestampMs = Date.now();
    }
    const isFull = typeof m.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}\s/.test(m.timestamp);
    if (!isFull) m.timestamp = formatFull(m.timestampMs);
    return m;
}

/* ============================================================
   内存数据
   ============================================================ */
const db = {
    users: [],
    bannedUsernames: [],
    settings: { ...config.DEFAULT_SETTINGS },
    messages: []
};

const messageSnapshot = new Map();

/* ============================================================
   加载
   ============================================================ */
function loadUsers() {
    if (!fs.existsSync(config.USER_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(config.USER_FILE, 'utf8'));
        db.users = Array.isArray(data.users) ? data.users : [];
        db.bannedUsernames = Array.isArray(data.bannedUsernames) ? data.bannedUsernames : [];
        db.settings = { ...config.DEFAULT_SETTINGS, ...(data.settings || {}) };
    } catch (e) {
        console.error('[warn] user.json 解析失败', e.message);
    }
}

function loadMessages() {
    if (!fs.existsSync(config.MESSAGE_DIR)) return 0;
    const files = fs.readdirSync(config.MESSAGE_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));

    let total = 0;
    for (const f of files) {
        const filePath = path.join(config.MESSAGE_DIR, f);
        const day = f.replace(/\.json$/, '');
        try {
            const arr = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!Array.isArray(arr)) continue;

            let dirty = false;
            arr.forEach(m => {
                const before = m.timestamp;
                normalizeMessage(m);
                if (m.timestamp !== before) dirty = true;
            });

            arr.forEach(m => db.messages.push(m));
            messageSnapshot.set(day, JSON.stringify(arr));
            total += arr.length;

            if (dirty) {
                try { fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf8'); } catch (e) {}
            }
        } catch (e) {
            console.error(`[warn] ${f} 解析失败`, e.message);
        }
    }

    // 全量排序
    db.messages.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
    return total;
}

/* ============================================================
   迁移旧 data.json
   ============================================================ */
function migrateLegacyData() {
    if (!fs.existsSync(config.LEGACY_DATA_FILE)) return;

    const hasUsers = fs.existsSync(config.USER_FILE);
    const messageFiles = fs.existsSync(config.MESSAGE_DIR)
        ? fs.readdirSync(config.MESSAGE_DIR).filter(f => f.endsWith('.json')).length
        : 0;
    if (hasUsers || messageFiles > 0) return;

    console.log('[info] 检测到旧 data.json，开始迁移到新结构...');
    try {
        const old = JSON.parse(fs.readFileSync(config.LEGACY_DATA_FILE, 'utf8'));

        const userData = {
            users: old.users || [],
            bannedUsernames: old.bannedUsernames || [],
            settings: { ...config.DEFAULT_SETTINGS, ...(old.settings || {}) }
        };
        fs.writeFileSync(config.USER_FILE, JSON.stringify(userData, null, 2), 'utf8');

        const byDay = new Map();
        (old.messages || []).forEach(m => {
            normalizeMessage(m);
            const day = dayKeyOf(m.timestampMs);
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day).push(m);
        });

        for (const [day, list] of byDay) {
            list.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
            fs.writeFileSync(
                path.join(config.MESSAGE_DIR, `${day}.json`),
                JSON.stringify(list, null, 2),
                'utf8'
            );
        }

        const backup = config.LEGACY_DATA_FILE + '.migrated';
        fs.renameSync(config.LEGACY_DATA_FILE, backup);
        console.log(`[info] 迁移完成，旧文件已备份为 ${path.basename(backup)}`);
    } catch (e) {
        console.error('[error] 迁移失败', e.message);
    }
}

migrateLegacyData();
loadUsers();
const messageCount = loadMessages();
console.log(`[info] 已加载用户 ${db.users.length} 个，消息 ${messageCount} 条，来自 ${messageSnapshot.size} 个日期文件`);

/* ============================================================
   保存：按天脏标记
   ============================================================ */
let saveTimer = null;
let saving = false;
let pendingUser = false;
let pendingMessages = false;
let dirtyAllDays = false;
const dirtyDays = new Set();

function saveData() {
    pendingUser = true;
    dirtyAllDays = true;
    pendingMessages = true;
    scheduleSave();
}

function saveUsers() {
    pendingUser = true;
    scheduleSave();
}

/** 只保存某条消息所属的天 */
function saveMessageOf(msg) {
    if (!msg) return;
    normalizeMessage(msg);
    if (msg.timestampMs) dirtyDays.add(dayKeyOf(msg.timestampMs));
    pendingMessages = true;
    scheduleSave();
}

/** 只保存某几天的消息（删除场景） */
function saveMessagesOfDays(days) {
    if (!Array.isArray(days)) return;
    days.forEach(d => { if (d) dirtyDays.add(d); });
    pendingMessages = true;
    scheduleSave();
}

function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        doSave().catch(e => console.error('[error] doSave', e));
    }, config.SAVE_DEBOUNCE_MS);
}

async function doSave() {
    saveTimer = null;
    if (saving) return;
    saving = true;

    try {
        if (pendingUser) {
            pendingUser = false;
            const userData = {
                users: db.users,
                bannedUsernames: db.bannedUsernames,
                settings: db.settings
            };
            const tmp = config.USER_FILE + '.tmp';
            await fsp.writeFile(tmp, JSON.stringify(userData, null, 2), 'utf8');
            await fsp.rename(tmp, config.USER_FILE);
        }

        if (pendingMessages) {
            pendingMessages = false;
            await saveAllMessageDays();
        }
    } catch (e) {
        console.error('[error] 保存失败', e.message);
    } finally {
        saving = false;
        if (pendingUser || pendingMessages) scheduleSave();
    }
}

async function saveAllMessageDays() {
    if (dirtyAllDays) {
        // 全量路径：重新聚合全部消息到天
        const byDay = new Map();
        for (const m of db.messages) {
            if (!m.timestampMs) continue;
            const day = dayKeyOf(m.timestampMs);
            if (!byDay.has(day)) byDay.set(day, []);
            byDay.get(day).push(m);
        }

        for (const [day, list] of byDay) {
            list.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
            const compact = JSON.stringify(list);
            if (messageSnapshot.get(day) === compact) continue;

            const file = path.join(config.MESSAGE_DIR, `${day}.json`);
            const tmp = file + '.tmp';
            await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
            await fsp.rename(tmp, file);
            messageSnapshot.set(day, compact);
        }

        for (const day of Array.from(messageSnapshot.keys())) {
            if (!byDay.has(day)) {
                const file = path.join(config.MESSAGE_DIR, `${day}.json`);
                try { await fsp.unlink(file); } catch (e) {}
                messageSnapshot.delete(day);
            }
        }

        dirtyAllDays = false;
        dirtyDays.clear();
        return;
    }

    // 部分路径：只写脏天
    for (const day of Array.from(dirtyDays)) {
        const list = db.messages.filter(m => m.timestampMs && dayKeyOf(m.timestampMs) === day);
        list.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));
        const file = path.join(config.MESSAGE_DIR, `${day}.json`);

        if (list.length === 0) {
            try { await fsp.unlink(file); } catch (e) {}
            messageSnapshot.delete(day);
            continue;
        }

        const compact = JSON.stringify(list);
        if (messageSnapshot.get(day) === compact) continue;

        const tmp = file + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
        await fsp.rename(tmp, file);
        messageSnapshot.set(day, compact);
    }
    dirtyDays.clear();
}

async function flush() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    pendingUser = true;
    dirtyAllDays = true;
    pendingMessages = true;
    await doSave();
}

/* ============================================================
   查询辅助
   ============================================================ */
function findUser(username) {
    return db.users.find(u => u.username === username);
}

function isBanned(user) {
    if (!user) return false;
    return user.role === 'banned' || db.bannedUsernames.includes(user.username);
}

module.exports = {
    get db() { return db; },
    saveData,
    saveUsers,
    saveMessageOf,
    saveMessagesOfDays,
    flush,
    findUser,
    isBanned,
    dayKeyOf,
    formatFull
};