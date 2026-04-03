const db = require('./db.js');
const { createRoleObject } = require('./roles.js');
const game = require('./game.js');

let zaloApi = null;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MESSAGE QUEUE — Retry + Rate Limit
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const msgQueue = [];
let isSendingMsg = false;

async function sendMsgQueue() {
    if (isSendingMsg || msgQueue.length === 0) return;
    isSendingMsg = true;
    while (msgQueue.length > 0) {
        const { threadId, content, isGroup } = msgQueue.shift();
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await zaloApi.sendMessage(content, threadId, isGroup ? 1 : 0);
                success = true;
                break;
            } catch (e) {
                console.error(`Lỗi gửi tin WW (lần ${attempt}/3):`, e.message);
                if (attempt < 3) {
                    if (!isGroup) {
                        try { await zaloApi.sendFriendRequest("Bot Ma Sói 🐺", threadId); } catch (_) {}
                    }
                    await new Promise(r => setTimeout(r, 2000 * attempt));
                }
            }
        }
        if (!success) console.error(`❌ Thất bại gửi tin WW tới ${threadId} sau 3 lần.`);
        await new Promise(r => setTimeout(r, 2000));
    }
    isSendingMsg = false;
}

function queueMsg(threadId, text, isGroup = false) {
    msgQueue.push({ threadId, content: text, isGroup });
    sendMsgQueue();
}

