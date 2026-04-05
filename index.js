require('./src/discord_logger');
const { Zalo, ThreadType, Reactions } = require('zca-js');
const fs = require('fs');
const werewolf = require('./werewolf/index.js');
const config = require('./src/config');
const db = require('./src/database');
const ai = require('./src/ai');
const quiz = require('./src/quiz');
const wordchain = require('./src/wordchain');
const utils = require('./src/utils');
const tenschoolLive = require('./src/tenschool_live');

// ---------------------------------------------------------
// MESSAGE QUEUE PER THREAD (PHASE 3, TASK 6)
// ---------------------------------------------------------
const threadQueues = new Map();
const THREAD_QUEUE_CLEANUP_MS = 5 * 60 * 1000; // Cleanup inactive threads after 5 minutes
const pendingBroadcasts = new Map(); // userId -> { messageText, targets }

async function processQueue(threadId) {
    const queue = threadQueues.get(threadId);
    if (!queue || queue.processing || queue.items.length === 0) return;

    queue.processing = true;
    queue.lastActivity = Date.now();
    while (queue.items.length > 0) {
        const { message, api } = queue.items.shift();
        try {
            await handleMessage(api, message);
        } catch (error) {
            console.error(`❌ Lỗi xử lý tin nhắn trong thread ${threadId}:`, error);
        }
    }
    queue.processing = false;
    queue.lastActivity = Date.now();
}

// Cleanup inactive thread queues and stale Maps periodically
setInterval(() => {
    const now = Date.now();
    for (const [threadId, queue] of threadQueues.entries()) {
        if (!queue.processing && (now - queue.lastActivity) > THREAD_QUEUE_CLEANUP_MS) {
            threadQueues.delete(threadId);
            console.log(`🧹 Dọn queue thread ${threadId} (inactive > 5 phút)`);
        }
    }
    // Cleanup stale rate-limit Maps (entries older than 10 minutes)
    for (const [threadId, ts] of lastMessageTime.entries()) {
        if (now - ts > 10 * 60 * 1000) lastMessageTime.delete(threadId);
    }
    for (const [threadId, ts] of lastWarningTime.entries()) {
        if (now - ts > 10 * 60 * 1000) lastWarningTime.delete(threadId);
    }
    // Cleanup stale review sessions (older than 30 minutes)
    if (global.reviewSessions) {
        for (const [threadId, card] of global.reviewSessions.entries()) {
            if (card._createdAt && now - card._createdAt > 30 * 60 * 1000) {
                global.reviewSessions.delete(threadId);
            }
        }
    }
}, 60 * 1000); // Run cleanup every minute

function addToQueue(api, message) {
    const threadId = message.threadId;
    if (!threadId) return;

    if (!threadQueues.has(threadId)) {
        threadQueues.set(threadId, { items: [], processing: false, lastActivity: Date.now() });
    }

    const queue = threadQueues.get(threadId);
    queue.items.push({ message, api });
    processQueue(threadId);
}

// ---------------------------------------------------------
// MAIN MESSAGE HANDLER
// ---------------------------------------------------------
const lastMessageTime = new Map();
const lastWarningTime = new Map();

