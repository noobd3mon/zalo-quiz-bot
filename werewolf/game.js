const db = require('./db.js');
const { createRoleObject } = require('./roles.js');

let zaloApi = null;
function setApi(api) { zaloApi = api; }

const PHASE_TIME_NIGHT = 60 * 1000;
const PHASE_TIME_DAY = 120 * 1000;

const lastWarnTime = {};

function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex !== 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  RANDOMIZED ROLE GENERATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function generateRolesList(count) {
    // Core: luôn có 1 Seer, 1 Guard nếu đủ người
    // Sói: tối thiểu 1, scale theo tổng người
    // Còn lại: random pool
    
    const roles = [];
    const wolfCount = Math.max(1, Math.floor(count / 4)); // ~25% là sói
    const villagerSpecialPool = ['Witch', 'Hunter', 'Elder', 'Idiot', 'Cupid', 'Cursed'];
    const wolfVariantPool = ['Werewolf', 'Lycan', 'WolfSeer'];
    
    // Assign wolves
    for (let i = 0; i < wolfCount; i++) {
        if (i === 0) {
            roles.push('Werewolf'); // Luôn có ít nhất 1 sói thường
        } else {
            // Random wolf variant
            const variant = wolfVariantPool[Math.floor(Math.random() * wolfVariantPool.length)];
            roles.push(variant);
        }
    }
    
    // Core village roles
    if (count >= 3) roles.push('Seer');
    if (count >= 4) roles.push('Guard');
    
    // Fill remaining with random specials + villagers
    const remaining = count - roles.length;
    const shuffledSpecials = shuffle([...villagerSpecialPool]);
    
    let specialsToAdd = Math.min(remaining - 1, shuffledSpecials.length); // Keep at least 1 pure villager
    if (remaining <= 1) specialsToAdd = 0;

    for (let i = 0; i < specialsToAdd; i++) {
        roles.push(shuffledSpecials[i]);
    }
    
    // Fill the rest with Villagers
    while (roles.length < count) {
        roles.push('Villager');
    }
    
    return shuffle(roles);
}

// Summarize roles for game start announcement
function summarizeRoles(rolesList) {
    const counts = {};
    for (const r of rolesList) {
        counts[r] = (counts[r] || 0) + 1;
    }
    
    const roleNames = {
        'Werewolf': 'Ma Sói', 'Lycan': 'Sói Ngụy Trang', 'WolfSeer': 'Sói Tiên Tri',
        'Seer': 'Tiên Tri', 'Guard': 'Bảo Vệ', 'Witch': 'Phù Thủy', 'Hunter': 'Thợ Săn',
        'Cupid': 'Thần Tình Yêu', 'Elder': 'Già Làng', 'Idiot': 'Thằng Ngốc', 'Cursed': 'Dân Bị Nguyền',
        'Villager': 'Dân Làng'
    };
    const roleEmojis = {
        'Werewolf': '🐺', 'Lycan': '🐺', 'WolfSeer': '🐺👁',
        'Seer': '👁', 'Guard': '🛡', 'Witch': '🧙‍♀️', 'Hunter': '🔫',
        'Cupid': '💘', 'Elder': '👴', 'Idiot': '🤡', 'Cursed': '😈',
        'Villager': '👨‍🌾'
    };
    
    const wolfRoles = ['Werewolf', 'Lycan', 'WolfSeer'];
    const wolfTotal = wolfRoles.reduce((sum, r) => sum + (counts[r] || 0), 0);
    
    const lines = [`🐺 Phe Sói: ${wolfTotal} con`];
    // Only list non-wolf roles in detail
    for (const [role, count] of Object.entries(counts)) {
        if (wolfRoles.includes(role)) continue; // Skip wolf detail
        const emoji = roleEmojis[role] || '❓';
        const vName = roleNames[role] || role;
        lines.push(`${emoji} ${vName} x${count}`);
    }
    const summary = lines.join('\n');
    return { summary, wolfCount: wolfTotal };
}

async function getLobby(groupId) {
    const game = await db.getGame(groupId);
    if (!game) return { state: 'NONE' };
    const players = await db.getPlayers(groupId);
    return { game, players };
}

async function createGame(groupId) {
    let { game } = await getLobby(groupId);
    if (game && game.state !== 'NONE' && game.state !== 'END') return false;

    await db.runQuery(
        "INSERT INTO bot_ww_games (group_id, state, created_at) VALUES (?, 'NEW_GAME', NOW()) ON DUPLICATE KEY UPDATE state = 'NEW_GAME', day_count = 0, timer_ends_at = NULL, winner = NULL, werewolf_group_id = NULL, created_at = NOW()",
        [groupId]
    );
    await db.runQuery("DELETE FROM bot_ww_players WHERE group_id = ?", [groupId]);
    await db.runQuery("DELETE FROM bot_ww_votes WHERE group_id = ?", [groupId]);
    await db.runQuery("DELETE FROM bot_ww_night_actions WHERE group_id = ?", [groupId]);
    return true;
}