// Styled message with TextStyle
function queueStyledMsg(threadId, msg, styles, isGroup = false) {
    msgQueue.push({ threadId, content: { msg, styles }, isGroup });
    sendMsgQueue();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function fetchUserName(userId) {
    if (!zaloApi) return null;
    try {
        const info = await zaloApi.getUserInfo(userId);
        if (info && info.changed_profiles && info.changed_profiles[userId]) {
            return info.changed_profiles[userId].displayName || info.changed_profiles[userId].zaloName || null;
        }
    } catch (e) {}
    return null;
}

function resolveTargetFromPlayers(arg, players) {
    if (!arg) return null;
    let cleaned = arg.replace(/^@/, '');
    let num = parseInt(cleaned);
    if (!isNaN(num) && num > 0) {
        const aliveP = players.filter(p => p.is_alive);
        if (num <= aliveP.length) return aliveP[num - 1].user_id;
        return null;
    }
    return null;
}

function findPlayerByName(nameQuery, players) {
    if (!nameQuery) return null;
    let cleaned = nameQuery.replace(/^@/, '').toLowerCase().trim();
    if (!cleaned) return null;
    const alivePlayers = players.filter(p => p.is_alive && p.name);
    let found = alivePlayers.find(p => p.name.toLowerCase() === cleaned);
    if (found) return found.user_id;
    found = alivePlayers.find(p => p.name.toLowerCase().startsWith(cleaned));
    if (found) return found.user_id;
    found = alivePlayers.find(p => p.name.toLowerCase().includes(cleaned));
    if (found) return found.user_id;
    return null;
}

function pName(player) {
    return player && player.name ? player.name : '???';
}
function pNameById(uid, players) {
    const p = players.find(x => x.user_id === uid);
    return pName(p);
}

function buildAliveList(players) {
    const alive = players.filter(p => p.is_alive);
    return alive.map((p, i) => `${i + 1}. ${pName(p)}`).join('\n');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ROLE GUIDE (/ww roles)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ROLE_GUIDE = `📖 HƯỚNG DẪN CÁC VAI TRÒ MA SÓI

━━━ PHE SÓI ━━━
🐺 Werewolf (Ma Sói)
   Cắn 1 người mỗi đêm.
   Lệnh: /kill <STT>

🐺 Lycan (Sói Ngụ Trang)
   Giống Sói nhưng Tiên Tri soi thấy "Không phải sói".
   Lệnh: /kill <STT>

🐺👁 WolfSeer (Sói Tiên Tri)
   Cắn + Soi 1 người mỗi đêm.
   Lệnh: /kill <STT> và /see <STT>

━━━ PHE DÂN LÀNG ━━━
👁 Seer (Tiên Tri)
   Soi 1 người mỗi đêm để biết có phải Sói không.
   Lệnh: /see <STT>

🛡 Guard (Bảo Vệ)
   Bảo vệ 1 người mỗi đêm (không lặp 2 đêm liên tiếp).
   Lệnh: /guard <STT>

🧙‍♀️ Witch (Phù Thủy)
   1 thuốc cứu + 1 thuốc độc (mỗi loại dùng 1 lần).
   Lệnh: /ww witch heal|poison <STT> hoặc /ww witch skip

🔫 Hunter (Thợ Săn)
   Khi chết → bắn chết 1 người. (Tự động)

💘 Cupid (Thần Tình Yêu)
   Đêm 1 ghép đôi 2 người. 1 chết → cả 2 chết.

👴 Elder (Già Làng)
   Sống sót lần đầu bị Sói cắn. (Tự động)

🤡 Idiot (Thằng Ngốc)
   Bị treo cổ → sống nhưng mất quyền vote. (Tự động)

😈 Cursed (Dân Bị Nguyền)
   Ban đầu là dân. Bị Sói cắn → hóa Sói thay vì chết. (Tự động)

━━━ LỆNH TẮT ━━━
/join   Tham gia     /alive  Xem danh sách
/v <STT> Vote        /kill   Cắn (sói)
/see    Soi (tiên tri) /guard  Bảo vệ
/start  Bắt đầu      /stop   Hủy game`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  INIT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function init(api, runQuery, getQuery, allQuery) {
    zaloApi = api;
    db.init(runQuery, getQuery, allQuery);
    setTimeout(() => db.initTables(), 1000);
    setInterval(gameTick, 5000);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GAME TICK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function gameTick() {
    try {
        const runningGames = await db.allQuery("SELECT * FROM bot_ww_games WHERE state IN ('DAY', 'NIGHT') AND timer_ends_at <= NOW()");
        for (const g of runningGames) {
            if (g.state === 'NIGHT') await processNightResults(g.group_id, g);
            else if (g.state === 'DAY') await processDayResults(g.group_id, g);
        }
    } catch (e) {
        console.error("Lỗi WW gameTick:", e);
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  NIGHT → DAY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function processNightResults(groupId, lobbyGame) {
    const players = await db.getPlayers(groupId);
    const day = lobbyGame.day_count;
    const actions = await db.allQuery("SELECT * FROM bot_ww_night_actions WHERE group_id = ? AND day = ?", [groupId, day]);
    
    let wolfTarget = null, guardTarget = null, witchHeal = null, witchPoison = null;
    const wolvesVotes = {};

    for (const action of actions) {
        if (action.action_type === 'KILL') {
            wolvesVotes[action.target_id] = (wolvesVotes[action.target_id] || 0) + 1;
        } else if (action.action_type === 'GUARD') {
            guardTarget = action.target_id;
        } else if (action.action_type === 'HEAL') {
            witchHeal = action.target_id;
        } else if (action.action_type === 'POISON') {
            witchPoison = action.target_id;
        } else if (action.action_type === 'SHIP') {
            // Cupid pairs two lovers
            const target2 = action.extra ? JSON.parse(action.extra).target2 : null;
            if (action.target_id && target2) {
                await db.runQuery("UPDATE bot_ww_players SET lover_id = ? WHERE group_id = ? AND user_id = ?", [target2, groupId, action.target_id]);
                await db.runQuery("UPDATE bot_ww_players SET lover_id = ? WHERE group_id = ? AND user_id = ?", [action.target_id, groupId, target2]);
                queueMsg(action.target_id, `💘 Thần Tình Yêu đã ghép đôi bạn với ${pNameById(target2, players)}!\nNếu 1 trong 2 chết, người còn lại cũng chết theo vì đau buồn.`);
                queueMsg(target2, `💘 Thần Tình Yêu đã ghép đôi bạn với ${pNameById(action.target_id, players)}!\nNếu 1 trong 2 chết, người còn lại cũng chết theo vì đau buồn.`);
            }
        } else if (action.action_type === 'SEE') {
            const targetP = players.find(p => p.user_id === action.target_id);
            if (targetP) {
                const tr = createRoleObject(targetP);
                const isWolf = tr.party === 'Werewolf' && !(tr.appearsAsWolf === false);
                const tName = pName(targetP);
                const resultEmoji = isWolf ? "🐺 LÀ SÓI!" : "🧑 KHÔNG PHẢI SÓI";
                queueMsg(action.user_id, `━━━━━━━━━━━━━━━━\n👁 KẾT QUẢ SOI ĐÊM ${day}\n━━━━━━━━━━━━━━━━\n\n${tName} → ${resultEmoji}`);
            }
        }
    }

    let maxV = 0;
    let wolfTiedTargets = [];
    for (const [tId, v] of Object.entries(wolvesVotes)) {
        if (v > maxV) { maxV = v; wolfTiedTargets = [tId]; }
        else if (v === maxV) { wolfTiedTargets.push(tId); }
    }
    if (wolfTiedTargets.length > 0) {
        wolfTarget = wolfTiedTargets[Math.floor(Math.random() * wolfTiedTargets.length)];
    }

    const deadList = [];
    
    // Cursed: transforms instead of dying
    if (wolfTarget) {
        const tp = players.find(p => p.user_id === wolfTarget);
        if (tp) {
            const tr = createRoleObject(tp);
            if (tr.name === 'Cursed') {
                await db.runQuery("UPDATE bot_ww_players SET role = 'Werewolf' WHERE group_id = ? AND user_id = ?", [groupId, wolfTarget]);
                queueMsg(wolfTarget, `😈 LỜI NGUYỀN KÍCH HOẠT!\n\nBạn bị Sói cắn nhưng thay vì chết, bạn đã HÓA SÓI!\n🐺 Từ giờ bạn chiến đấu cho phe Ma Sói.`);
                wolfTarget = null;
            }
        }
    }
    // Elder: survives first bite
    if (wolfTarget) {
        const tp = players.find(p => p.user_id === wolfTarget);
        if (tp) {
            const tr = createRoleObject(tp);
            if (tr.name === 'Elder' && !tr.status.elderUsed) {
                await db.runQuery("UPDATE bot_ww_players SET status = JSON_SET(COALESCE(status, '{}'), '$.elderUsed', true) WHERE group_id = ? AND user_id = ?", [groupId, wolfTarget]);
                queueMsg(wolfTarget, `👴 Sói đã cố cắn bạn, nhưng sức mạnh Già Làng giúp bạn SỐNG SÓT lần này!`);
                wolfTarget = null;
            }
        }
    }

    if (wolfTarget && guardTarget !== wolfTarget && witchHeal !== wolfTarget) {
        deadList.push(wolfTarget);
    }
    if (witchPoison && !deadList.includes(witchPoison)) {
        deadList.push(witchPoison);
    }

    for (const d of deadList) {
        await db.runQuery("UPDATE bot_ww_players SET is_alive = 0 WHERE group_id = ? AND user_id = ?", [groupId, d]);
    }

    // Lover death propagation: if a lover dies, the other dies too
    const loverDeaths = [];
    for (const d of deadList) {
        const deadP = players.find(p => p.user_id === d);
        if (deadP && deadP.lover_id) {
            const lover = players.find(p => p.user_id === deadP.lover_id && p.is_alive);
            if (lover && !deadList.includes(lover.user_id) && !loverDeaths.includes(lover.user_id)) {
                loverDeaths.push(lover.user_id);
                await db.runQuery("UPDATE bot_ww_players SET is_alive = 0 WHERE group_id = ? AND user_id = ?", [groupId, lover.user_id]);
            }
        }
    }
    deadList.push(...loverDeaths);

    // Hunter revenge: if Hunter dies, shoots a random alive enemy
    const hunterKills = [];
    for (const uid of deadList) {
        const deadP = players.find(p => p.user_id === uid);
        if (deadP) {
            const deadRole = createRoleObject(deadP);
            if (deadRole.name === 'Hunter') {
                const aliveEnemies = players.filter(p => p.is_alive && !deadList.includes(p.user_id) && !hunterKills.includes(p.user_id));
                if (aliveEnemies.length > 0) {
                    const victim = aliveEnemies[Math.floor(Math.random() * aliveEnemies.length)];
                    hunterKills.push(victim.user_id);
                    await db.runQuery("UPDATE bot_ww_players SET is_alive = 0 WHERE group_id = ? AND user_id = ?", [groupId, victim.user_id]);
                    queueMsg(uid, `🔫 Trước khi chết, bạn đã bắn ${pName(victim)}!`);
                    queueMsg(victim.user_id, `🔫 THỢ SĂN ĐÃ BẮN BẠN!\n\n${pName(deadP)} là Thợ Săn, trước khi chết đã kéo bạn theo!\nHãy im lặng theo dõi trận đấu nhé! 🙏`);
                }
            }
        }
    }
    deadList.push(...hunterKills);

    const updatedPlayers = await db.getPlayers(groupId);

    // DM dead players to notify them
    for (const uid of deadList) {
        const deadP = updatedPlayers.find(p => p.user_id === uid);
        if (loverDeaths.includes(uid)) {
            queueMsg(uid, `💔 NGƯỜI YÊU CỦA BẠN ĐÃ CHẾT!\n\n${pName(deadP)}, bạn quá đau buồn và cũng ra đi theo người yêu.\nHãy im lặng theo dõi trận đấu nhé! 🙏`);
        } else {
            queueMsg(uid, `💀 BẠN ĐÃ BỊ GIẾT TRONG ĐÊM ${day}!\n\n${pName(deadP)}, bạn đã tử nạn. Bạn không thể tham gia thảo luận hay vote nữa.\nHãy im lặng theo dõi trận đấu nhé! 🙏`);
        }
    }

    // Build announcement
    let deadNames = deadList.map(uid => pNameById(uid, updatedPlayers));
    let msgBody;
    if (deadList.length === 0) {
        msgBody = "✨ Đêm qua bình yên, không ai tử nạn.";
    } else {
        msgBody = `💀 ĐÊM QUA ĐÃ CÓ NGƯỜI CHẾT:\n${deadNames.map(n => `   ☠️ ${n}`).join('\n')}`;
    }

    const aliveListTxt = buildAliveList(updatedPlayers);
    await game.lockGroup(groupId, false);

    queueMsg(groupId, `━━━━━━━━━━━━━━━━━━━\n🌅 BÌNH MINH ĐÃ LÊN! (Ngày ${day})\n━━━━━━━━━━━━━━━━━━━\n\n${msgBody}\n\n🧑 Còn sống:\n${aliveListTxt}\n\n━━━━━━━━━━━━━━━━━━━\n👉 Có 2 phút thảo luận và vote.\n📝 /v <STT> hoặc /v @tag để vote\n📝 /v skip hoặc ❤️ tin nhắn Bot để bỏ qua`, true);

    const winner = await game.checkEndGame(groupId, updatedPlayers);
    if (winner) {
        await game.endGame(groupId, winner);
        const winEmoji = winner === 'Werewolf' ? '🐺 Ma Sói' : '🧑 Dân Làng';
        queueMsg(groupId, `━━━━━━━━━━━━━━━━━━━\n🎉 KẾT THÚC!\n\nPhe ${winEmoji} giành chiến thắng!\n━━━━━━━━━━━━━━━━━━━`, true);
        return;
    }

    const newTimer = new Date(Date.now() + game.PHASE_TIME_DAY);
    await db.runQuery("UPDATE bot_ww_games SET state = 'DAY', timer_ends_at = ? WHERE group_id = ?", [newTimer, groupId]);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DAY → NIGHT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function processDayResults(groupId, lobbyGame) {
    const day = lobbyGame.day_count;
    const votes = await db.allQuery("SELECT * FROM bot_ww_votes WHERE group_id = ? AND day = ?", [groupId, day]);
    const tally = {};
    for (const v of votes) tally[v.target_id] = (tally[v.target_id] || 0) + 1;

    let target = null, max = 0, tie = false;
    for (const [tId, v] of Object.entries(tally)) {
        if (v > max) { max = v; target = tId; tie = false; }
        else if (v === max) { tie = true; }
    }

    const playersFull = await db.getPlayers(groupId);

    if (tie || !target || target === 'skip') {
        queueMsg(groupId, `━━━━━━━━━━━━━━━━━━━\n🌇 HOÀNG HÔN\n━━━━━━━━━━━━━━━━━━━\n\nDân làng không thống nhất được ai bị treo cổ.`, true);
    } else {
        const targetPlayer = playersFull.find(p => p.user_id === target);
        const targetRole = targetPlayer ? createRoleObject(targetPlayer) : null;
        
        if (targetRole && targetRole.name === 'Idiot') {
            await db.runQuery("UPDATE bot_ww_players SET status = JSON_SET(COALESCE(status, '{}'), '$.idiotRevealed', true) WHERE group_id = ? AND user_id = ?", [groupId, target]);
            queueMsg(groupId, `━━━━━━━━━━━━━━━━━━━\n🌇 HOÀNG HÔN\n━━━━━━━━━━━━━━━━━━━\n\nDân làng quyết treo cổ ${pName(targetPlayer)}...\n\n🤡 NHƯNG! Đó là THẰNG NGỐC!\nHắn lật bài và SỐNG SÓT, nhưng mất quyền vote.`, true);
            queueMsg(target, `🤡 Bạn bị treo cổ nhưng SỐNG SÓT!\n\nDanh tính bạn đã bị lộ. Bạn mất quyền vote từ giờ.`);
        } else {
            await db.runQuery("UPDATE bot_ww_players SET is_alive = 0 WHERE group_id = ? AND user_id = ?", [groupId, target]);
            queueMsg(groupId, `━━━━━━━━━━━━━━━━━━━\n🌇 HOÀNG HÔN\n━━━━━━━━━━━━━━━━━━━\n\n☠️ Dân làng đã treo cổ hỏa thiêu: ${pName(targetPlayer)}`, true);
            // DM the dead player
            queueMsg(target, `💀 BẠN ĐÃ BỊ TREO CỔ!\n\n${pName(targetPlayer)}, dân làng đã vote bạn ra. Bạn không thể tham gia thảo luận nữa.\nHãy theo dõi trận đấu trong im lặng! 🙏`);

            // Hunter revenge: shoots a random alive player
            if (targetRole && targetRole.name === 'Hunter') {
                const aliveOthers = playersFull.filter(p => p.is_alive && p.user_id !== target);
                if (aliveOthers.length > 0) {
                    const victim = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
                    await db.runQuery("UPDATE bot_ww_players SET is_alive = 0 WHERE group_id = ? AND user_id = ?", [groupId, victim.user_id]);
                    queueMsg(groupId, `🔫 ${pName(targetPlayer)} là THỢ SĂN! Trước khi chết đã bắn ${pName(victim)}!`, true);
                    queueMsg(victim.user_id, `🔫 THỢ SĂN ĐÃ BẮN BẠN!\n\n${pName(targetPlayer)} là Thợ Săn, trước khi chết đã kéo bạn theo!\nHãy im lặng theo dõi trận đấu nhé! 🙏`);
                }
            }

            // Lover death propagation
            if (targetPlayer && targetPlayer.lover_id) {
                const lover = playersFull.find(p => p.user_id === targetPlayer.lover_id && p.is_alive);
                if (lover) {
                    await db.runQuery("UPDATE bot_ww_players SET is_alive = 0 WHERE group_id = ? AND user_id = ?", [groupId, lover.user_id]);
                    queueMsg(groupId, `💔 ${pName(lover)} quá đau buồn trước cái chết của người yêu và cũng ra đi...`, true);
                    queueMsg(lover.user_id, `💔 NGƯỜI YÊU CỦA BẠN ĐÃ CHẾT!\n\n${pName(lover)}, bạn quá đau buồn và cũng ra đi theo người yêu.\nHãy im lặng theo dõi trận đấu nhé! 🙏`);
                }
            }
        }
    }

    const updatedPlayers = await db.getPlayers(groupId);
    const winner = await game.checkEndGame(groupId, updatedPlayers);
    if (winner) {
        await game.endGame(groupId, winner);
        const winEmoji = winner === 'Werewolf' ? '🐺 Ma Sói' : '🧑 Dân Làng';
        queueMsg(groupId, `━━━━━━━━━━━━━━━━━━━\n🎉 KẾT THÚC!\n\nPhe ${winEmoji} giành chiến thắng!\n━━━━━━━━━━━━━━━━━━━`, true);
        return;
    }

    // Move to NIGHT
    const newTimer = new Date(Date.now() + game.PHASE_TIME_NIGHT);
    await db.runQuery("UPDATE bot_ww_games SET state = 'NIGHT', day_count = day_count + 1, timer_ends_at = ? WHERE group_id = ?", [newTimer, groupId]);
    await game.lockGroup(groupId, true);

    // Send night DMs
    const aliveList = updatedPlayers.filter(p => p.is_alive);
    const aliveTxt = buildAliveList(updatedPlayers);

    // Find who the wolves voted to kill (for Witch notification)
    const nightActions = await db.allQuery("SELECT * FROM bot_ww_night_actions WHERE group_id = ? AND day = ?", [groupId, day]);
    const wolvesKillVotes = {};
    for (const a of nightActions) {
        if (a.action_type === 'KILL') wolvesKillVotes[a.target_id] = (wolvesKillVotes[a.target_id] || 0) + 1;
    }
    let prevWolfTarget = null;
    let maxKV = 0;
    for (const [tId, v] of Object.entries(wolvesKillVotes)) {
        if (v > maxKV) { maxKV = v; prevWolfTarget = tId; }
    }

    for (const p of aliveList) {
        const roleObj = createRoleObject(p);
        let roleTxt = `━━━━━━━━━━━━━━━━━━━\n🌙 ĐÊM ${day + 1} BUÔNG XUỐNG\n━━━━━━━━━━━━━━━━━━━\n\n🧑 Người sống sót:\n${aliveTxt}\n\n━━━━━━━━━━━━━━━━\n`;
        
        if (roleObj.party === 'Werewolf') {
            const wolfAllies = aliveList.filter(x => x.user_id !== p.user_id && createRoleObject(x).party === 'Werewolf');
            const alliesTxt = wolfAllies.length > 0 ? wolfAllies.map(w => pName(w)).join(', ') : '(bạn là sói duy nhất)';
            roleTxt += `🐺 Vai: ${roleObj.name.toUpperCase()}\n`;
            roleTxt += `🤝 Đồng đội: ${alliesTxt}\n\n`;
            roleTxt += `📝 Lệnh cắn: /kill <STT>`;
            if (roleObj.name === 'WolfSeer') roleTxt += `\n📝 Lệnh soi: /see <STT>`;
        } else if (roleObj.name === 'Seer') {
            roleTxt += `👁 Vai: TIÊN TRI\n\n📝 Lệnh: /see <STT>`;
        } else if (roleObj.name === 'Guard') {
            const lastG = roleObj.status.lastGuarded || null;
            const warnTxt = lastG ? `\n⚠️ Không được bảo vệ ${pNameById(lastG, updatedPlayers)} (đã bảo vệ đêm trước)` : '';
            roleTxt += `🛡 Vai: BẢO VỆ\n\n📝 Lệnh: /guard <STT>${warnTxt}`;
        } else if (roleObj.name === 'Witch') {
            const healUsed = roleObj.status.healUsed || false;
            const poisonUsed = roleObj.status.poisonUsed || false;
            roleTxt += `🧙‍♀️ Vai: PHÙ THỦY\n`;
            if (!healUsed || !poisonUsed) {
                roleTxt += `\n💊 Thuốc cứu: ${healUsed ? '❌ Đã dùng' : '✅ Còn'}`;
                roleTxt += `\n☠️ Thuốc độc: ${poisonUsed ? '❌ Đã dùng' : '✅ Còn'}\n`;
            }
            roleTxt += `\n📝 Cứu: /ww witch heal\n📝 Độc: /ww witch poison <STT>\n📝 Skip: /ww witch skip`;
        } else if (roleObj.name === 'Cupid' && (day + 1) === 1) {
            roleTxt += `💘 Vai: THẦN TÌNH YÊU\n\n📝 Ghép đôi: /ship <STT1> <STT2>`;
        } else {
            roleTxt += `${roleObj.emoji} Vai: ${roleObj.name}\n\n💤 Không có kỹ năng đêm nay. Ngủ ngon!`;
        }

        queueMsg(p.user_id, roleTxt);
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  COMMAND PARSER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseCommand(text) {
    const txt = text.trim();
    const args = txt.split(/\s+/);
    const first = args[0]?.toLowerCase();
    
    if (first === '/ww' && args[1]) {
        return { cmd: args[1].toLowerCase(), args: args.slice(2), fullArgs: args.slice(2).join(' '), raw: txt };
    }
    
    const aliasMap = {
        '/join': 'join', '/j': 'join',
        '/leave': 'leave',
        '/start': 'start',
        '/vote': 'vote', '/v': 'vote',
        '/status': 'status',
        '/alive': 'alive', '/a': 'alive',
        '/stop': 'stop', '/cancel': 'cancel',
        '/create': 'create',
        '/kill': 'kill', '/k': 'kill',
        '/see': 'see',
        '/guard': 'guard', '/g': 'guard',
        '/roles': 'roles',
        '/ship': 'ship',
    };
    
    if (aliasMap[first]) {
        return { cmd: aliasMap[first], args: args.slice(1), fullArgs: args.slice(1).join(' '), raw: txt };
    }
    
    return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  GROUP MESSAGE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleGroupMessage(message, threadId, userId, text, displayName) {
    const parsed = parseCommand(text);
    
    // Non-command messages: check game state for warnings
    if (!parsed) {
        let { game: lobbyGame, players } = await game.getLobby(threadId);
        if (lobbyGame && (lobbyGame.state === 'NIGHT' || lobbyGame.state === 'DAY')) {
            // Check if dead player is talking
            const deadPlayer = players.find(p => p.user_id === userId && !p.is_alive);
            if (deadPlayer) {
                const now = Date.now();
                const key = `dead_${threadId}_${userId}`;
                if (!game.lastWarnTime[key] || now - game.lastWarnTime[key] > 30000) {
                    game.lastWarnTime[key] = now;
                    queueMsg(threadId, `💀 ${pName(deadPlayer)}, bạn đã chết rồi! Người chết không được phát biểu. Hãy im lặng theo dõi nhé!`, true);
                }
                return;
            }
            
            // Check if non-player is talking during game
            const isPlayer = players.find(p => p.user_id === userId);
            if (!isPlayer) {
                const now = Date.now();
                const key = `nonplayer_${threadId}`;
                if (!game.lastWarnTime[key] || now - game.lastWarnTime[key] > 60000) {
                    game.lastWarnTime[key] = now;
                    queueMsg(threadId, `⚠️ Trận đấu Ma Sói đang diễn ra! Người ngoài cuộc vui lòng không can thiệp.`, true);
                }
                return;
            }

            // Night warning for alive players
            if (lobbyGame.state === 'NIGHT') {
                const now = Date.now();
                if (!game.lastWarnTime[threadId] || now - game.lastWarnTime[threadId] > 15000) {
                    game.lastWarnTime[threadId] = now;
                    queueMsg(threadId, `🤫 SUỴT! Đang là ban đêm. Dân làng phải đi ngủ.\nNgười có vai trò hãy check Inbox Bot.`, true);
                }
            }
        }
        return;
    }

    const { cmd, args, fullArgs } = parsed;

    // ── /ww roles ──
    if (cmd === 'roles') {
        return queueMsg(threadId, ROLE_GUIDE, true);
    }

    // ── /create ──
    if (cmd === 'create') {
        const ok = await game.createGame(threadId);
        if (ok) queueMsg(threadId, `━━━━━━━━━━━━━━━━━━━\n🎮 GAME MA SÓI ĐÃ TẠO!\n━━━━━━━━━━━━━━━━━━━\n\n📝 Gõ /join để tham gia.\n📝 Tối thiểu 3 người chơi.\n📝 Admin gõ /start để bắt đầu.\n\n💡 Gõ /roles để xem hướng dẫn vai trò.`, true);
        else queueMsg(threadId, `⚠️ Đang có game diễn ra hoặc phòng chờ!`, true);
    }
    // ── /join ──
    else if (cmd === 'join') {
        await game.sendFriendRequest(userId);
        const num = await game.joinGame(threadId, userId, displayName);
        if (num) queueMsg(threadId, `✅ ${displayName} đã tham gia! (Tổng: ${num} người)`, true);
    }
    // ── /leave ──
    else if (cmd === 'leave') {
        const num = await game.leaveGame(threadId, userId);
        if (num !== false) queueMsg(threadId, `🚪 ${displayName} rời phòng. (Còn: ${num} người)`, true);
    }
    // ── /start (Admin only) ──
    else if (cmd === 'start') {
        // Check admin
        const isAdmin = await game.isGroupAdmin(threadId, userId);
        if (!isAdmin) {
            return queueMsg(threadId, `⚠️ Chỉ Admin/Trưởng nhóm mới được bắt đầu trận!`, true);
        }
        
        const res = await game.startGame(threadId);
        if (res.success) {
            await game.lockGroup(threadId, true);
            
            queueMsg(threadId, `━━━━━━━━━━━━━━━━━━━\n🐺 TRÒ CHƠI BẮT ĐẦU!\n━━━━━━━━━━━━━━━━━━━\n\n👥 Người chơi: ${res.players.length}\n\n📋 Vai trò trong trận:\n${res.roleSummary}\n\n━━━━━━━━━━━━━━━━━━━\nPhân vai đã gửi Inbox. Check tin nhắn riêng!\n🌃 MÀN ĐÊM BUÔNG XUỐNG!`, true);
            
            const aliveTxt = buildAliveList(res.players);
            
            for (const p of res.players) {
                const r = createRoleObject(p);
                let dmTxt = `━━━━━━━━━━━━━━━━━━━\n🎮 GAME MA SÓI\n━━━━━━━━━━━━━━━━━━━\n\n${r.emoji} VAI TRÒ: ${r.name.toUpperCase()}\n\n${r.description}\n\n━━━━━━━━━━━━━━━━\n🧑 Người chơi:\n${aliveTxt}`;
                
                if (r.party === 'Werewolf') {
                    const wolfAllies = res.players.filter(x => x.user_id !== p.user_id && createRoleObject(x).party === 'Werewolf');
                    const alliesTxt = wolfAllies.length > 0 ? wolfAllies.map(w => pName(w)).join(', ') : '(bạn là sói duy nhất)';
                    dmTxt += `\n\n🤝 ĐỒNG ĐỘI SÓI: ${alliesTxt}`;
                }
                
                queueMsg(p.user_id, dmTxt);
            }
        } else {
            queueMsg(threadId, res.msg, true);
        }
    }
    // ── /vote ──
    else if (cmd === 'vote') {
        let { game: lobbyGame, players } = await game.getLobby(threadId);
        if (!lobbyGame || lobbyGame.state !== 'DAY') return queueMsg(threadId, `⚠️ Chỉ được vote trong ban ngày!`, true);
        
        const voter = players.find(p => p.user_id === userId);
        if (!voter || !voter.is_alive) return queueMsg(threadId, `⚠️ Chỉ người chơi còn sống mới được vote!`, true);
        
        const voterRole = createRoleObject(voter);
        if (voterRole.status && voterRole.status.idiotRevealed) {
            return queueMsg(threadId, `🤡 ${displayName} đã bị lộ là Thằng Ngốc — mất quyền vote!`, true);
        }
        
        if (!fullArgs) return queueMsg(threadId, `⚠️ Nhập thiếu.\n📝 Lệnh: /v <STT> hoặc /v skip`, true);
        
        let targetId = null;
        if (fullArgs.toLowerCase() === 'skip') {
            targetId = 'skip';
        } else if (message.data && message.data.mentions && message.data.mentions.length > 0) {
            targetId = message.data.mentions[0].uid;
        } else {
            targetId = resolveTargetFromPlayers(args[0], players);
            if (!targetId) targetId = findPlayerByName(fullArgs, players);
        }
        
        if (!targetId || (targetId !== 'skip' && !players.find(p => p.user_id === targetId && p.is_alive))) {
            const helpTxt = buildAliveList(players);
            return queueMsg(threadId, `⚠️ Không tìm thấy "${fullArgs}".\n\n🧑 Danh sách:\n${helpTxt}`, true);
        }
        
        await db.runQuery(
            "INSERT INTO bot_ww_votes (group_id, day, voter_id, target_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)",
            [threadId, lobbyGame.day_count, userId, targetId]
        );
        const tName = targetId === 'skip' ? 'BỎ QUA' : pNameById(targetId, players);
        queueMsg(threadId, `🗳 ${displayName} đã vote → ${tName}`, true);

        // Early phase: check if all alive players voted
        const aliveVoters = players.filter(p => p.is_alive);
        const allVotes = await db.allQuery("SELECT * FROM bot_ww_votes WHERE group_id = ? AND day = ?", [threadId, lobbyGame.day_count]);
        if (allVotes.length >= aliveVoters.length) {
            await db.runQuery("UPDATE bot_ww_games SET timer_ends_at = NOW() WHERE group_id = ?", [threadId]);
            queueMsg(threadId, `⚡ Mọi người đã vote xong! Đang xử lý kết quả...`, true);
        }
    }
    // ── /stop /cancel ──
    else if (cmd === 'cancel' || cmd === 'stop') {
        let { game: lobbyGame } = await game.getLobby(threadId);
        if (!lobbyGame || lobbyGame.state === 'NONE' || lobbyGame.state === 'END') return queueMsg(threadId, `⚠️ Không có ván nào để hủy.`, true);
        await game.endGame(threadId, 'ADMIN_CANCEL');
        queueMsg(threadId, `🛑 VÁN GAME ĐÃ BỊ HỦY!`, true);
    }
    // ── /status ──
    else if (cmd === 'status') {
        let { game: lobbyGame, players } = await game.getLobby(threadId);
        if (!lobbyGame || lobbyGame.state === 'NONE' || lobbyGame.state === 'END') return queueMsg(threadId, `⚠️ Không có ván nào đang diễn ra.`, true);
        const alive = players.filter(p => p.is_alive).length;
        queueMsg(threadId, `📊 Ngày ${lobbyGame.day_count} (${lobbyGame.state})\nCòn sống: ${alive}/${players.length}`, true);
    }
    // ── /alive ──
    else if (cmd === 'alive') {
        let { game: lobbyGame, players } = await game.getLobby(threadId);
        if (!lobbyGame || lobbyGame.state === 'NONE' || lobbyGame.state === 'END') return;
        queueMsg(threadId, `🧑 Xóm Làng:\n${buildAliveList(players)}`, true);
    }
    // ── /kill (group) ──
    else if (cmd === 'kill') {
        let { game: lobbyGame, players } = await game.getLobby(threadId);
        if (!lobbyGame || lobbyGame.state !== 'NIGHT') return;
        
        const playerRecord = players.find(p => p.user_id === userId && p.is_alive === 1);
        if (!playerRecord) return;
        const roleObj = createRoleObject(playerRecord);
        if (roleObj.party !== 'Werewolf') return;

        let t = resolveTargetFromPlayers(args[0], players);
        if (!t) return queueMsg(threadId, `⚠️ VD: /kill 1`, true);
        await roleObj.onNightAction(t, { day: lobbyGame.day_count });
        
        queueMsg(threadId, `🔪 Đã ghi nhận.`, true);
        
        const otherWolves = players.filter(p => p.user_id !== userId && p.is_alive && createRoleObject(p).party === 'Werewolf');
        for (const wolf of otherWolves) {
            queueMsg(wolf.user_id, `🐺 Đồng đội ${pName(playerRecord)} đã vote cắn → ${pNameById(t, players)}`);
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PRIVATE MESSAGE HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handlePrivateMessage(message, userId, text) {
    const parsed = parseCommand(text);
    if (!parsed) return;
    const { cmd, args } = parsed;
    
    // /roles anywhere
    if (cmd === 'roles') {
        return queueMsg(userId, ROLE_GUIDE);
    }
    
    const rows = await db.allQuery("SELECT * FROM bot_ww_players WHERE user_id = ? AND is_alive = 1", [userId]);
    if (rows.length === 0) return queueMsg(userId, `⚠️ Bạn không ở trong ván đấu nào, hoặc bạn đã chết.`);
    const playerRecord = rows[0];
    const groupId = playerRecord.group_id;
    let { game: lobbyGame, players } = await game.getLobby(groupId);
    if (!lobbyGame || lobbyGame.state !== 'NIGHT') return queueMsg(userId, `⚠️ Hiện tại không phải Ban Đêm.`);

    const roleObj = createRoleObject(playerRecord);
    
    function resolveTarget(arg) { return resolveTargetFromPlayers(arg, players); }
    function getTName(tid) { return pNameById(tid, players); }
    
    if (cmd === 'alive') {
        return queueMsg(userId, `🧑 Xóm Làng:\n${buildAliveList(players)}`);
    }

    // Helper: check if all night actions are done → advance timer
    async function checkNightComplete() {
        const alivePlayers = players.filter(p => p.is_alive);
        const actions = await db.allQuery("SELECT * FROM bot_ww_night_actions WHERE group_id = ? AND day = ?", [groupId, lobbyGame.day_count]);
        const actionUsers = new Set(actions.map(a => `${a.user_id}_${a.action_type}`));
        
        let allDone = true;
        for (const p of alivePlayers) {
            const r = createRoleObject(p);
            if (r.party === 'Werewolf' && !actionUsers.has(`${p.user_id}_KILL`)) { allDone = false; break; }
            if (r.name === 'Seer' && !actionUsers.has(`${p.user_id}_SEE`)) { allDone = false; break; }
            if (r.name === 'Guard' && !actionUsers.has(`${p.user_id}_GUARD`)) { allDone = false; break; }
            if (r.name === 'Witch') {
                const hasWitchAction = actions.some(a => a.user_id === p.user_id);
                if (!hasWitchAction) { allDone = false; break; }
            }
            if (r.name === 'Cupid' && lobbyGame.day_count === 1 && !actionUsers.has(`${p.user_id}_SHIP`)) { allDone = false; break; }
        }
        if (allDone) {
            await db.runQuery("UPDATE bot_ww_games SET timer_ends_at = NOW() WHERE group_id = ?", [groupId]);
        }
    }

    if (cmd === 'kill' && roleObj.party === 'Werewolf') {
        let t = resolveTarget(args[0]);
        if (!t) return queueMsg(userId, `⚠️ Nhập STT. VD: /kill 1`);
        await roleObj.onNightAction(t, { day: lobbyGame.day_count });
        
        const otherWolves = players.filter(p => p.user_id !== userId && p.is_alive && createRoleObject(p).party === 'Werewolf');
        for (const wolf of otherWolves) {
            queueMsg(wolf.user_id, `🐺 Đồng đội ${pName(playerRecord)} đã vote cắn → ${getTName(t)}`);
        }

        // Notify Witch about wolf victim
        const witchPlayer = players.find(p => p.is_alive && p.role === 'Witch');
        if (witchPlayer) {
            const wr = createRoleObject(witchPlayer);
            if (!wr.status.healUsed) {
                queueMsg(witchPlayer.user_id, `🧙‍♀️ Sói đã chọn nạn nhân: ${getTName(t)}\n\n💊 Bạn có muốn cứu?\n📝 /ww witch heal (cứu)\n📝 /ww witch skip (bỏ qua)`);
            }
        }

        await checkNightComplete();
        return queueMsg(userId, `🔪 Sói đã chọn cắn → ${getTName(t)}`);
    }

    if (cmd === 'guard' && roleObj.name === 'Guard') {
        let t = resolveTarget(args[0]);
        if (!t) return queueMsg(userId, `⚠️ Nhập STT. VD: /guard 1`);
        const lastG = roleObj.status.lastGuarded || null;
        if (lastG === t) return queueMsg(userId, `⚠️ Không được bảo vệ cùng 1 người 2 đêm liên tiếp!`);
        await roleObj.onNightAction(t, { day: lobbyGame.day_count });
        await db.runQuery("UPDATE bot_ww_players SET status = JSON_SET(COALESCE(status, '{}'), '$.lastGuarded', ?) WHERE group_id = ? AND user_id = ?", [t, groupId, userId]);
        await checkNightComplete();
        return queueMsg(userId, `🛡 Bạn đã bảo vệ → ${getTName(t)}`);
    }

    if (cmd === 'see' && (roleObj.name === 'Seer' || roleObj.name === 'WolfSeer')) {
        let t = resolveTarget(args[0]);
        if (!t) return queueMsg(userId, `⚠️ Nhập STT. VD: /see 1`);
        const extra = roleObj.name === 'WolfSeer' ? { day: lobbyGame.day_count, action: 'SEE' } : { day: lobbyGame.day_count };
        await roleObj.onNightAction(t, extra);
        await checkNightComplete();
        return queueMsg(userId, `👁 Đang soi → ${getTName(t)}\nKết quả báo lúc hết đêm.`);
    }

    if (cmd === 'witch' && roleObj.name === 'Witch') {
        const sub = args[0]?.toLowerCase();
        const healUsed = roleObj.status.healUsed || false;
        const poisonUsed = roleObj.status.poisonUsed || false;
        if (sub === 'heal') {
            if (healUsed) return queueMsg(userId, `❌ Bạn đã dùng thuốc cứu rồi!`);
            // Witch can only heal the wolf's current target
            const killActions = await db.allQuery("SELECT target_id, COUNT(*) as cnt FROM bot_ww_night_actions WHERE group_id = ? AND day = ? AND action_type = 'KILL' GROUP BY target_id ORDER BY cnt DESC LIMIT 1", [groupId, lobbyGame.day_count]);
            if (killActions.length === 0) return queueMsg(userId, `⚠️ Sói chưa chọn nạn nhân đêm nay.`);
            const wolfVictimId = killActions[0].target_id;
            await roleObj.onNightAction(wolfVictimId, { day: lobbyGame.day_count, action: 'HEAL' });
            await db.runQuery("UPDATE bot_ww_players SET status = JSON_SET(COALESCE(status, '{}'), '$.healUsed', true) WHERE group_id = ? AND user_id = ?", [groupId, userId]);
            await checkNightComplete();
            return queueMsg(userId, `🧪 Đã cứu → ${pNameById(wolfVictimId, players)}`);
        }
        if (sub === 'poison') {
            if (poisonUsed) return queueMsg(userId, `❌ Bạn đã dùng thuốc độc rồi!`);
            let t = resolveTarget(args[1]);
            if (!t) return queueMsg(userId, `⚠️ Nhập STT. VD: /ww witch poison 2`);
            await roleObj.onNightAction(t, { day: lobbyGame.day_count, action: 'POISON' });
            await db.runQuery("UPDATE bot_ww_players SET status = JSON_SET(COALESCE(status, '{}'), '$.poisonUsed', true) WHERE group_id = ? AND user_id = ?", [groupId, userId]);
            await checkNightComplete();
            return queueMsg(userId, `☠️ Đã hạ độc → ${getTName(t)}`);
        }
        if (sub === 'skip') {
            await roleObj.onNightAction('skip', { day: lobbyGame.day_count, action: 'SKIP' });
            await checkNightComplete();
            return queueMsg(userId, `✅ Không dùng thuốc đêm nay.`);
        }
        return queueMsg(userId, `⚠️ Lệnh sai:\n/ww witch heal (cứu nạn nhân sói)\n/ww witch poison <STT>\n/ww witch skip`);
    }

    // ── /ship (Cupid, night 1 only) ──
    if (cmd === 'ship' && roleObj.name === 'Cupid') {
        if (lobbyGame.day_count !== 1) return queueMsg(userId, `⚠️ Cupid chỉ được ghép đôi ở Đêm 1!`);
        let t1 = resolveTarget(args[0]);
        let t2 = resolveTarget(args[1]);
        if (!t1 || !t2) return queueMsg(userId, `⚠️ Nhập 2 STT. VD: /ship 1 3`);
        if (t1 === t2) return queueMsg(userId, `⚠️ Không thể ghép 1 người với chính họ!`);
        await roleObj.onNightAction(t1, { day: lobbyGame.day_count, target2: t2 });
        await checkNightComplete();
        return queueMsg(userId, `💘 Đã ghép đôi: ${getTName(t1)} ❤️ ${getTName(t2)}`);
    }

    queueMsg(userId, `⚠️ Lệnh không hợp lệ hoặc bạn không có kỹ năng đêm nay.\n\n💡 Gõ /roles để xem hướng dẫn.`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  REACTION HANDLER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleReaction(reactionEvent) {
    const threadId = reactionEvent.threadId;
    const userId = reactionEvent.data.uidFrom;
    const reactType = reactionEvent.data.content ? reactionEvent.data.content.rIcon : ''; 
    if (reactType !== '/-heart' && reactType !== '/-strong') return;

    let { game: lobbyGame, players } = await game.getLobby(threadId);
    if (!lobbyGame) return;

    if (lobbyGame.state === 'NEW_GAME') {
        let dName = await fetchUserName(userId);
        if (!dName) dName = "Người chơi";
        await game.sendFriendRequest(userId);
        const num = await game.joinGame(threadId, userId, dName);
        if (num) queueMsg(threadId, `✅ ${dName} đã thả tim tham gia! (Tổng: ${num} người)`, true);
    }

    if (lobbyGame.state === 'DAY') {
        const voter = players.find(p => p.user_id === userId);
        if (voter && voter.is_alive) {
            let voterName = pName(voter);
            await db.runQuery(
                "INSERT INTO bot_ww_votes (group_id, day, voter_id, target_id) VALUES (?, ?, ?, 'skip') ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)",
                [threadId, lobbyGame.day_count, userId]
            );
            queueMsg(threadId, `🗳 ${voterName} thả ❤️ để BỎ QUA vote.`, true);

            // Early phase: check if all alive players voted
            const aliveVoters = players.filter(p => p.is_alive);
            const allVotes = await db.allQuery("SELECT * FROM bot_ww_votes WHERE group_id = ? AND day = ?", [threadId, lobbyGame.day_count]);
            if (allVotes.length >= aliveVoters.length) {
                await db.runQuery("UPDATE bot_ww_games SET timer_ends_at = NOW() WHERE group_id = ?", [threadId]);
            }
        }
    }
}

module.exports = { init, handleGroupMessage, handlePrivateMessage, handleReaction };