async function handleMessage(api, message) {
    const threadId = message.threadId;
    const text = message.data?.content;
    const msgType = message.type; 
    const userId = message.data?.uidFrom || threadId;
    const displayName = message.data?.dName || "bạn";

    if (typeof text !== "string") return;
    const text_lower = text.trim().toLowerCase();
    const args = text_lower.split(/\s+/);
    const command = args[0]; 

    const sendParsedMsg = async (msgText, skipSignature = false) => {
        try {
            const botCfg = config.BOT_CONFIG || { fontSize: 15, signature: "", includeSignature: false };
            if (!skipSignature && botCfg.includeSignature && botCfg.signature) {
                msgText += `\n\n<small>${botCfg.signature}</small>`;
            }
            const payload = utils.parseZaloTags(msgText, botCfg.fontSize);
            await ai.executeWithRetry("Zalo_SendMessage", () => api.sendMessage(payload, threadId, msgType), 5);
        } catch(e) { console.error("❌ Lỗi gửi tin nhắn:", e); }
    };

    // KIỂM TRA MỨC ĐỘ LIÊN QUAN
    const isGroup = message.isGroup || msgType === ThreadType.Group;
    let isRelevant = false;

    if (text_lower.startsWith("/")) {
        isRelevant = true;
    } else if (isGroup) {
        const isWcEnabled = await wordchain.isWordChainEnabled(threadId);
        if (isWcEnabled) {
            const wcMode = await wordchain.getWordChainMode(threadId);
            if (wcMode === 'vi') {
                const viSyllables = wordchain.getViSyllables(text_lower);
                if (viSyllables.length === 2 && viSyllables.every(s => s.length >= 1)) isRelevant = true;
            } else if (wcMode === 'en') {
                if (/^[a-z]+$/.test(text_lower) && text_lower.length >= 2) isRelevant = true;
            }
        }
    } else {
        isRelevant = true;
    }

    if (!isRelevant) return;

    // RATE LIMIT (THROTTLE)
    const now = Date.now();
    const lastMsgTs = lastMessageTime.get(threadId) || 0;
    if (now - lastMsgTs < 1000) {
        const lastWarnTs = lastWarningTime.get(threadId) || 0;
        if (now - lastWarnTs > 5000) {
            lastWarningTime.set(threadId, now);
            await sendParsedMsg("<red>⚠️ Vui lòng nhắn chậm lại! Bot cần 1 giây nghỉ giữa các tin nhắn.</red>");
        }
        return;
    }
    lastMessageTime.set(threadId, now);

    if (command === '/my-info') {
        return await sendParsedMsg(`👤 Thông tin của bạn:\n- User ID: ${userId}\n- Thread ID: ${threadId}`);
    }

    // --- ADMIN SYSTEM COMMANDS ---
    if (command === '/shutdown-bot' || command === '/stop-bot') {
        if (userId !== config.ADMIN_ID) return await sendParsedMsg("❌ Bạn không có quyền thực hiện lệnh này!");
        await sendParsedMsg("⚠️ <red>Tiến hành tắt máy chủ Bot Zalo theo lệnh Admin...</red>");
        console.log("⚠️ Admin đã ra lệnh force stop bot từ Zalo!");
        setTimeout(async () => {
            try { await db.pool.end(); } catch (err) {}
            process.exit(0);
        }, 1500); // Đợi 1.5s để tin nhắn kịp đẩy đi
        return;
    }

    // --- ADMIN BROADCAST COMMANDS ---
    if (command === '/broadcast') {
        if (userId !== config.ADMIN_ID) return await sendParsedMsg("❌ Bạn không có quyền thực hiện lệnh này!");
        
        let broadcastText = "";
        if (args[1] === 'update') {
            try {
                broadcastText = fs.readFileSync('./src/update_announcement.txt', 'utf8');
            } catch (e) {
                return await sendParsedMsg("❌ Không tìm thấy file thông báo: src/update_announcement.txt");
            }
        } else {
            broadcastText = text.substring(command.length).trim();
            if (!broadcastText) return await sendParsedMsg("⚠️ Cú pháp: /broadcast [nội dung] hoặc /broadcast update");
        }

        const targets = await quiz.getAllUserIds();
        pendingBroadcasts.set(userId, { messageText: broadcastText, targets: targets });

        let preview = `<b>📢 XEM TRƯỚC BẢN TIN</b>\n━━━━━━━━━━━━━━━━━━━━\n${broadcastText}\n━━━━━━━━━━━━━━━━━━━━\n👥 <b>Đối tượng:</b> ${targets.length} người dùng.\n\n👉 Gõ <b>/confirm-broadcast</b> để bắt đầu gửi.`;
        return await sendParsedMsg(preview);
    }

    if (command === '/confirm-broadcast') {
        if (userId !== config.ADMIN_ID) return await sendParsedMsg("❌ Bạn không có quyền thực hiện lệnh này!");
        if (!pendingBroadcasts.has(userId)) return await sendParsedMsg("⚠️ Không có bản tin nào đang chờ xác nhận. Hãy dùng /broadcast trước.");

        const { messageText, targets } = pendingBroadcasts.get(userId);
        pendingBroadcasts.delete(userId); // Clear state immediately to prevent double sends

        await sendParsedMsg(`🚀 <b>Bắt đầu gửi bản tin tới ${targets.length} người...</b>`);

        let successCount = 0;
        let failCount = 0;

        const botCfg = config.BOT_CONFIG || { fontSize: 15, signature: "", includeSignature: false };
        let finalBroadcastText = messageText;
        if (botCfg.includeSignature && botCfg.signature) {
            finalBroadcastText += `\n\n<small>${botCfg.signature}</small>`;
        }

        for (let i = 0; i < targets.length; i++) {
            const targetId = targets[i];
            try {
                const payload = utils.parseZaloTags(finalBroadcastText, botCfg.fontSize);
                await ai.executeWithRetry("Zalo_Broadcast", () => api.sendMessage(payload, targetId, ThreadType.User), 3);
                successCount++;
            } catch (error) {
                console.error(`❌ Lỗi gửi broadcast tới ${targetId}:`, error);
                failCount++;
            }

            // Progress update every 10 users
            if ((i + 1) % 10 === 0 || i === targets.length - 1) {
                await sendParsedMsg(`📊 <b>Tiến độ:</b> ${i + 1}/${targets.length} người...`);
            }

            if (i < targets.length - 1) await utils.sleep(2000);
        }

        return await sendParsedMsg(`🏁 <b>HOÀN THÀNH BROADCAST!</b>\n✅ Thành công: ${successCount}\n❌ Thất bại: ${failCount}`);
    }

    // --- WEREWOLF LOGIC ---
    const wwShortCmds = ['/v ', '/v\n', '/vote ', '/join', '/j ', '/j\n', '/leave', '/start', '/stop', '/cancel', '/alive', '/a ', '/a\n', '/kill ', '/k ', '/k\n', '/see ', '/guard ', '/g ', '/g\n', '/create', '/roles', '/ship '];
    const isWwCommand = text_lower.startsWith('/ww') || wwShortCmds.some(c => text_lower.startsWith(c) || text_lower === c.trim());

    if (isGroup) {
        if (isWwCommand) {
            await werewolf.handleGroupMessage(message, threadId, userId, text, displayName);
            return;
        }
        werewolf.handleGroupMessage(message, threadId, userId, text, displayName).catch(() => {});

        if (["/quiz", "/q"].includes(command)) {
            return await sendParsedMsg("<red>⚠️ Tính năng Quiz hiện chỉ hoạt động trong tin nhắn cá nhân với Bot. Hãy nhắn tin riêng cho Bot để chơi nhé!</red>");
        }

        if (["/top", "/leaderboard"].includes(command)) {
            try {
                const groupInfoResp = await api.getGroupInfo(threadId);
                const groupInfo = groupInfoResp.gridInfoMap[threadId];
                if (!groupInfo || !groupInfo.memberIds) return await sendParsedMsg("❌ Không thể lấy danh sách thành viên nhóm.");
                
                const top10 = await quiz.getGroupTop10(groupInfo.memberIds);
                if (!top10 || top10.length === 0) return await sendParsedMsg("ℹ️ Nhóm này chưa có ai tham gia Quiz!");

                let msg = "<b>🏆 BẢNG XẾP HẠNG NHÓM</b>\n━━━━━━━━━━━━━━━━━━━━\n";
                top10.forEach((u, index) => {
                    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
                    msg += `${medal} <b>${u.display_name}</b>: ${u.max_score}đ\n`;
                });
                return await sendParsedMsg(msg);
            } catch (e) {
                return await sendParsedMsg("❌ Có lỗi xảy ra khi lấy bảng xếp hạng nhóm.");
            }
        }

        if (command === "/badges") {
            try {
                const achievements = await quiz.getUserAchievements(userId);
                if (!achievements || achievements.length === 0) {
                    return await sendParsedMsg(`🏅 <b>THÀNH TỰU CỦA ${displayName.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━\n\nBạn chưa mở khóa thành tựu nào!\n👉 Chơi /quiz, /daily, /review để mở khóa.`);
                }
                let msg = `🏅 <b>THÀNH TỰU CỦA ${displayName.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
                msg += `📊 Đã mở khóa: <b>${achievements.length}/${Object.keys(quiz.ACHIEVEMENTS).length}</b>\n\n`;
                for (const a of achievements) {
                    const def = quiz.ACHIEVEMENTS[a.achievement_key];
                    if (def) msg += `${def.emoji} <b>${def.name}</b> — ${def.desc}\n`;
                }
                return await sendParsedMsg(msg);
            } catch (e) {
                console.error("❌ Lỗi lấy thành tựu:", e);
                return await sendParsedMsg("❌ Không thể tải thành tựu. Hãy thử lại sau!");
            }
        }

        // --- TENSCHOOL LIVE COMMANDS ---
        if (command === '/tenschool') {
            let isGroupAdmin = false;
            try {
                const gInfo = await api.getGroupInfo(threadId);
                const gData = gInfo.gridInfoMap[threadId];
                if (gData && gData.adminIds && gData.adminIds.includes(userId)) isGroupAdmin = true;
            } catch (e) {}
            if (userId !== config.ADMIN_ID && !isGroupAdmin) return await sendParsedMsg("❌ Bạn không có quyền Admin để dùng lệnh này!");

            const action = args[1];
            if (action === 'on') {
                await db.runQuery("INSERT INTO bot_tenschool_groups_config (group_id, enabled) VALUES (?, 1) ON DUPLICATE KEY UPDATE enabled = 1", [threadId]);
                return await sendParsedMsg("<green>✅ BẬT thông báo TenSchool Live!</green>\n\nBot sẽ tự động nhắn tag @all khi có luồng Live Stream mới.", true);
            } else if (action === 'off') {
                await db.runQuery("UPDATE bot_tenschool_groups_config SET enabled = 0 WHERE group_id = ?", [threadId]);
                return await sendParsedMsg("<red>✅ TẮT thông báo TenSchool Live.</red>", true);
            } else {
                return await sendParsedMsg(`⚠️ Cú pháp: ${command} on hoặc off`, true);
            }
        }

        // --- WORDCHAIN ADMIN COMMANDS ---
        if (["/wordchain", "/wc", "/noitu"].includes(command)) {
            let isGroupAdmin = false;
            try {
                const gInfo = await api.getGroupInfo(threadId);
                const gData = gInfo.gridInfoMap[threadId];
                if (gData && gData.adminIds && gData.adminIds.includes(userId)) isGroupAdmin = true;
            } catch (e) {}
            if (userId !== config.ADMIN_ID && !isGroupAdmin) return await sendParsedMsg("❌ Bạn không có quyền Admin để dùng lệnh này!");
            
            const isVietnamese = command === '/noitu';
            const wcModeToSet = isVietnamese ? 'vi' : 'en';
            const action = args[1];
            if (action === 'on') {
                await wordchain.setWordChainEnabled(threadId, true, wcModeToSet);
                await wordchain.clearWordChainGame(threadId);
                wordchain.voteskipMap.delete(threadId);
                wordchain.wordDefinitionCache.delete(threadId);
                if (isVietnamese) {
                    return await sendParsedMsg("<green>✅ Đã BẬT game Nối Từ Tiếng Việt trong nhóm này!</green>\n\n📖 <b>Luật chơi:</b>\n• Gõ từ 2 âm tiết (ví dụ: \"bắt đầu\")\n• Từ tiếp theo phải bắt đầu bằng âm tiết cuối của từ trước\n  VD: bắt <b>đầu</b> → <b>đầu</b> tiên → ...\n• Không nối 2 lần liên tiếp\n• Không trùng từ đã dùng\n\n⌨️ Lệnh: /nghia | /voteskip | /forceskip\n\n👉 Ai đó hãy bắt đầu bằng cách gõ 1 từ tiếng Việt 2 âm tiết!", true);
                } else {
                    return await sendParsedMsg("<green>✅ Đã BẬT game Nối Từ Tiếng Anh trong nhóm này!</green>\n\n📖 <b>Luật chơi:</b>\n• Gõ 1 từ tiếng Anh (ví dụ: hello)\n• Từ tiếp theo phải bắt đầu bằng chữ cái cuối của từ trước\n  VD: hell<b>o</b> → <b>o</b>pen → ope<b>n</b> → ...\n• Không nối 2 lần liên tiếp\n• Không trùng từ đã dùng\n\n⌨️ Lệnh: /nghia | /voteskip | /forceskip\n\n👉 Ai đó hãy bắt đầu bằng cách gõ 1 từ tiếng Anh!", true);
                }
            } else if (action === 'off') {
                await wordchain.setWordChainEnabled(threadId, false);
                await wordchain.clearWordChainGame(threadId);
                wordchain.voteskipMap.delete(threadId);
                wordchain.wordDefinitionCache.delete(threadId);
                return await sendParsedMsg("<red>✅ Đã TẮT game Nối từ trong nhóm này.</red>", true);
            } else {
                return await sendParsedMsg(`⚠️ Cú pháp: ${command} on hoặc off`, true);
            }
        }

        if (command === '/nghia') {
            const isWcOn = await wordchain.isWordChainEnabled(threadId);
            if (!isWcOn) return await sendParsedMsg("❌ Game Nối từ chưa được bật trong nhóm này!");
            const wcModeNow = await wordchain.getWordChainMode(threadId);
            const wcState = await wordchain.getWordChainState(threadId);
            if (!wcState || !wcState.current_word) return await sendParsedMsg("❌ Chưa có từ nào trong game!");
            
            const cached = wordchain.wordDefinitionCache.get(threadId);
            if (cached && cached.word === wcState.current_word && cached.definition) {
                return await sendParsedMsg(`📖 <b>Nghĩa của "${wcState.current_word}":</b>\n${cached.definition}`);
            }
            
            let lookup = wcModeNow === 'vi' ? await wordchain.lookupVietnameseWord(wcState.current_word) : await wordchain.lookupEnglishWord(wcState.current_word);
            if (lookup && lookup.valid && lookup.definition) {
                wordchain.wordDefinitionCache.set(threadId, { word: wcState.current_word, definition: lookup.definition });
                return await sendParsedMsg(`📖 <b>Nghĩa của "${wcState.current_word}":</b>\n${lookup.definition}`);
            }
            return await sendParsedMsg(`📖 Từ "${wcState.current_word}" không tìm thấy nghĩa trong từ điển.`);
        }

        if (command === '/voteskip') {
            const isWcOn = await wordchain.isWordChainEnabled(threadId);
            if (!isWcOn) return await sendParsedMsg("❌ Game Nối từ chưa được bật trong nhóm này!");
            const wcState = await wordchain.getWordChainState(threadId);
            if (!wcState || !wcState.current_word) return await sendParsedMsg("❌ Chưa có từ nào để skip!");

            if (!wordchain.voteskipMap.has(threadId)) wordchain.voteskipMap.set(threadId, new Set());
            const votes = wordchain.voteskipMap.get(threadId);
            votes.add(userId);

            try {
                const groupInfoResp = await api.getGroupInfo(threadId);
                const groupInfo = groupInfoResp.gridInfoMap[threadId];
                const totalMembers = groupInfo.totalMember || 1;
                const neededVotes = Math.ceil(totalMembers * 0.3);

                if (votes.size >= neededVotes) {
                    wordchain.voteskipMap.delete(threadId);
                    const skippedWord = wcState.current_word;
                    await wordchain.clearWordChainGame(threadId);
                    wordchain.wordDefinitionCache.delete(threadId);
                    return await sendParsedMsg(`<green>⏭️ Đã bỏ qua từ "<b>${skippedWord}</b>" (${votes.size}/${neededVotes} phiếu)</green>\n\n👉 Ai đó hãy bắt đầu lại bằng từ mới!`);
                } else {
                    return await sendParsedMsg(`🗳️ <b>${displayName}</b> đã vote skip!\n📊 Tiến độ: <b>${votes.size}/${neededVotes}</b> phiếu (cần 30% = ${neededVotes} người)`);
                }
            } catch (e) { return await sendParsedMsg("❌ Không thể lấy thông tin nhóm để tính vote."); }
        }

        if (command === '/forceskip') {
            if (userId !== config.ADMIN_ID) return await sendParsedMsg("❌ Chỉ Admin mới có quyền force skip!");
            const isWcOn = await wordchain.isWordChainEnabled(threadId);
            if (!isWcOn) return await sendParsedMsg("❌ Game Nối từ chưa được bật trong nhóm này!");
            const wcState = await wordchain.getWordChainState(threadId);
            if (!wcState || !wcState.current_word) return await sendParsedMsg("❌ Chưa có từ nào để skip!");

            const skippedWord = wcState.current_word;
            wordchain.voteskipMap.delete(threadId);
            await wordchain.clearWordChainGame(threadId);
            wordchain.wordDefinitionCache.delete(threadId);
            return await sendParsedMsg(`<green>⏭️ Admin đã force skip từ "<b>${skippedWord}</b>"!</green>\n\n👉 Hãy bắt đầu lại bằng từ mới!`);
        }

        // --- WORDCHAIN GAME LOGIC ---
        const isWcEnabled = await wordchain.isWordChainEnabled(threadId);
        if (isWcEnabled) {
            const wcMode = await wordchain.getWordChainMode(threadId);

            if (wcMode === 'vi') {
                const syllables = wordchain.getViSyllables(text_lower);
                if (syllables.length === 2) {
                    const state = await wordchain.getWordChainState(threadId);
                    if (state && state.current_word) {
                        const prevSyllables = wordchain.getViSyllables(state.current_word);
                        if (syllables[0] !== prevSyllables[prevSyllables.length - 1]) return;
                        if (userId === state.last_player_id) {
                            ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                            return await sendParsedMsg(`❌ <red>${displayName} không được nối 2 lần liên tiếp!</red>`);
                        }
                        const history = await wordchain.getWordHistory(threadId, 100);
                        if (history.includes(text_lower)) {
                            ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                            return await sendParsedMsg(`❌ <red>Từ "${text_lower}" đã được sử dụng!</red>`);
                        }
                    }
                    const isValid = await wordchain.isValidVietnameseWord(text_lower);
                    if (!isValid) {
                        ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                        return await sendParsedMsg(`❌ <red>"${text_lower}" không có trong từ điển!</red>`);
                    }
                    wordchain.lookupVietnameseWord(text_lower).then(lookup => {
                        if (lookup && lookup.valid && lookup.definition) wordchain.wordDefinitionCache.set(threadId, { word: text_lower, definition: lookup.definition });
                    }).catch(()=>{});
                    await ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(()=>{});
                    await wordchain.updateWordChainState(threadId, text_lower, userId);
                    await wordchain.addWordHistory(threadId, text_lower);
                    wordchain.voteskipMap.delete(threadId);
                    if (!state || !state.current_word) await sendParsedMsg(`<green>🎮 Bắt đầu: <b>${text_lower}</b></green>\n👉 Tiếp theo bắt đầu bằng: <b>${syllables[1]}</b>`);
                    
                    const history = await wordchain.getWordHistory(threadId, 100);
                    const deadEndCheck = await wordchain.checkWordChainDeadEnd(syllables[1], history);
                    if (deadEndCheck.isDeadEnd) {
                        await wordchain.clearWordChainGame(threadId);
                        wordchain.wordDefinitionCache.delete(threadId);
                        await sendParsedMsg(`<red>⚠️ Hết từ! Không còn từ nào bắt đầu bằng "<b>${syllables[1]}</b>".</red>\n<green>🔄 Game đã reset!</green>`);
                    }
                    return; 
                }
            } else if (wcMode === 'en') {
                if (/^[a-z]+$/.test(text_lower) && text_lower.length >= 2) {
                    const state = await wordchain.getWordChainState(threadId);
                    if (state && state.current_word) {
                        if (!text_lower.startsWith(state.current_word.slice(-1))) return;
                        if (userId === state.last_player_id) {
                            ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                            return await sendParsedMsg(`❌ <red>${displayName} không được nối 2 lần liên tiếp!</red>`);
                        }
                        const history = await wordchain.getWordHistory(threadId, 200);
                        if (history.includes(text_lower)) {
                            ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                            return await sendParsedMsg(`❌ <red>Từ "${text_lower}" đã được sử dụng!</red>`);
                        }
                    }
                    const isValid = await wordchain.isValidEnglishWord(text_lower);
                    if (!isValid) {
                        ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                        return await sendParsedMsg(`❌ <red>"${text_lower}" không hợp lệ!</red>`);
                    }
                    wordchain.lookupEnglishWord(text_lower).then(lookup => {
                        if (lookup && lookup.valid && lookup.definition) wordchain.wordDefinitionCache.set(threadId, { word: text_lower, definition: lookup.definition });
                    }).catch(()=>{});
                    await ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(()=>{});
                    await wordchain.updateWordChainState(threadId, text_lower, userId);
                    await wordchain.addWordHistory(threadId, text_lower);
                    wordchain.voteskipMap.delete(threadId);
                    if (!state || !state.current_word) await sendParsedMsg(`<green>🎮 Started: <b>${text_lower}</b></green>\n👉 Next starts with: <b>${text_lower.slice(-1).toUpperCase()}</b>`);
                    return; 
                }
            }
        }
        return; 
    }

    // --- PRIVATE MESSAGE (QUIZ & WEREWOLF) ---
    if (!isGroup && (text_lower.startsWith('/ww') || isWwCommand)) {
        await werewolf.handlePrivateMessage(message, userId, text);
        return;
    }

    // ---------------------------------------------------------
    // REVIEW MODE SESSIONS
    // ---------------------------------------------------------
    if (!global.reviewSessions) global.reviewSessions = new Map();

    const formatQuestionString = (q, score, userLvl, isReview = false) => {
        const typeNames = { "stress": "🔊 Trọng âm", "word stress": "🔊 Trọng âm", "vocabulary": "📚 Từ vựng", "vocabulary context": "📚 Từ vựng", "pronunciation": "🗣️ Phát âm", "pronunciation difference": "🗣️ Phát âm", "word form": "📝 Chia dạng từ" };
        const typeName = typeNames[q.type] || "📝 Bài tập";
        const o = q.options; 
        const badge = quiz.getLevelBadge(userLvl);
        
        let header = isReview 
            ? `<b>🗂️ CHẾ ĐỘ ÔN TẬP (FLASHCARD)</b>\n━━━━━━━━━━━━━━━━━━━━`
            : `<b>━━━━━━━━━━━━━━━━━━━━\n📌 Dạng: ${typeName}\n⭐ Điểm: ${score} | Mức: ${userLvl} ${badge}\n━━━━━━━━━━━━━━━━━━━━</b>`;
            
        return `${header}\n\n❓ ${q.question}\n\n   A. ${o.A}\n   B. ${o.B}\n   C. ${o.C}\n   D. ${o.D}\n\n✏️ Gõ A, B, C hoặc D để trả lời`;
    };

    const sendCorrectFeedback = async (displayName, answer, explanation, score, isNewRecord, streak) => {
        const recordTag = isNewRecord ? "\n<green>✨ <b>CHÚC MỪNG! BẠN VỪA PHÁ KỶ LỤC CỦA CHÍNH MÌNH!</b> ✨</green>" : "";
        const strkE = quiz.getStreakEmoji(streak);
        const msg = `<green>✨ <b>CHÍNH XÁC TUYỆT ĐỐI!</b> ✨</green>
━━━━━━━━━━━━━━━━━━━━
🎁 <b>Phần thưởng:</b> +1đ | 🔥 <b>Chuỗi:</b> ${streak} ${strkE}
📖 <b>Giải thích:</b> ${explanation}${recordTag}
⭐ <b>Tổng điểm:</b> ${score}`;
        return await sendParsedMsg(msg);
    };

    const sendIncorrectFeedback = async (displayName, correctAnswer, explanation, score) => {
        const msg = `<red>❌ <b>TIẾC QUÁ, SAI MẤT RỒI...</b></red>
━━━━━━━━━━━━━━━━━━━━
💡 <b>Đáp án đúng là:</b> <b>${correctAnswer}</b>
📖 <b>Giải thích:</b> ${explanation}
📝 <i>Câu này đã được lưu vào <b>/review</b> để bạn ôn lại!</i>
📊 <b>Điểm hiện tại:</b> ${score}`;
        return await sendParsedMsg(msg);
    };

    let user = await quiz.getUserInfo(userId);
    if (!user) { await quiz.upsertUser(userId, displayName); user = await quiz.getUserInfo(userId); }
    const currentLevel = user ? user.level : 'B1';
    const currentMode = (user && user.mode) ? user.mode : 'random';

    if (text_lower.startsWith("/")) {
        if (["/quiz", "/q"].includes(command)) {
            global.reviewSessions.delete(threadId);
            let session = await quiz.getSession(threadId);
            let current_score = session ? session.current_score : 0;
            if (session && session.question_data) return await sendParsedMsg("⚠️ Bạn còn câu hỏi chưa trả lời!\n\n" + formatQuestionString(session.question_data, current_score, currentLevel));
            if (!quiz.prefetchQueue.has(threadId) || quiz.prefetchQueue.get(threadId).queue.length === 0) await sendParsedMsg(`🤖 Đang chuẩn bị câu hỏi bằng AI (${currentLevel}), chờ xíu...`);
            const q = await quiz.getPrefetchedQuestion(threadId, currentLevel, currentMode);
            if (!q) return await sendParsedMsg("<red>❌ Máy chủ AI bận. Thử lại sau vài giây nhé!</red>");
            await quiz.saveSession(threadId, current_score, q); await quiz.saveKeyword(threadId, q.keyword || q.question.substring(0, 30));
            return await sendParsedMsg(formatQuestionString(q, current_score, currentLevel));
        } 
        else if (command === "/review") {
            if (isGroup) return await sendParsedMsg("❌ Chế độ Review chỉ hoạt động trong tin nhắn riêng!");
            const card = await quiz.getReviewCard(userId);
            if (!card) {
                return await sendParsedMsg("✨ <b>TUYỆT VỜI!</b>\nBạn không có câu hỏi nào cần ôn tập cả. Hãy tiếp tục chơi /quiz nhé!");
            }
            const count = await quiz.getReviewCount(userId);
            card._createdAt = Date.now();
            global.reviewSessions.set(threadId, card);
            let msg = `🗂️ <b>CHẾ ĐỘ ÔN TẬP (FLASHCARD)</b>\n━━━━━━━━━━━━━━━━━━━━\nBạn còn <b>${count}</b> câu cần chinh phục.\n\n` + formatQuestionString(card.question, 0, currentLevel, true);
            return await sendParsedMsg(msg);
        }
        else if (["/level", "/l"].includes(command)) {
            const newLevel = args[1] ? args[1].toUpperCase() : ''; const validLevels =['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
            if (!validLevels.includes(newLevel)) return await sendParsedMsg(`⚠️ Chọn đúng: A1-C2`);
            await quiz.changeLevel(userId, newLevel); quiz.triggerPrefetch(threadId, newLevel, currentMode); 
            return await sendParsedMsg(`<green>✅ Đã cập nhật trình độ lên: ${newLevel}.</green>`);
        }
        else if (["/mode", "/m"].includes(command)) {
            const modeMap = { 'random': 'random', 'tuvung': 'vocabulary context', 'trongam': 'word stress', 'phatam': 'pronunciation difference', 'wordform': 'word form' };
            const newModeKey = args[1] ? args[1].toLowerCase() : '';
            if (!modeMap[newModeKey]) return await sendParsedMsg(`⚠️ Chọn đúng chế độ: random, tuvung, trongam, phatam, wordform`);
            const actualMode = modeMap[newModeKey]; await quiz.changeMode(userId, actualMode); quiz.triggerPrefetch(threadId, currentLevel, actualMode); 
            return await sendParsedMsg(`<green>✅ Đã cập nhật chế độ thành công!</green>`);
        }
        else if (["/score", "/s"].includes(command)) {
            const session = await quiz.getSession(threadId); const live_score = session ? session.current_score : 0;
            const accuracy = user.total_questions > 0 ? Math.round((user.correct_answers / user.total_questions) * 100) : 0;
            const rank = quiz.getRankTitle(user.max_score); const badge = quiz.getLevelBadge(user.level); const strkEmoji = quiz.getStreakEmoji(user.current_streak);
            return await sendParsedMsg(`<b>BẢNG ĐIỂM ${displayName}</b>\n🔰 Rank: ${rank}\n🏅 Level: ${user.level} ${badge}\n🏆 Kỷ lục: ${user.max_score}\n🔥 Chuỗi: ${user.current_streak} ${strkEmoji}\n🎯 Tỷ lệ: ${accuracy}%`);
        }
        else if (["/top", "/leaderboard"].includes(command)) {
            const top10 = await quiz.getGlobalTop10();
            let msg = "<b>🌍 BẢNG XẾP HẠNG TOÀN CẦU</b>\n━━━━━━━━━━━━━━━━━━━━\n";
            top10.forEach((u, index) => {
                const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
                msg += `${medal} <b>${u.display_name}</b>: ${u.max_score}đ\n`;
            });
            return await sendParsedMsg(msg);
        }
        else if (command === "/stats") {
            const stats = await quiz.getUserStats(userId);
            if (!stats) return await sendParsedMsg("ℹ️ Bạn chưa chơi đủ số câu để có thống kê chi tiết!");
            const { accuracy, trend } = stats;
            const trendIcon = trend.diff > 0 ? "📈" : trend.diff < 0 ? "📉" : "📊";
            const diffText = trend.diff > 0 ? `+${trend.diff}` : `${trend.diff}`;
            let msg = `<b>📊 THỐNG KÊ CHI TIẾT CỦA ${displayName.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
            msg += `🔊 Trọng âm: ${accuracy.stress}%\n`;
            msg += `🗣️ Phát âm: ${accuracy.pronunciation}%\n`;
            msg += `📚 Từ vựng: ${accuracy.vocab}%\n`;
            msg += `📝 Chia từ: ${accuracy.wordForm}%\n`;
            msg += `━━━━━━━━━━━━━━━━━━━━\n`;
            msg += `🎯 Tỷ lệ trọn đời: ${trend.lifetime}%\n`;
            msg += `🔥 Tỷ lệ gần đây (20 câu): ${trend.recent}%\n`;
            msg += `${trendIcon} Xu hướng: ${diffText}% (so với trọn đời)`;
            return await sendParsedMsg(msg);
        }
        else if (command === "/hint") {
            const hintMsg = await quiz.useHint(threadId);
            return await sendParsedMsg(hintMsg);
        }
        else if (command === "/badges") {
            try {
                const achievements = await quiz.getUserAchievements(userId);
                if (!achievements || achievements.length === 0) {
                    return await sendParsedMsg(`🏅 <b>THÀNH TỰU CỦA ${displayName.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━\n\nBạn chưa mở khóa thành tựu nào!\n👉 Chơi /quiz, /daily, /review để mở khóa.`);
                }
                let msg = `🏅 <b>THÀNH TỰU CỦA ${displayName.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
                msg += `📊 Đã mở khóa: <b>${achievements.length}/${Object.keys(quiz.ACHIEVEMENTS).length}</b>\n\n`;
                for (const a of achievements) {
                    const def = quiz.ACHIEVEMENTS[a.achievement_key];
                    if (def) msg += `${def.emoji} <b>${def.name}</b> — ${def.desc}\n`;
                }
                return await sendParsedMsg(msg);
            } catch (e) {
                console.error("❌ Lỗi lấy thành tựu:", e);
                return await sendParsedMsg("❌ Không thể tải thành tựu. Hãy thử lại sau!");
            }
        }
        else if (command === "/daily") {
            global.reviewSessions.delete(threadId);
            const today = new Date().toISOString().split('T')[0];
            const dailyQuestions = await quiz.getDailyQuestions(threadId);
            if (!dailyQuestions || dailyQuestions.length === 0) return await sendParsedMsg("❌ Không thể khởi tạo thử thách hàng ngày. Thử lại sau!");
            let dailySession = await quiz.getDailySession(userId, today);
            if (dailySession && dailySession.is_completed === 1) {
                return await sendParsedMsg(`✅ Bạn đã hoàn thành thử thách hôm nay rồi!\n🏆 Điểm của bạn: <b>${dailySession.score}/10</b>\n👉 Hãy quay lại vào ngày mai nhé!`);
            }
            if (!dailySession) {
                await quiz.updateDailySession(userId, today, 0, 0, false);
                dailySession = { score: 0, current_index: 0 };
            }
            const q = dailyQuestions[dailySession.current_index];
            return await sendParsedMsg(`🔥 <b>BẮT ĐẦU THỬ THÁCH HÀNG NGÀY (10 CÂU)</b>\n\n📌 Câu hỏi ${dailySession.current_index + 1}/10\n\n` + formatQuestionString(q, dailySession.score, currentLevel));
        }
        else if (["/help", "/h"].includes(command)) {
            const helpMsg = `<b>🌟 HƯỚNG DẪN SỬ DỤNG BOT 🌟</b>
━━━━━━━━━━━━━━━━━━━━

<b>📚 CHINH PHỤC TIẾNG ANH (QUIZ)</b>
🔹 <b>/quiz</b> (hoặc <b>/q</b>): Nhận 1 câu hỏi mới.
🔹 <b>/daily</b>: Thử thách 10 câu hàng ngày.
🔹 <b>/review</b>: Ôn lại những câu bạn làm sai. (MỚI ✨)
🔹 <b>/hint</b>: Nhận gợi ý (tốn 2đ).
🔹 <b>/level [A1-C2]</b>: Đổi trình độ (VD: /level B2).
🔹 <b>/mode [tên]</b>: Đổi dạng bài (random, tuvung, trongam, phatam, wordform).
🔹 <b>/reset</b> (hoặc <b>/r</b>): Hủy câu hiện tại.

<b>🎮 GAME NỐI TỪ (WORD CHAIN)</b>
🔹 <b>/noitu on/off</b>: Bật/tắt Nối từ Tiếng Việt.
🔹 <b>/wc on/off</b>: Bật/tắt Nối từ Tiếng Anh.
🔹 <b>/nghia</b>: Xem giải nghĩa từ hiện tại.
🔹 <b>/voteskip</b>: Vote bỏ qua từ khó.

<b>🐺 GAME MA SÓI (WEREWOLF)</b>
🔹 <b>/ww create</b>: Tạo phòng chơi mới.
🔹 <b>/j</b> (hoặc <b>/join</b>): Tham gia vào phòng.
🔹 <b>/start</b>: Bắt đầu trò chơi.

<b>📊 THỐNG KÊ & XẾP HẠNG</b>
🔹 <b>/score</b> (hoặc <b>/s</b>): Xem hồ sơ & chuỗi thắng.
🔹 <b>/stats</b>: Thống kê tỉ lệ đúng chi tiết.
🔹 <b>/top</b>: Bảng xếp hạng 10 "siêu nhân".
🔹 <b>/badges</b>: Xem thành tựu đã mở khóa.

<small>Chúc bạn học tập và giải trí vui vẻ! ❤️</small>`;
            return await sendParsedMsg(helpMsg);
        }
        else if (["/reset", "/r"].includes(command)) {
            global.reviewSessions.delete(threadId);
            const session = await quiz.getSession(threadId);
            if (session) { 
                const qType = session.question_data ? session.question_data.type : 'unknown';
                await quiz.updateUserAnswerStats(userId, false, session.current_score, qType, session.question_data); 
                await quiz.endSession(threadId); quiz.triggerPrefetch(threadId, currentLevel, currentMode); 
                return await sendParsedMsg(`🔄 Đã reset!`); 
            }
            return await sendParsedMsg("ℹ️ Không có session nào.");
        }
        return await sendParsedMsg("❓ Lệnh không hợp lệ.");
    }

    if (["a", "b", "c", "d"].includes(text_lower)) {
        // --- REVIEW MODE HANDLING ---
        if (global.reviewSessions.has(threadId)) {
            const card = global.reviewSessions.get(threadId);
            const q = card.question;
            const answer = text_lower.toUpperCase();
            const correct = q.correct.toUpperCase().trim();
            
            if (answer === correct) {
                ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(()=>{});
                await quiz.markReviewCorrect(card.id);
                global.reviewSessions.delete(threadId);
                // Check review achievements
                const reviewBadges = await quiz.checkReviewAchievements(userId);
                const badgeMsg = quiz.formatNewBadges(reviewBadges);
                await sendParsedMsg(`<green>✨ <b>XUẤT SẮC!</b> Bạn đã thuộc câu này.</green>\n📖 Giải thích: ${q.explanation}\n\n👉 Gõ <b>/review</b> để tiếp tục ôn tập.${badgeMsg}`);
            } else {
                ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                await sendParsedMsg(`<red>❌ <b>VẪN CHƯA ĐÚNG RỒI...</b></red>\n💡 Đáp án đúng là: <b>${correct}</b>\n📖 Giải thích: ${q.explanation}\n\n<i>Đừng nản chí, hãy thử lại câu khác nhé!</i>\n👉 Gõ <b>/review</b> để tiếp tục.`);
                global.reviewSessions.delete(threadId);
            }
            return;
        }

        // --- DAILY CHALLENGE HANDLING ---
        const today = new Date().toISOString().split('T')[0];
        const dailySession = await quiz.getDailySession(userId, today);
        if (dailySession && dailySession.is_completed === 0) {
            const dailyQuestions = await quiz.getDailyQuestions(threadId);
            if (dailyQuestions && dailyQuestions[dailySession.current_index]) {
                const q = dailyQuestions[dailySession.current_index];
                const answer = text_lower.toUpperCase();
                const correct = q.correct.toUpperCase().trim();
                
                let isCorrect = (answer === correct);
                let newScore = dailySession.score + (isCorrect ? 1 : 0);
                let nextIndex = dailySession.current_index + 1;
                let isCompleted = (nextIndex >= dailyQuestions.length);
                
                await quiz.updateDailySession(userId, today, newScore, nextIndex, isCompleted);
                
                if (isCorrect) {
                    ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(()=>{});
                    await sendCorrectFeedback(displayName, answer, q.explanation, newScore, false, 0);
                } else {
                    ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                    await quiz.recordAnswer(userId, q.type, false, q);
                    await sendIncorrectFeedback(displayName, correct, q.explanation, newScore);
                }

                if (isCompleted) {
                    // Check daily achievements
                    const dailyBadges = await quiz.checkDailyAchievements(userId, newScore, dailyQuestions.length);
                    const badgeMsg = quiz.formatNewBadges(dailyBadges);
                    return await sendParsedMsg(`🏁 <b>HOÀN THÀNH THỬ THÁCH NGÀY!</b>\n🏆 Tổng điểm của bạn: <b>${newScore}/${dailyQuestions.length}</b>\n👉 Hãy quay lại vào ngày mai nhé!${badgeMsg}`);
                } else {
                    const nextQ = dailyQuestions[nextIndex];
                    return await sendParsedMsg(`🔥 <b>Câu hỏi ${nextIndex + 1}:</b>\n\n` + formatQuestionString(nextQ, newScore, currentLevel));
                }
            }
        }

        // --- REGULAR QUIZ HANDLING ---
        const session = await quiz.getSession(threadId);
        if (!session || !session.question_data) return await sendParsedMsg(`❓ Gõ /quiz để bắt đầu nhé!`);
        const q = session.question_data; const current_score = session.current_score;
        let correct = q.correct.toUpperCase().trim();
        const answer = text_lower.toUpperCase();
        if (answer === correct) {
            ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(()=>{});
            const stats = await quiz.updateUserAnswerStats(userId, true, current_score, q.type, q); await quiz.saveSession(threadId, stats.newScore, null);
            await sendCorrectFeedback(displayName, answer, q.explanation, stats.newScore, stats.isNewRecord, stats.current_streak);

            // Check achievements
            const updatedUser = await quiz.getUserInfo(userId);
            if (updatedUser) {
                const newBadges = await quiz.checkAndAwardAchievements(userId, updatedUser);
                const badgeMsg = quiz.formatNewBadges(newBadges);
                if (badgeMsg) await sendParsedMsg(badgeMsg);
            }

            const nextQ = await quiz.getPrefetchedQuestion(threadId, currentLevel, currentMode);
            if (nextQ) {
                await quiz.saveSession(threadId, stats.newScore, nextQ); await quiz.saveKeyword(threadId, nextQ.keyword || nextQ.question.substring(0, 30));
                await sendParsedMsg(formatQuestionString(nextQ, stats.newScore, currentLevel));
            }
        } else {
            ai.executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
            const stats = await quiz.updateUserAnswerStats(userId, false, current_score, q.type, q); await quiz.endSession(threadId);
            await sendIncorrectFeedback(displayName, correct, q.explanation, current_score);
            quiz.triggerPrefetch(threadId, currentLevel, currentMode); 
        }
    } else {
        const session = await quiz.getSession(threadId);
        if (session && session.question_data) await sendParsedMsg(`<red>⚠️ Vui lòng chỉ gõ A, B, C hoặc D!</red>`);
        else await sendParsedMsg(`👋 Chào <b>${displayName}</b>! Gõ /quiz để chơi.`);
    }
}

// ---------------------------------------------------------
// RECONNECT LOGIC WITH EXPONENTIAL BACKOFF
// ---------------------------------------------------------
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000; // Max 60s

async function startBot() {
    try {
        await db.initDB();

        let cookieData = config.ZALO.cookie;
        try { if (typeof cookieData === 'string' && cookieData.trim().startsWith('[')) cookieData = JSON.parse(cookieData); } catch (e) {}

        const credentials = {
            cookie: cookieData, imei: config.ZALO.imei,
            userAgent: config.ZALO.userAgent
        };

        const zalo = new Zalo({ selfListen: false, checkUpdate: true, logging: true });
        const api = await zalo.login(credentials);
        console.log("✅ Đăng nhập Zalo Bot thành công!");
        reconnectAttempts = 0;

        werewolf.init(api, db.runQuery, db.getQuery, db.allQuery);
        tenschoolLive.startPolling(api, db);
        api.listener.start();

        api.listener.on('message', (message) => addToQueue(api, message));

        api.listener.on('reaction', async (reactionEvent) => {
            try { await werewolf.handleReaction(reactionEvent); } catch (e) {}
        });

        api.listener.on('closed', () => {
            console.error("⚠️ Listener bị đóng! Đang thử kết nối lại...");
            scheduleReconnect();
        });

        api.listener.on('error', (err) => {
            console.error("❌ Listener bị lỗi:", err);
            scheduleReconnect();
        });

    } catch (error) {
        console.error("❌ Lỗi khởi động Bot:", error.message);
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`❌ Đạt tối đa ${MAX_RECONNECT_ATTEMPTS} lần thử kết nối. Dừng lại!`);
        return;
    }

    reconnectAttempts++;
    // Exponential backoff with jitter: base * 2^attempts + random 0-500ms
    const baseDelay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    const jitter = Math.floor(Math.random() * 500);
    const delay = baseDelay + jitter;

    console.log(`⏳ Thử kết nối lại sau ${delay/1000}s (Lần ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(startBot, delay);
}

const shutdown = async () => {
    console.log("\n⚠️ Đang tắt Bot...");
    try { await db.pool.end(); } catch (err) {}
    process.exit(0);
};
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); 

startBot();