async function joinGame(groupId, userId, displayName) {
    let { game, players } = await getLobby(groupId);
    if (!game || game.state !== 'NEW_GAME') return false;
    if (players.find(p => p.user_id === userId)) return false;
    
    await db.runQuery("INSERT INTO bot_ww_players (group_id, user_id, name, role) VALUES (?, ?, ?, 'Pending')", [groupId, userId, displayName]);
    return players.length + 1;
}

async function leaveGame(groupId, userId) {
    let { game, players } = await getLobby(groupId);
    if (!game || game.state !== 'NEW_GAME') return false;
    const exists = players.find(p => p.user_id === userId);
    if (!exists) return false;
    
    await db.runQuery("DELETE FROM bot_ww_players WHERE group_id = ? AND user_id = ?", [groupId, userId]);
    return players.length - 1;
}

// Check if user is group admin/creator
async function isGroupAdmin(groupId, userId) {
    if (!zaloApi) return true; // Fallback: allow if can't check
    try {
        const info = await zaloApi.getGroupInfo(groupId);
        if (info && info.gridInfoMap && info.gridInfoMap[groupId]) {
            const gInfo = info.gridInfoMap[groupId];
            if (gInfo.creatorId === userId) return true;
            if (gInfo.adminIds && Array.isArray(gInfo.adminIds) && gInfo.adminIds.includes(userId)) return true;
            // Also check admins object
            if (gInfo.admins && Array.isArray(gInfo.admins)) {
                if (gInfo.admins.some(a => a.id === userId || a === userId)) return true;
            }
        }
    } catch (e) {
        console.error("Lỗi check admin:", e.message);
        return false; // Deny-by-default on error
    }
    return false;
}

async function startGame(groupId) {
    let { game, players } = await getLobby(groupId);
    if (!game || game.state !== 'NEW_GAME') return { success: false, msg: 'Không có phòng chờ hợp lệ.' };
    if (players.length < 3) return { success: false, msg: 'Cần tối thiểu 3 người để bắt đầu!' };

    const roleNames = generateRolesList(players.length);
    for (let i = 0; i < players.length; i++) {
        await db.runQuery("UPDATE bot_ww_players SET role = ?, is_alive = 1, status = '{}' WHERE group_id = ? AND user_id = ?", [roleNames[i], groupId, players[i].user_id]);
    }

    const timerEndsAt = new Date(Date.now() + PHASE_TIME_NIGHT);
    await db.runQuery(
        "UPDATE bot_ww_games SET state = 'NIGHT', day_count = 1, timer_ends_at = ? WHERE group_id = ?",
        [timerEndsAt, groupId]
    );
    
    const freshPlayers = await db.getPlayers(groupId);
    const { summary: roleSummary, wolfCount } = summarizeRoles(roleNames);
    return { success: true, players: freshPlayers, roleSummary, wolfCount };
}

async function checkEndGame(groupId, players) {
    const alivePlayers = players.filter(p => p.is_alive === 1);
    const rolesMapping = alivePlayers.map(createRoleObject);
    const wolvesCount = rolesMapping.filter(r => r.party === 'Werewolf').length;
    const villagersCount = rolesMapping.filter(r => r.party === 'Villager').length;

    if (wolvesCount === 0) return 'Villager';
    if (wolvesCount >= villagersCount) return 'Werewolf';
    return null;
}

async function endGame(groupId, winner) {
    await db.runQuery("UPDATE bot_ww_games SET state = 'END', winner = ?, timer_ends_at = NULL, werewolf_group_id = NULL WHERE group_id = ?", [winner, groupId]);
    await lockGroup(groupId, false);
}

async function lockGroup(groupId, lock) {
    if (!zaloApi) return;
    try {
        await zaloApi.updateGroupSettings({ lockSendMsg: lock }, groupId);
    } catch (e) {
        console.error(`Lỗi ${lock ? 'khóa' : 'mở khóa'} group:`, e.message);
    }
}

async function sendFriendRequest(userId) {
    if (!zaloApi) return;
    try {
        await zaloApi.sendFriendRequest("Bot Ma Sói muốn kết bạn để gửi tin nhắn trò chơi 🐺", userId);
    } catch (e) {}
}

module.exports = { 
    setApi, getLobby, createGame, joinGame, leaveGame, startGame, 
    checkEndGame, endGame, lockGroup, sendFriendRequest, isGroupAdmin,
    PHASE_TIME_DAY, PHASE_TIME_NIGHT, lastWarnTime 
};
