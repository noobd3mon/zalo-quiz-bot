require('dotenv').config();
const { Zalo, TextStyle, ThreadType, Reactions } = require('zca-js');
const { OpenAI } = require('openai');
const mysql = require('mysql2/promise');
const werewolf = require('./werewolf/index.js');

// ---------------------------------------------------------
// 0. CƠ CHẾ XOAY VÒNG API KEYS & MODEL (CHỐNG RATE LIMIT)
// ---------------------------------------------------------
const API_KEYS = (process.env.GROQ_API_KEYS || "YOUR_GROQ_API_KEY").split(',').map(k => k.trim());
let currentKeyIndex = 0;
const AI_MODEL = "openai/gpt-oss-120b"; 

// THIẾT LẬP ID ADMIN Ở ĐÂY HOẶC TRONG .ENV
const ADMIN_ID = process.env.ADMIN_ID || "YOUR_ADMIN_ID"; 

function getOpenAIClient() {
    return new OpenAI({
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: API_KEYS[currentKeyIndex],
    });
}

function rotateApiKey() {
    currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
    console.warn(`🔄[API Key] Đã xoay tua sang API Key thứ ${currentKeyIndex + 1}/${API_KEYS.length}`);
}

async function executeWithRetry(actionName, actionFn, maxRetries = 5) {
    let delay = 1500;
    for (let i = 1; i <= maxRetries; i++) {
        try {
            return await actionFn();
        } catch (error) {
            if (error.status === 429 || error.status === 401 || (error.message && error.message.includes('429'))) {
                console.warn(`⚠️[${actionName}] Lỗi Rate Limit/Auth. Đang đổi API Key...`);
                rotateApiKey();
            }

            if (i === maxRetries) {
                console.error(`❌[${actionName}] Thất bại hoàn toàn sau ${maxRetries} lần thử:`, error.message);
                throw error;
            }
            console.warn(`⏳ [${actionName}] Thử lại lần ${i}/${maxRetries} sau ${delay}ms... (${error.message})`);
            await new Promise(res => setTimeout(res, delay));
            delay *= 1.5;
        }
    }
}

// ---------------------------------------------------------
// 1. CẤU HÌNH DATABASE MYSQL
// ---------------------------------------------------------
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

pool.getConnection()
    .then(() => console.log("✅ Đã kết nối cơ sở dữ liệu MySQL thành công!"))
    .catch((err) => console.error("❌ Lỗi kết nối MySQL:", err.message));

const runQuery = async (query, params = []) => { const [result] = await pool.execute(query, params); return result; };
const getQuery = async (query, params =[]) => { const [rows] = await pool.execute(query, params); return rows[0] || null; };
const allQuery = async (query, params = []) => { const [rows] = await pool.execute(query, params); return rows; };

async function initDB() {
    // Tables cho Quiz AI
    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_user_scores (
            chat_id         VARCHAR(255) PRIMARY KEY,
            display_name    VARCHAR(255) DEFAULT 'Nguoi dung',
            max_score       INT DEFAULT 0,
            total_games     INT DEFAULT 0,
            last_played     DATETIME,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            level           VARCHAR(10) DEFAULT 'B1',
            current_streak  INT DEFAULT 0,
            best_streak     INT DEFAULT 0,
            correct_answers INT DEFAULT 0,
            total_questions INT DEFAULT 0,
            mode            VARCHAR(50) DEFAULT 'random'
        )
    `);

    try { await runQuery("ALTER TABLE bot_user_scores ADD COLUMN mode VARCHAR(50) DEFAULT 'random'"); } catch (error) {}

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_quiz_sessions (
            chat_id       VARCHAR(255) PRIMARY KEY,
            current_score INT DEFAULT 0,
            question_data TEXT,
            is_active     TINYINT DEFAULT 1,
            started_at    DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_question_history (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            chat_id     VARCHAR(255),
            keyword     VARCHAR(255),
            answered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ==========================================
    // TẠO TABLES CHO GAME NỐI TỪ (WORD CHAIN)
    // ==========================================
    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_group_settings (
            group_id VARCHAR(255) PRIMARY KEY,
            wordchain_enabled TINYINT DEFAULT 0,
            wordchain_mode VARCHAR(10) DEFAULT 'vi'
        )
    `);

    try { await runQuery("ALTER TABLE bot_group_settings ADD COLUMN wordchain_mode VARCHAR(10) DEFAULT 'vi'"); } catch (e) {}

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_wordchain_state (
            group_id VARCHAR(255) PRIMARY KEY,
            current_word VARCHAR(255),
            last_player_id VARCHAR(255)
        )
    `);

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_wordchain_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id VARCHAR(255),
            word VARCHAR(255),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Convert tất cả bảng sang UTF8MB4 để hỗ trợ tiếng Việt
    const tablesToConvert = [
        'bot_user_scores', 'bot_quiz_sessions', 'bot_question_history',
        'bot_group_settings', 'bot_wordchain_state', 'bot_wordchain_history'
    ];
    for (const table of tablesToConvert) {
        try { await runQuery(`ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch (e) {}
    }
}

// ---------------------------------------------------------
// 2. HELPER CƠ SỞ DỮ LIỆU & LOGIC TRÒ CHƠI NỐI TỪ
// ---------------------------------------------------------
function getCurrentTime() { return new Date().toISOString().replace('T', ' ').substring(0, 19); }

// --- Helpers Quiz AI ---
async function upsertUser(userId, displayName = "Nguoi dung") { await runQuery(`INSERT INTO bot_user_scores (chat_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,[userId, displayName]); }
async function getUserInfo(userId) { return await getQuery("SELECT * FROM bot_user_scores WHERE chat_id = ?",[userId]); }
async function changeLevel(userId, level) { await runQuery("UPDATE bot_user_scores SET level = ? WHERE chat_id = ?",[level, userId]); }
async function changeMode(userId, mode) { await runQuery("UPDATE bot_user_scores SET mode = ? WHERE chat_id = ?",[mode, userId]); }

async function updateUserAnswerStats(userId, isCorrect, sessionScoreBefore) {
    const user = await getUserInfo(userId);
    if (!user) return null;
    let { max_score, current_streak, best_streak, total_questions, correct_answers, total_games } = user;
    total_questions += 1;
    let isNewRecord = false;
    let newScore = sessionScoreBefore;
    
    if (isCorrect) {
        correct_answers += 1;
        current_streak += 1;
        if (current_streak > best_streak) best_streak = current_streak;
        newScore = sessionScoreBefore + 1;
        if (newScore > max_score) { max_score = newScore; isNewRecord = true; }
    } else { current_streak = 0; total_games += 1; }
    
    await runQuery(`UPDATE bot_user_scores SET max_score = ?, current_streak = ?, best_streak = ?, total_questions = ?, correct_answers = ?, total_games = ?, last_played = ? WHERE chat_id = ?`,[max_score, current_streak, best_streak, total_questions, correct_answers, total_games, getCurrentTime(), userId]);
    return { isNewRecord, newScore, current_streak, max_score };
}

async function getSession(threadId) {
    const row = await getQuery("SELECT chat_id, current_score, question_data, is_active FROM bot_quiz_sessions WHERE chat_id = ? AND is_active = 1",[threadId]);
    return row ? { ...row, question_data: row.question_data ? JSON.parse(row.question_data) : null } : null;
}
async function saveSession(threadId, currentScore, questionData) { await runQuery(`INSERT INTO bot_quiz_sessions (chat_id, current_score, question_data, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE current_score = VALUES(current_score), question_data = VALUES(question_data), is_active = 1`,[threadId, currentScore, JSON.stringify(questionData)]); }
async function endSession(threadId) { await runQuery("UPDATE bot_quiz_sessions SET is_active = 0 WHERE chat_id = ?", [threadId]); }
async function getRecentKeywords(threadId, limit = 20) { const rows = await allQuery("SELECT keyword FROM bot_question_history WHERE chat_id = ? ORDER BY answered_at DESC LIMIT ?",[threadId, limit]); return rows.map(r => r.keyword); }
async function saveKeyword(threadId, keyword) { await runQuery("INSERT INTO bot_question_history (chat_id, keyword) VALUES (?, ?)", [threadId, keyword]); }

const getLevelBadge = (lvl) => { const map = { 'A1': '🌱', 'A2': '🌿', 'B1': '🌳', 'B2': '🔥', 'C1': '💎', 'C2': '👑' }; return map[lvl] || '🌳'; };
const getRankTitle = (score) => score >= 500 ? "Grand Master 🐲" : score >= 200 ? "Master 🦁" : score >= 100 ? "Advanced 🐯" : score >= 50 ? "Intermediate 🐺" : score >= 10 ? "Beginner 🦊" : "Novice 🐰";
const getStreakEmoji = (streak) => streak >= 10 ? "🔥🔥🔥" : streak >= 5 ? "🔥🔥" : streak >= 3 ? "🔥" : "⚡";

// --- Helpers GAME NỐI TỪ ---
async function isWordChainEnabled(groupId) {
    const row = await getQuery("SELECT wordchain_enabled FROM bot_group_settings WHERE group_id = ?", [groupId]);
    return row ? row.wordchain_enabled === 1 : false;
}
async function getWordChainMode(groupId) {
    const row = await getQuery("SELECT wordchain_mode FROM bot_group_settings WHERE group_id = ?", [groupId]);
    return row ? (row.wordchain_mode || 'vi') : 'vi';
}
async function setWordChainEnabled(groupId, isEnabled, mode = 'vi') {
    await runQuery("INSERT INTO bot_group_settings (group_id, wordchain_enabled, wordchain_mode) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE wordchain_enabled = VALUES(wordchain_enabled), wordchain_mode = VALUES(wordchain_mode)", [groupId, isEnabled ? 1 : 0, mode]);
}
async function getWordChainState(groupId) {
    return await getQuery("SELECT * FROM bot_wordchain_state WHERE group_id = ?", [groupId]);
}
async function updateWordChainState(groupId, word, playerId) {
    await runQuery("INSERT INTO bot_wordchain_state (group_id, current_word, last_player_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE current_word = VALUES(current_word), last_player_id = VALUES(last_player_id)", [groupId, word, playerId]);
}
async function getWordHistory(groupId, limit = 100) {
    const rows = await allQuery("SELECT word FROM bot_wordchain_history WHERE group_id = ? ORDER BY id DESC LIMIT ?", [groupId, limit]);
    return rows.map(r => r.word);
}
async function addWordHistory(groupId, word) {
    await runQuery("INSERT INTO bot_wordchain_history (group_id, word) VALUES (?, ?)",[groupId, word]);
}
async function clearWordChainGame(groupId) {
    await runQuery("DELETE FROM bot_wordchain_state WHERE group_id = ?", [groupId]);
    await runQuery("DELETE FROM bot_wordchain_history WHERE group_id = ?", [groupId]);
}
// --- Vietnamese Word Lookup via tratu.soha.vn API ---
const SOHA_HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "vi,en;q=0.9",
    "cache-control": "no-cache",
    "pragma": "no-cache",
};

// Check if a Vietnamese word exists via tratu.soha.vn search (302 = exists)
async function lookupVietnameseWord(word) {
    try {
        const searchUrl = `http://tratu.soha.vn/index.php?search=${encodeURIComponent(word)}&dict=vn_vn&btnSearch=&chuyennganh=&tenchuyennganh=`;
        const res = await fetch(searchUrl, {
            method: "GET",
            headers: SOHA_HEADERS,
            redirect: "manual"
        });
        
        const wordExists = res.status === 302 || res.status === 301;
        
        let definition = null;
        if (wordExists) {
            // Fetch definition via curl_suggest API
            definition = await getVietnameseWordMeaning(word);
        }
        
        return { valid: wordExists, definition };
    } catch (e) {
        console.error("Lỗi tratu.soha.vn API:", e.message);
        return { valid: false, definition: null };
    }
}

// Get Vietnamese word meaning via curl_suggest API (returns XML)
async function getVietnameseWordMeaning(word) {
    try {
        const suggestUrl = `http://tratu.soha.vn/extensions/curl_suggest.php?search=${encodeURIComponent(word)}&dict=vn_vn`;
        const res = await fetch(suggestUrl, {
            method: "GET",
            headers: { "accept": "*/*", "accept-language": "vi,en;q=0.9" }
        });
        const xmlText = await res.text();
        
        // Parse XML response to extract meaning
        // Format: <rs id="0" type="0" mean="...">WordName</rs>
        const rsRegex = /<rs[^>]*mean="([^"]*)"[^>]*>([^<]*)<\/rs>/gi;
        let match;
        const results = [];
        while ((match = rsRegex.exec(xmlText)) !== null) {
            const meanRaw = match[1];
            const rsWord = match[2];
            // Decode HTML entities in mean attribute
            const mean = meanRaw
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/<[^>]*>/g, '') // strip HTML tags like <font>
                .trim();
            if (rsWord.toLowerCase() === word.toLowerCase() && mean) {
                return mean;
            }
            if (mean) results.push({ word: rsWord, mean });
        }
        // If exact match not found, return first result
        if (results.length > 0) return `${results[0].word}: ${results[0].mean}`;
        return null;
    } catch (e) {
        console.error("Lỗi curl_suggest API:", e.message);
        return null;
    }
}

// Check if there are any valid words starting with a given syllable (dead-end detection)
async function checkWordChainDeadEnd(lastSyllable, usedWords = []) {
    try {
        const suggestUrl = `http://tratu.soha.vn/extensions/curl_suggest.php?search=${encodeURIComponent(lastSyllable)}&dict=vn_vn`;
        const res = await fetch(suggestUrl, {
            method: "GET",
            headers: { "accept": "*/*", "accept-language": "vi,en;q=0.9" }
        });
        const xmlText = await res.text();
        
        // Parse all suggested words from XML
        const rsRegex = /<rs[^>]*>([^<]*)<\/rs>/gi;
        let match;
        const suggestions = [];
        while ((match = rsRegex.exec(xmlText)) !== null) {
            const suggestedWord = match[1].trim().toLowerCase();
            // Only count 2-syllable words that start with the lastSyllable
            const syllables = suggestedWord.split(/\s+/);
            if (syllables.length === 2 && syllables[0] === lastSyllable.toLowerCase()) {
                if (!usedWords.includes(suggestedWord)) {
                    suggestions.push(suggestedWord);
                }
            }
        }
        
        // If no valid 2-syllable words found starting with lastSyllable, it's a dead-end
        return { isDeadEnd: suggestions.length === 0, suggestions };
    } catch (e) {
        console.error("Lỗi checkWordChainDeadEnd:", e.message);
        return { isDeadEnd: false, suggestions: [] }; // Don't auto-skip on error
    }
}

// Helper: extract syllables from Vietnamese word
function getViSyllables(word) {
    return word.trim().split(/\s+/);
}

// In-memory voteskip tracking: groupId -> Set of userIds
const voteskipMap = new Map();
// In-memory definition cache: groupId -> { word, definition }
const wordDefinitionCache = new Map();

// --- English Word Validation via Cambridge Dictionary ---
async function isValidEnglishWord(word) {
    try {
        const res = await fetch(`https://dictionary.cambridge.org/vi/dictionary/english/${encodeURIComponent(word)}`, {
            method: "GET",
            redirect: "manual"
        });
        // 200 = word exists, 302 with location = base URL means not found
        if (res.status === 200) return true;
        if (res.status === 302) {
            const location = res.headers.get("location") || "";
            if (location === "https://dictionary.cambridge.org/vi/dictionary/english/" || location.endsWith("/dictionary/english/")) return false;
        }
        return false;
    } catch (e) {
        console.error("Lỗi Cambridge Dictionary:", e.message);
        return false;
    }
}

// --- English Word Meaning Fetch via Cambridge ---
async function lookupEnglishWord(word) {
    try {
        const url = `https://dictionary.cambridge.org/vi/dictionary/english-vietnamese/${encodeURIComponent(word)}`;
        const res = await fetch(url, {
            "headers": {
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
                "accept-language": "vi,en;q=0.9,en-GB;q=0.8,en-US;q=0.7,pt-BR;q=0.6,pt;q=0.5",
                "cache-control": "no-cache",
                "pragma": "no-cache",
                "priority": "u=0, i",
                "sec-ch-ua": "\"Not:A-Brand\";v=\"99\", \"Microsoft Edge\";v=\"145\", \"Chromium\";v=\"145\"",
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": "\"Windows\"",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "none",
                "sec-fetch-user": "?1",
                "upgrade-insecure-requests": "1",
                "cookie": "preferredDictionaries=\"english-vietnamese,english\";"
            },
            method: "GET"
        });
        
        if (res.status === 200) {
            const htmlText = await res.text();
            
            const defs = [];
            const meanRegex = /<span[^>]*class="trans dtrans"[^>]*>([\s\S]*?)<\/span>/gi;
            let match;
            while ((match = meanRegex.exec(htmlText)) !== null) {
                let text = match[1].replace(/<[^>]+>/g, '').trim();
                text = text.replace(/&#(\d+);/g, (m, dec) => String.fromCharCode(dec));
                text = text.replace(/&#x([0-9a-fA-F]+);/g, (m, dec) => String.fromCharCode(parseInt(dec, 16)));
                if (text && !defs.includes(text)) {
                    defs.push(text);
                }
            }
            
            if (defs.length > 0) {
                return { valid: true, definition: defs.slice(0, 3).join(", ") };
            }
            return { valid: true, definition: null };
        }
        
        return { valid: false, definition: null };
    } catch (e) {
        console.error("Lỗi tra từ tiếng Anh:", e.message);
        return { valid: false, definition: null };
    }
}

// ---------------------------------------------------------
// 3. TẠO CÂU HỎI VỚI AI (QUIZ)
// ---------------------------------------------------------
async function generateQuestion(threadId, level, mode) {
    const recent = await getRecentKeywords(threadId, 20);
    const avoid = recent.length > 0 ? `\nTuyệt đối TRÁNH dùng lại các từ khóa sau: ${recent.join(', ')}` : "";
    const topics =["education", "environment", "technology", "health", "business", "travel", "culture", "science", "arts", "sports", "history", "psychology", "politics", "media", "daily life", "nature", "space exploration", "cooking", "music", "fashion"];
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];

    const levelGuide = {
        'A1': `A1 (Sơ cấp - Beginner):
- Chỉ dùng từ vựng TOP 500 phổ biến nhất tiếng Anh, 1-2 âm tiết. VD: cat, dog, book, happy, run, eat, big, small, water, house.
- Câu cực ngắn (5-8 từ), cấu trúc đơn giản nhất: S + V + O. VD: "I ___ to school every day."
- CHỦ ĐỀ: đồ vật hàng ngày, màu sắc, số đếm, gia đình gần (mom, dad), thức ăn cơ bản.
- TUYỆT ĐỐI KHÔNG dùng: từ trừu tượng, từ học thuật, collocation, phrasal verb, câu phức.`,

        'A2': `A2 (Cơ bản - Elementary):
- Từ vựng TOP 1000-1500, cho phép 2-3 âm tiết. VD: important, beautiful, expensive, comfortable, restaurant, exercise, popular.
- Câu 8-12 từ, cho phép liên từ đơn giản (and, but, because). VD: "She bought a ___ dress for the party because she wanted to look nice."
- CHỦ ĐỀ: mua sắm, trường học, sở thích, thời tiết, mô tả người/nơi chốn.
- KHÔNG dùng: thuật ngữ chuyên ngành, idiom, câu bị động phức tạp, mệnh đề quan hệ dài.`,

        'B1': `B1 (Trung cấp - Intermediate):
- Từ vựng TOP 2000-3000, cho phép 2-4 âm tiết. VD: development, environment, communicate, opportunity, responsibility, significant.
- Câu 10-15 từ, có thể dùng mệnh đề quan hệ, câu điều kiện loại 1-2, bị động. VD: "The ___ between the two countries has improved significantly."
- CHỦ ĐỀ: công việc, du lịch, tin tức, sức khỏe, giáo dục đại cương, xã hội.
- Cho phép collocation phổ biến (make a decision, take responsibility). KHÔNG dùng thuật ngữ chuyên sâu.`,

        'B2': `B2 (Trung cao - Upper Intermediate):
- Từ vựng TOP 3000-5000, cho phép 3-5 âm tiết, bao gồm từ học thuật phổ biến. VD: acknowledge, controversial, sophisticated, predominantly, sustainability, infrastructure.
- Câu 12-20 từ, cấu trúc phức tạp: đảo ngữ, mệnh đề phân từ, câu điều kiện hỗn hợp. VD: "Had the government not ___ the policy, the economic crisis would have worsened."
- CHỦ ĐỀ: kinh tế, chính trị, khoa học phổ thông, văn hóa xã hội, tranh luận.
- Cho phép idiom, phrasal verb nâng cao (come up with, account for), collocations học thuật.`,

        'C1': `C1 (Cao cấp - Advanced):
- Từ vựng TOP 5000-8000, cho phép từ hiếm 4-6 âm tiết, từ Latin/Greek gốc. VD: juxtaposition, unprecedented, ubiquitous, exacerbate, idiosyncratic, ameliorate, dichotomy.
- Câu 15-25 từ, cấu trúc rất phức tạp: nominal clause, cleft sentence, subjunctive. VD: "The ___ of traditional values in the face of rapid technological advancement remains a contentious issue."
- CHỦ ĐỀ: triết học, luật pháp, y khoa phổ thông, kinh tế vĩ mô, phân tích xã hội sâu.
- BẮT BUỘC dùng từ vựng học thuật cao cấp (AWL - Academic Word List), collocation nâng cao.`,

        'C2': `C2 (Thành thạo - Proficiency):
- Từ vựng TOP 8000+, bao gồm từ cực hiếm, chuyên ngành sâu, archaic, literary. VD: obfuscate, magnanimous, perspicacious, sesquipedalian, sycophantic, anachronistic, verisimilitude.
- Câu 18-30 từ, tất cả cấu trúc phức tạp nhất: inversion, ellipsis, garden-path sentences. VD: "The ___ with which the erstwhile proponent of laissez-faire economics now advocates for stringent regulation borders on the paradoxical."
- CHỦ ĐỀ: ngôn ngữ học, triết học sâu, khoa học tiên tiến, luật quốc tế, phê bình văn học.
- BẮT BUỘC dùng từ mà người bản ngữ trình độ đại học cũng phải tra từ điển.`
    };
    const levelDescription = levelGuide[level] || levelGuide['B1'];

    let chosen = mode;
    if (!chosen || chosen === 'random') {
        const types =["word stress", "vocabulary context", "pronunciation difference", "word form"];
        chosen = types[Math.floor(Math.random() * types.length)];
    }

    const typeInstructions = {
        "word stress": `
DẠNG BÀI BẮT BUỘC: TRỌNG ÂM (Word Stress)
- Yêu cầu câu hỏi: "Chọn từ có vị trí trọng âm chính khác với 3 từ còn lại:"
- QUY TẮC SỐNG CÒN: Bạn PHẢI đảm bảo đúng 3 từ có CÙNG vị trí trọng âm, và đúng 1 từ KHÁC vị trí trọng âm.
- LỖI THƯỜNG GẶP CẦN TRÁNH: Đưa ra 4 từ cùng nhấn âm 1 (VD: kitchen, baking, recipe, simmer -> đều âm 1) -> ĐÂY LÀ LỖI NGHIÊM TRỌNG!
- VÍ DỤ ĐÚNG: happen (1), open (1), begin (2), listen (1) -> "begin" là đáp án đúng.
- Yêu cầu phần "analysis": Bắt buộc nháp ra trọng âm của từng từ (A: âm mấy, B: âm mấy...) để tự xác minh.
- TUYỆT ĐỐI KHÔNG dùng thẻ <u>.`,
        "pronunciation difference": `
DẠNG BÀI BẮT BUỘC: PHÁT ÂM (Pronunciation)
- Yêu cầu câu hỏi: "Chọn từ có phần gạch chân phát âm khác với 3 từ còn lại:"
- QUY TẮC SỐNG CÒN: Bắt buộc 3 từ có phần gạch chân phát âm giống nhau (Cùng IPA), 1 từ phát âm khác.
- Yêu cầu Đáp án: BẮT BUỘC dùng thẻ <u> để bọc DUY NHẤT phần chữ cái cần phát âm ở các đáp án (Ví dụ: l<u>o</u>ve, n<u>o</u>thing, b<u>o</u>th). KHÔNG gạch chân cả từ.
- Yêu cầu phần "analysis": Bắt buộc nháp ra ký hiệu phiên âm quốc tế (IPA) của phần gạch chân để tự xác minh.`,
        "vocabulary context": `
DẠNG BÀI BẮT BUỘC: TỪ VỰNG NGỮ CẢNH (Vocabulary Context)
- Yêu cầu câu hỏi: Tạo một câu tiếng Anh có MỘT chỗ trống (___). Yêu cầu chọn từ điền vào.
- QUY TẮC SỐNG CÒN: ĐÂY LÀ DẠNG TỪ VỰNG. TUYỆT ĐỐI KHÔNG hỏi về trọng âm. TUYỆT ĐỐI KHÔNG hỏi về cách phát âm.
- TUYỆT ĐỐI KHÔNG dùng thẻ <u> ở bất kỳ đâu.
- Các đáp án phải là các từ vựng khác nhau, có cùng từ loại (đều là động từ, đều là danh từ...).`,
        "word form": `
DẠNG BÀI BẮT BUỘC: CHIA DẠNG TỪ (Word Form)
- Yêu cầu câu hỏi: Tạo một câu tiếng Anh có MỘT chỗ trống (___). Cho sẵn một từ gốc (root word) IN HOA ở cuối câu hỏi. Yêu cầu chọn dạng đúng của từ đó để điền vào chỗ trống.
  VD: "The ___ of the new policy was announced yesterday. (INTRODUCE)"
- QUY TẮC SỐNG CÒN:
  + 4 đáp án phải là 4 DẠNG KHÁC NHAU của CÙNG MỘT từ gốc (danh từ, động từ, tính từ, trạng từ, hoặc các biến thể khác).
  + Ví dụ từ gốc "succeed": A. success (n) | B. successful (adj) | C. successfully (adv) | D. succeed (v)
  + Chỉ có DUY NHẤT 1 đáp án phù hợp về ngữ pháp và ngữ nghĩa khi điền vào chỗ trống.
  + TUYỆT ĐỐI KHÔNG hỏi về trọng âm hay cách phát âm.
- TUYỆT ĐỐI KHÔNG dùng thẻ <u> ở bất kỳ đâu.
- Yêu cầu phần "analysis": Phân tích vị trí chỗ trống cần từ loại gì (danh từ, tính từ, trạng từ, động từ...) dựa trên cấu trúc ngữ pháp, rồi xác nhận đáp án.
- Yêu cầu phần "explanation": Giải thích tại sao cần dùng dạng từ đó (VD: sau "the" cần danh từ, trước danh từ cần tính từ, bổ nghĩa cho động từ cần trạng từ...).`
    };

    const typeInstruction = typeInstructions[chosen];
    const SYSTEM_PROMPT = `Bạn là một giáo viên tiếng Anh cực kỳ cẩn thận, đang ra đề thi trắc nghiệm ABCD.
TRÌNH ĐỘ MỤC TIÊU: ${level} - ${levelDescription}.
CHỦ ĐỀ GỢI Ý: ${randomTopic}.${avoid}

CHỈ THỊ QUAN TRỌNG:
${typeInstruction}

QUY TẮC ĐỊNH DẠNG ĐẦU RA JSON (Bạn phải theo đúng cấu trúc này):
{
  "type": "${chosen}",
  "question": "Nội dung câu hỏi ở đây...",
  "analysis": "VIẾT NHÁP PHÂN TÍCH TẠI ĐÂY TRƯỚC: Phân tích từng lựa chọn A, B, C, D để đảm bảo chắc chắn 100% câu hỏi không bị sai logic.",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "correct": "A",
  "explanation": "Giải thích ngắn gọn tại sao đáp án lại đúng (bằng tiếng Việt)",
  "keyword": "từ khóa chính"
}`;

    try {
        const resp = await executeWithRetry("AI_Generate", async () => {
            const client = getOpenAIClient();
            return await client.chat.completions.create({
                model: AI_MODEL, response_format: { type: "json_object" }, temperature: 0.6, 
                messages:[{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `Hãy tạo 1 câu hỏi JSON. Bắt buộc thuộc dạng: ${chosen}. Tuân thủ tuyệt đối quy tắc của dạng bài này.` }]
            });
        }, 5);
        let raw = resp.choices[0].message.content.trim().replace(/```json\s*|\s*```/g, "");
        let q = JSON.parse(raw);
        if (!q.question || !q.options || !q.options.A || !q.correct || !q.explanation) throw new Error("Missing required fields in JSON");
        q.type = chosen;
        if (q.type !== 'pronunciation difference') {
            for (let key in q.options) {
                if (typeof q.options[key] === 'string') q.options[key] = q.options[key].replace(/<\/?u>/gi, "");
            }
        }
        return q;
    } catch (error) { console.error("❌ Lỗi AI hoặc Parse JSON:", error.message); return null; }
}

// --- PARSE THẺ HTML ĐỂ ĐỊNH DẠNG ZALO ---
function parseZaloTags(text) {
    let msg = ""; let styles =[]; let tagStack =[];
    const regex = /<\/?(u|b|green|red)>/g;
    let match; let lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
        msg += text.substring(lastIndex, match.index);
        const tag = match[1]; const isClosing = match[0].startsWith("</");
        if (!isClosing) { tagStack.push({ tag: tag, start: msg.length }); } else {
            for (let i = tagStack.length - 1; i >= 0; i--) {
                if (tagStack[i].tag === tag) {
                    const start = tagStack[i].start; const len = msg.length - start;
                    if (len > 0) {
                        let st; if (tag === 'u') st = TextStyle.Underline; if (tag === 'b') st = TextStyle.Bold;
                        if (tag === 'green') st = TextStyle.Green; if (tag === 'red') st = TextStyle.Red;
                        styles.push({ start, len, st });
                    }
                    tagStack.splice(i, 1); break;
                }
            }
        }
        lastIndex = regex.lastIndex;
    }
    msg += text.substring(lastIndex);
    return { msg, styles };
}

// ---------------------------------------------------------
// 4. PREFETCH (TỐI ƯU CHO RATE LIMIT 30 RPM)
// ---------------------------------------------------------
const prefetchQueue = new Map(); const POOL_SIZE = 3; 
async function triggerPrefetch(threadId, level, mode) {
    if (!prefetchQueue.has(threadId) || prefetchQueue.get(threadId).level !== level || prefetchQueue.get(threadId).mode !== mode) prefetchQueue.set(threadId, { level: level, mode: mode, queue:[], isFetching: false });
    const state = prefetchQueue.get(threadId);
    if (state.isFetching) return; state.isFetching = true;
    while (state.queue.length < POOL_SIZE && state.level === level && state.mode === mode) {
        await new Promise(r => setTimeout(r, 2500)); 
        const q = await generateQuestion(threadId, level, mode);
        if (state.level !== level || state.mode !== mode) break;
        if (q) state.queue.push(q);
    }
    state.isFetching = false;
}

async function getPrefetchedQuestion(threadId, level, mode) {
    if (!prefetchQueue.has(threadId) || prefetchQueue.get(threadId).level !== level || prefetchQueue.get(threadId).mode !== mode) prefetchQueue.set(threadId, { level: level, mode: mode, queue:[], isFetching: false });
    const state = prefetchQueue.get(threadId);
    let q = null;
    if (state.queue.length > 0) q = state.queue.shift(); 
    triggerPrefetch(threadId, level, mode);
    if (!q) q = await generateQuestion(threadId, level, mode);
    return q;
}

// ---------------------------------------------------------
// 5. KHỞI TẠO BOT ZALO VÀ LẮNG NGHE TIN NHẮN
// ---------------------------------------------------------
let cookieData = process.env.ZALO_COOKIE || "NHAP_COOKIE_CUA_BAN";
try { if (typeof cookieData === 'string' && cookieData.trim().startsWith('[')) cookieData = JSON.parse(cookieData); } catch (e) {}

const credentials = {
    cookie: cookieData, imei: process.env.ZALO_IMEI || "NHAP_IMEI_CUA_BAN",
    userAgent: process.env.ZALO_USER_AGENT || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

const processingLock = new Set();
const lastMessageTime = new Map();
const lastWarningTime = new Map();

async function startBot() {
    await initDB();

    try {
        const zalo = new Zalo({ selfListen: false, checkUpdate: true, logging: true });
        const api = await zalo.login(credentials);
        console.log("✅ Đăng nhập Zalo Bot thành công! Đang lắng nghe...");

        werewolf.init(api, runQuery, getQuery, allQuery);

        api.listener.start();

        api.listener.on('message', async (message) => {
            const threadId = message.threadId; 
            if (!threadId || processingLock.has(threadId)) return;

            processingLock.add(threadId);

            try {
                const text = message.data?.content;
                const msgType = message.type; 
                const userId = message.data?.uidFrom || threadId;
                const displayName = message.data?.dName || "bạn";

                if (typeof text !== "string") return;
                const text_lower = text.trim().toLowerCase();
                const args = text_lower.split(/\s+/);
                const command = args[0]; 

                const sendParsedMsg = async (msgText) => {
                    try {
                        const payload = parseZaloTags(msgText);
                        await executeWithRetry("Zalo_SendMessage", () => api.sendMessage(payload, threadId, msgType), 5);
                    } catch(e) { console.error("❌ Lỗi gửi tin nhắn:", e); }
                };

                // KIỂM TRA MỨC ĐỘ LIÊN QUAN CỦA TIN NHẮN ĐỂ ÁP DỤNG RATE LIMIT (THROTTLE)
                const isGroup = message.isGroup || msgType === ThreadType.Group;
                let isRelevant = false;

                if (text_lower.startsWith("/")) {
                    isRelevant = true;
                } else if (isGroup) {
                    const isWcEnabled = await isWordChainEnabled(threadId);
                    if (isWcEnabled) {
                        const wcMode = await getWordChainMode(threadId);
                        if (wcMode === 'vi') {
                            // Vietnamese: 2-syllable word detection
                            const viSyllables = text_lower.trim().split(/\s+/);
                            if (viSyllables.length === 2 && viSyllables.every(s => s.length >= 1)) isRelevant = true;
                        } else if (wcMode === 'en') {
                            // English: single word detection
                            if (/^[a-z]+$/.test(text_lower) && text_lower.length >= 2) isRelevant = true;
                        }
                    }
                } else {
                    isRelevant = true; // Tin nhắn riêng luôn được xử lý
                }

                if (!isRelevant) return; // Nếu tin nhắn bình thường ở group -> Bỏ qua

                // ÁP DỤNG RATE LIMIT (DELAY 1S)
                const now = Date.now();
                const lastMsgTs = lastMessageTime.get(threadId) || 0;
                if (now - lastMsgTs < 1000) {
                    const lastWarnTs = lastWarningTime.get(threadId) || 0;
                    if (now - lastWarnTs > 5000) { // Cảnh báo tối đa mỗi 5s để tránh spam
                        lastWarningTime.set(threadId, now);
                        await sendParsedMsg("<red>⚠️ Vui lòng nhắn chậm lại! Bot cần 1 giây nghỉ giữa các tin nhắn.</red>");
                    }
                    return; // Chặn xử lý tin nhắn
                }
                lastMessageTime.set(threadId, now);

                // LẤY THÔNG TIN UID (LỆNH ẨN)
                if (command === '/my-info') {
                    return await sendParsedMsg(`👤 Thông tin của bạn:\n- User ID: ${userId}\n- Thread ID: ${threadId}`);
                }

                // ==========================================
                // XỬ LÝ NHÓM (GROUP) - NỐI TỪ, QUIZ & WEREWOLF
                // ==========================================
                // Werewolf short command aliases
                const wwShortCmds = ['/v ', '/v\n', '/vote ', '/join', '/j ', '/j\n', '/leave', '/start', '/stop', '/cancel', '/alive', '/a ', '/a\n', '/kill ', '/k ', '/k\n', '/see ', '/guard ', '/g ', '/g\n', '/create', '/roles', '/ship '];
                const isWwCommand = text_lower.startsWith('/ww') || wwShortCmds.some(c => text_lower.startsWith(c) || text_lower === c.trim());

                if (isGroup) {
                    // Always forward to werewolf handler (handles commands AND non-command warnings)
                    if (isWwCommand) {
                        await werewolf.handleGroupMessage(message, threadId, userId, text, displayName);
                        return;
                    }
                    // Also forward non-commands for dead/night warnings (non-blocking)
                    werewolf.handleGroupMessage(message, threadId, userId, text, displayName).catch(() => {});

                    // Quiz ko hỗ trợ group
                    if (["/quiz", "/q"].includes(command)) {
                        return await sendParsedMsg("<red>⚠️ Tính năng Quiz hiện chỉ hoạt động trong tin nhắn cá nhân với Bot. Hãy nhắn tin riêng cho Bot để chơi nhé!</red>");
                    }

                    // Admin set game nối từ (cho phép admin group hoặc bot admin)
                    if (["/wordchain", "/wc", "/noitu"].includes(command)) {
                        let isGroupAdmin = false;
                        try {
                            const gInfo = await api.getGroupInfo(threadId);
                            const gData = gInfo.gridInfoMap[threadId];
                            if (gData && gData.adminIds && gData.adminIds.includes(userId)) isGroupAdmin = true;
                        } catch (e) { console.error("Lỗi kiểm tra admin group:", e.message); }
                        if (userId !== ADMIN_ID && !isGroupAdmin) return await sendParsedMsg("❌ Bạn không có quyền Admin để dùng lệnh này!");
                        
                        const isVietnamese = command === '/noitu';
                        const wcModeToSet = isVietnamese ? 'vi' : 'en';
                        const action = args[1];
                        if (action === 'on') {
                            await setWordChainEnabled(threadId, true, wcModeToSet);
                            await clearWordChainGame(threadId);
                            voteskipMap.delete(threadId);
                            wordDefinitionCache.delete(threadId);
                            if (isVietnamese) {
                                return await sendParsedMsg("<green>✅ Đã BẬT game Nối Từ Tiếng Việt trong nhóm này!</green>\n\n📖 <b>Luật chơi:</b>\n• Gõ từ 2 âm tiết (ví dụ: \"bắt đầu\")\n• Từ tiếp theo phải bắt đầu bằng âm tiết cuối của từ trước\n  VD: bắt <b>đầu</b> → <b>đầu</b> tiên → ...\n• Không nối 2 lần liên tiếp\n• Không trùng từ đã dùng\n\n⌨️ Lệnh: /nghia | /voteskip | /forceskip\n\n👉 Ai đó hãy bắt đầu bằng cách gõ 1 từ tiếng Việt 2 âm tiết!");
                            } else {
                                return await sendParsedMsg("<green>✅ Đã BẬT game Nối Từ Tiếng Anh trong nhóm này!</green>\n\n📖 <b>Luật chơi:</b>\n• Gõ 1 từ tiếng Anh (ví dụ: hello)\n• Từ tiếp theo phải bắt đầu bằng chữ cái cuối của từ trước\n  VD: hell<b>o</b> → <b>o</b>pen → ope<b>n</b> → ...\n• Không nối 2 lần liên tiếp\n• Không trùng từ đã dùng\n\n⌨️ Lệnh: /nghia | /voteskip | /forceskip\n\n👉 Ai đó hãy bắt đầu bằng cách gõ 1 từ tiếng Anh!");
                            }
                        } else if (action === 'off') {
                            await setWordChainEnabled(threadId, false);
                            await clearWordChainGame(threadId);
                            voteskipMap.delete(threadId);
                            wordDefinitionCache.delete(threadId);
                            return await sendParsedMsg("<red>✅ Đã TẮT game Nối từ trong nhóm này.</red>");
                        } else {
                            if (isVietnamese) return await sendParsedMsg("⚠️ Cú pháp: /noitu on hoặc /noitu off");
                            return await sendParsedMsg("⚠️ Cú pháp: /wordchain on hoặc /wordchain off");
                        }
                    }

                    // Lệnh /nghia - Xem nghĩa từ hiện tại (cho cả 2 mode)
                    if (command === '/nghia') {
                        const isWcOn = await isWordChainEnabled(threadId);
                        if (!isWcOn) return await sendParsedMsg("❌ Game Nối từ chưa được bật trong nhóm này!");
                        const wcModeNow = await getWordChainMode(threadId);
                        const wcState = await getWordChainState(threadId);
                        if (!wcState || !wcState.current_word) return await sendParsedMsg("❌ Chưa có từ nào trong game!");
                        
                        // Check cache first
                        const cached = wordDefinitionCache.get(threadId);
                        if (cached && cached.word === wcState.current_word && cached.definition) {
                            return await sendParsedMsg(`📖 <b>Nghĩa của "${wcState.current_word}":</b>\n${cached.definition}`);
                        }
                        
                        // Fetch from API
                        let lookup;
                        if (wcModeNow === 'vi') {
                            lookup = await lookupVietnameseWord(wcState.current_word);
                        } else {
                            lookup = await lookupEnglishWord(wcState.current_word);
                        }
                        
                        if (lookup && lookup.valid && lookup.definition) {
                            wordDefinitionCache.set(threadId, { word: wcState.current_word, definition: lookup.definition });
                            return await sendParsedMsg(`📖 <b>Nghĩa của "${wcState.current_word}":</b>\n${lookup.definition}`);
                        }
                        return await sendParsedMsg(`📖 Từ "${wcState.current_word}" không tìm thấy nghĩa trong từ điển.`);
                    }

                    // Lệnh /voteskip - Vote bỏ qua từ hiện tại
                    if (command === '/voteskip') {
                        const isWcOn = await isWordChainEnabled(threadId);
                        if (!isWcOn) return await sendParsedMsg("❌ Game Nối từ chưa được bật trong nhóm này!");
                        const wcState = await getWordChainState(threadId);
                        if (!wcState || !wcState.current_word) return await sendParsedMsg("❌ Chưa có từ nào để skip!");

                        // Initialize vote set if needed
                        if (!voteskipMap.has(threadId)) voteskipMap.set(threadId, new Set());
                        const votes = voteskipMap.get(threadId);
                        votes.add(userId);

                        // Get group member count
                        try {
                            const groupInfoResp = await api.getGroupInfo(threadId);
                            const groupInfo = groupInfoResp.gridInfoMap[threadId];
                            const totalMembers = groupInfo.totalMember || 1;
                            const neededVotes = Math.ceil(totalMembers * 0.3);

                            if (votes.size >= neededVotes) {
                                // Enough votes - skip!
                                voteskipMap.delete(threadId);
                                const skippedWord = wcState.current_word;
                                await clearWordChainGame(threadId);
                                wordDefinitionCache.delete(threadId);
                                return await sendParsedMsg(`<green>⏭️ Đã bỏ qua từ "<b>${skippedWord}</b>" (${votes.size}/${neededVotes} phiếu)</green>\n\n👉 Ai đó hãy bắt đầu lại bằng cách gõ 1 từ tiếng Việt 2 âm tiết mới!`);
                            } else {
                                return await sendParsedMsg(`🗳️ <b>${displayName}</b> đã vote skip!\n📊 Tiến độ: <b>${votes.size}/${neededVotes}</b> phiếu (cần 30% = ${neededVotes} người)\n\n💡 Gõ /voteskip để tham gia vote!`);
                            }
                        } catch (e) {
                            console.error("Lỗi getGroupInfo:", e.message);
                            return await sendParsedMsg("❌ Không thể lấy thông tin nhóm để tính vote. Thử lại sau!");
                        }
                    }

                    // Lệnh /forceskip - Admin bỏ qua ngay
                    if (command === '/forceskip') {
                        if (userId !== ADMIN_ID) return await sendParsedMsg("❌ Chỉ Admin mới có quyền force skip!");
                        const isWcOn = await isWordChainEnabled(threadId);
                        if (!isWcOn) return await sendParsedMsg("❌ Game Nối từ chưa được bật trong nhóm này!");
                        const wcState = await getWordChainState(threadId);
                        if (!wcState || !wcState.current_word) return await sendParsedMsg("❌ Chưa có từ nào để skip!");

                        const skippedWord = wcState.current_word;
                        voteskipMap.delete(threadId);
                        await clearWordChainGame(threadId);
                        wordDefinitionCache.delete(threadId);
                        return await sendParsedMsg(`<green>⏭️ Admin đã force skip từ "<b>${skippedWord}</b>"!</green>\n\n👉 Hãy bắt đầu lại bằng từ mới!`);
                    }

                    // Logic Game Nối Từ (Nếu đang bật)
                    const isWcEnabled = await isWordChainEnabled(threadId);
                    if (isWcEnabled) {
                        const wcMode = await getWordChainMode(threadId);

                        // ========== MODE TIẾNG VIỆT ==========
                        if (wcMode === 'vi') {
                            const syllables = getViSyllables(text_lower);
                            if (syllables.length === 2) {
                                const state = await getWordChainState(threadId);
                                
                                if (state && state.current_word) {
                                    const prevSyllables = getViSyllables(state.current_word);
                                    const expectedSyllable = prevSyllables[prevSyllables.length - 1];
                                    const firstSyllable = syllables[0];
                                    
                                    if (firstSyllable !== expectedSyllable) return;

                                    if (userId === state.last_player_id) {
                                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                                        return await sendParsedMsg(`❌ <red>${displayName} không được nối 2 lần liên tiếp! Hãy nhường người khác.</red>`);
                                    }
                                    
                                    const history = await getWordHistory(threadId, 100);
                                    if (history.includes(text_lower)) {
                                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                                        return await sendParsedMsg(`❌ <red>Từ "${text_lower}" đã được sử dụng trong 100 từ gần đây!</red>`);
                                    }
                                }
                                
                                const lookup = await lookupVietnameseWord(text_lower);
                                if (!lookup.valid) {
                                    if (state && state.current_word) {
                                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                                        return await sendParsedMsg(`❌ <red>"${text_lower}" không phải là một từ tiếng Việt hợp lệ (không có trong từ điển)!</red>`);
                                    } else {
                                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                                        return await sendParsedMsg(`❌ <red>"${text_lower}" không có trong từ điển! Hãy chọn từ khác để bắt đầu.</red>`);
                                    }
                                }
                                
                                await executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(()=>{});
                                await updateWordChainState(threadId, text_lower, userId);
                                await addWordHistory(threadId, text_lower);
                                wordDefinitionCache.set(threadId, { word: text_lower, definition: lookup.definition });
                                voteskipMap.delete(threadId);
                                
                                const lastSyllable = syllables[syllables.length - 1];
                                if (!state || !state.current_word) {
                                    await sendParsedMsg(`<green>🎮 Game Nối Từ đã bắt đầu với từ: <b>${text_lower}</b></green>\n👉 Người tiếp theo hãy nối bằng từ bắt đầu bằng: <b>${lastSyllable}</b> ...\n💡 Gõ /nghia để xem nghĩa từ`);
                                }
                                
                                // Dead-end detection: check if any valid words start with lastSyllable
                                const history = await getWordHistory(threadId, 100);
                                const deadEndCheck = await checkWordChainDeadEnd(lastSyllable, history);
                                if (deadEndCheck.isDeadEnd) {
                                    // Auto-skip: no more valid words to chain
                                    await clearWordChainGame(threadId);
                                    wordDefinitionCache.delete(threadId);
                                    await sendParsedMsg(`<red>⚠️ Hết từ để nối! Không còn từ 2 âm tiết nào bắt đầu bằng "<b>${lastSyllable}</b>" trong từ điển.</red>\n\n<green>🔄 Game đã tự động reset!</green>\n👉 Ai đó hãy bắt đầu lại bằng cách gõ 1 từ tiếng Việt 2 âm tiết mới!`);
                                }
                                return; 
                            }
                        }

                        // ========== MODE TIẾNG ANH ==========
                        if (wcMode === 'en') {
                            if (/^[a-z]+$/.test(text_lower) && text_lower.length >= 2) {
                                const state = await getWordChainState(threadId);
                                
                                if (state && state.current_word) {
                                    const expectedLetter = state.current_word.slice(-1);
                                    
                                    if (!text_lower.startsWith(expectedLetter)) return;

                                    if (userId === state.last_player_id) {
                                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                                        return await sendParsedMsg(`❌ <red>${displayName} không được nối 2 lần liên tiếp! Hãy nhường người khác.</red>`);
                                    }
                                    
                                    const history = await getWordHistory(threadId, 200);
                                    if (history.includes(text_lower)) {
                                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                                        return await sendParsedMsg(`❌ <red>Từ "${text_lower}" đã được sử dụng trong 200 từ gần đây!</red>`);
                                    }
                                }
                                
                                const isValid = await isValidEnglishWord(text_lower);
                                if (!isValid) {
                                    if (!state || (state && text_lower.startsWith(state.current_word.slice(-1)))) {
                                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(()=>{});
                                        return await sendParsedMsg(`❌ <red>"${text_lower}" không phải là một từ tiếng Anh hợp lệ!</red>`);
                                    }
                                    return;
                                }
                                
                                // Tiền tải nghĩa từ tiếng Anh bỏ vào cache (không đợi để không làm lag game)
                                lookupEnglishWord(text_lower).then(lookup => {
                                    if (lookup && lookup.valid && lookup.definition) {
                                        wordDefinitionCache.set(threadId, { word: text_lower, definition: lookup.definition });
                                    }
                                }).catch(()=>{});
                                
                                await executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(()=>{});
                                await updateWordChainState(threadId, text_lower, userId);
                                await addWordHistory(threadId, text_lower);
                                voteskipMap.delete(threadId);
                                
                                if (!state || !state.current_word) {
                                    await sendParsedMsg(`<green>🎮 Word Chain started with: <b>${text_lower}</b></green>\n👉 Next player, type a word starting with: <b>${text_lower.slice(-1).toUpperCase()}</b>`);
                                }
                                return; 
                            }
                        }
                    }
                    return; 
                }

                // ==========================================
                // XỬ LÝ NHẮN TIN RIÊNG (QUIZ & WEREWOLF)
                // ==========================================
                if (!isGroup && (text_lower.startsWith('/ww') || isWwCommand)) {
                    await werewolf.handlePrivateMessage(message, userId, text);
                    return;
                }

                const formatQuestionString = (q, score, userLvl) => {
                    const typeNames = { "stress": "🔊 Trọng âm", "word stress": "🔊 Trọng âm", "vocabulary": "📚 Từ vựng", "vocabulary context": "📚 Từ vựng", "pronunciation": "🗣️ Phát âm", "pronunciation difference": "🗣️ Phát âm", "word form": "📝 Chia dạng từ" };
                    const typeName = typeNames[q.type] || "📝 Bài tập";
                    const o = q.options; const badge = getLevelBadge(userLvl);
                    return `<b>━━━━━━━━━━━━━━━━━━━━\n📌 Dạng: ${typeName}\n⭐ Điểm: ${score} | Mức: ${userLvl} ${badge}\n━━━━━━━━━━━━━━━━━━━━</b>\n\n❓ ${q.question}\n\n   A. ${o.A}\n   B. ${o.B}\n   C. ${o.C}\n   D. ${o.D}\n\n✏️ Gõ A, B, C hoặc D để trả lời`;
                };

                let user = await getUserInfo(userId);
                if (!user) { await upsertUser(userId, displayName); user = await getUserInfo(userId); }
                const currentLevel = user ? user.level : 'B1';
                const currentMode = (user && user.mode) ? user.mode : 'random';

                if (text_lower.startsWith("/")) {
                    await upsertUser(userId, displayName); 

                    if (["/quiz", "/q"].includes(command)) {
                        let session = await getSession(threadId);
                        let current_score = session ? session.current_score : 0;
                        if (session && session.question_data) return await sendParsedMsg("⚠️ Bạn còn câu hỏi chưa trả lời!\n\n" + formatQuestionString(session.question_data, current_score, currentLevel));
                        if (!prefetchQueue.has(threadId) || prefetchQueue.get(threadId).queue.length === 0) await sendParsedMsg(`🤖 Đang chuẩn bị câu hỏi bằng AI (Trình độ ${currentLevel}), chờ xíu...`);
                        
                        const q = await getPrefetchedQuestion(threadId, currentLevel, currentMode);
                        if (!q) return await sendParsedMsg("<red>❌ Máy chủ AI đang quá tải hoặc phản hồi chậm. Vui lòng gõ /quiz để thử lại sau vài giây nhé!</red>");
                        
                        await saveSession(threadId, current_score, q); await saveKeyword(threadId, q.keyword || q.question.substring(0, 30));
                        return await sendParsedMsg(formatQuestionString(q, current_score, currentLevel));
                    } 
                    else if (["/level", "/l"].includes(command)) {
                        const newLevel = args[1] ? args[1].toUpperCase() : ''; const validLevels =['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
                        if (!validLevels.includes(newLevel)) return await sendParsedMsg(`⚠️ Vui lòng chọn đúng trình độ: A1, A2, B1, B2, C1, hoặc C2.\nVí dụ: /level B2`);
                        await changeLevel(userId, newLevel); prefetchQueue.set(threadId, { level: newLevel, mode: currentMode, queue:[], isFetching: false }); triggerPrefetch(threadId, newLevel, currentMode); 
                        return await sendParsedMsg(`<green>✅ Đã cập nhật trình độ của <b>${displayName}</b> lên: ${newLevel} ${getLevelBadge(newLevel)}.</green>\nCác câu hỏi tiếp theo sẽ ở mức độ này! Gõ /quiz để bắt đầu.`);
                    }
                    else if (["/mode", "/m"].includes(command)) {
                        const modeMap = { 'random': 'random', 'tuvung': 'vocabulary context', 'trongam': 'word stress', 'phatam': 'pronunciation difference', 'wordform': 'word form' };
                        const newModeKey = args[1] ? args[1].toLowerCase() : '';
                        if (!modeMap[newModeKey]) return await sendParsedMsg(`⚠️ Vui lòng chọn đúng chế độ:\n- <b>random</b> (Ngẫu nhiên)\n- <b>tuvung</b> (Từ vựng)\n- <b>trongam</b> (Trọng âm)\n- <b>phatam</b> (Phát âm)\n- <b>wordform</b> (Chia dạng từ)\n\nVí dụ: /mode tuvung`);
                        const actualMode = modeMap[newModeKey]; await changeMode(userId, actualMode); prefetchQueue.set(threadId, { level: currentLevel, mode: actualMode, queue:[], isFetching: false }); triggerPrefetch(threadId, currentLevel, actualMode); 
                        const modeDisplay = { 'random': '🎲 Ngẫu nhiên', 'vocabulary context': '📚 Từ vựng', 'word stress': '🔊 Trọng âm', 'pronunciation difference': '🗣️ Phát âm', 'word form': '📝 Chia dạng từ' };
                        return await sendParsedMsg(`<green>✅ Đã cập nhật chế độ của <b>${displayName}</b> thành: ${modeDisplay[actualMode]}</green>\nCác câu hỏi tiếp theo sẽ ra theo dạng này! Gõ /quiz để bắt đầu.`);
                    }
                    else if (["/score", "/s"].includes(command)) {
                        const session = await getSession(threadId); const live_score = session ? session.current_score : 0;
                        if (user.total_questions === 0 && !session) return await sendParsedMsg(`📊 ${displayName} chưa chơi lần nào!\nGõ /quiz để bắt đầu 🎮`);
                        const accuracy = user.total_questions > 0 ? Math.round((user.correct_answers / user.total_questions) * 100) : 0;
                        const rank = getRankTitle(user.max_score); const badge = getLevelBadge(user.level); const strkEmoji = getStreakEmoji(user.current_streak);
                        const modeDisplay = { 'random': '🎲 Ngẫu nhiên', 'vocabulary context': '📚 Từ vựng', 'word stress': '🔊 Trọng âm', 'pronunciation difference': '🗣️ Phát âm', 'word form': '📝 Chia dạng từ' };
                        const scoreBoard = `<b>━━━━━━━━━━━━━━━━━━━━\n<green>  📊 BẢNG ĐIỂM CÁ NHÂN  </green>\n━━━━━━━━━━━━━━━━━━━━</b>\n👤 <b>${displayName}</b>\n\n🔰 Danh hiệu     : ${rank}\n🏅 Trình độ      : ${user.level} ${badge}\n📌 Chế độ        : ${modeDisplay[currentMode] || '🎲 Ngẫu nhiên'}\n🏆 Điểm Kỷ lục   : <b>${user.max_score}</b>\n🔥 Chuỗi hiện tại: ${user.current_streak} ${strkEmoji} (Max: ${user.best_streak})\n🎯 Tỷ lệ đúng    : ${accuracy}% (${user.correct_answers}/${user.total_questions})\n⭐ Lượt hiện tại : ${live_score}\n<b>━━━━━━━━━━━━━━━━━━━━</b>\n\nGõ /quiz để luyện tiếp! 💪`;
                        return await sendParsedMsg(scoreBoard);
                    }
                    else if (["/top", "/t"].includes(command)) {
                        const topUsers = await allQuery("SELECT display_name, max_score, level FROM bot_user_scores ORDER BY max_score DESC LIMIT 10");
                        if (topUsers.length === 0) return await sendParsedMsg("Chưa có ai trong bảng xếp hạng.");
                        let topMsg = `<b>━━━━━━━━━━━━━━━━━━━━\n🏆 BẢNG XẾP HẠNG TOP 10 🏆\n━━━━━━━━━━━━━━━━━━━━</b>\n\n`;
                        topUsers.forEach((u, i) => { let medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : ` ${i+1}. `; topMsg += `${medal} <b>${u.display_name}</b> - ${u.max_score} đ ${getLevelBadge(u.level)}\n`; });
                        return await sendParsedMsg(topMsg);
                    }
                    else if (["/help", "/h"].includes(command)) {
                        const helpMsg = `<b>━━━━━━━━━━━━━━━━━━━━\n  🤖 ZALO QUIZ BOT\n  Luyện Tiếng Anh với AI\n━━━━━━━━━━━━━━━━━━━━</b>\n\n📚 Dạng câu hỏi: Trọng âm, Từ vựng, Phát âm, Chia dạng từ\n\n⌨️ Lệnh:\n  /quiz   → Câu hỏi mới\n  /level <A1-C2> → Chọn trình độ\n  /mode <tuvung|trongam|phatam|wordform|random> → Chọn dạng bài\n  /score  → Xem điểm của bạn\n  /top    → Bảng xếp hạng Top 10\n  /reset  → Hủy session hiện tại\n  /help   → Xem hướng dẫn\n\n🎮 Trả lời bằng cách gõ A, B, C hoặc D.`;
                        return await sendParsedMsg(helpMsg);
                    }
                    else if (["/reset", "/r"].includes(command)) {
                        const session = await getSession(threadId);
                        if (session) {
                            await updateUserAnswerStats(userId, false, session.current_score); await endSession(threadId); triggerPrefetch(threadId, currentLevel, currentMode); 
                            return await sendParsedMsg(`🔄 Đã reset session!\n📊 Điểm đã lưu cho <b>${displayName}</b>: ${session.current_score}\n\nGõ /quiz để bắt đầu lại!`);
                        } else { return await sendParsedMsg("ℹ️ Không có session nào đang chạy.\nGõ /quiz để bắt đầu!"); }
                    }
                    else { return await sendParsedMsg("❓ Lệnh không hợp lệ. Gõ /help để xem hướng dẫn."); }
                }

                await upsertUser(userId, displayName);
                if (["a", "b", "c", "d"].includes(text_lower)) {
                    const session = await getSession(threadId);
                    if (!session || !session.question_data) return await sendParsedMsg(`❓ Chưa có câu hỏi nào đâu ${displayName} ơi!\nGõ /quiz để bắt đầu nhé 🎮`);
                    const q = session.question_data; const current_score = session.current_score;
                    let correctRaw = (q.correct || q.answer || "").toString().toUpperCase().trim(); let correct = correctRaw;
                    if (!["A", "B", "C", "D"].includes(correctRaw)) {
                        if (/^[A-D][.\s:-]/.test(correctRaw)) correct = correctRaw.charAt(0);
                        else { for (const [key, val] of Object.entries(q.options)) { if (val && val.toString().toUpperCase().trim() === correctRaw) { correct = key; break; } } }
                    }
                    if (!["A", "B", "C", "D"].includes(correct)) correct = "A"; 

                    const answer = text_lower.toUpperCase();
                    if (answer === correct) {
                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.HEART, message), 3).catch(console.error);
                        const stats = await updateUserAnswerStats(userId, true, current_score); await saveSession(threadId, stats.newScore, null); 
                        const record_tag = stats.isNewRecord ? "\n<green>🎉 CHÚC MỪNG! BẠN VỪA PHÁ KỶ LỤC CỦA CHÍNH MÌNH!</green>" : "";
                        const strkE = getStreakEmoji(stats.current_streak);
                        const nextQ = await getPrefetchedQuestion(threadId, currentLevel, currentMode);
                        const correctStr = `<green><b>✅ CHÍNH XÁC! ${displayName} chọn ${answer} — Đúng!</b></green>\n\n📖 Giải thích:\n${q.explanation || q.explanationCorrect}\n\n<b>━━━━━━━━━━━━━━━━━━━━</b>\n🎉 +1 điểm! Tổng: ⭐ ${stats.newScore} | Chuỗi: ${stats.current_streak} ${strkE}${record_tag}\n<b>━━━━━━━━━━━━━━━━━━━━</b>\n\n`;
                        await sendParsedMsg(correctStr);
                        if (!nextQ) return await sendParsedMsg("<red>❌ Lỗi tải câu hỏi tiếp theo do API bận. Bạn vui lòng gõ /quiz để tiếp tục chơi nhé!</red>");
                        await saveSession(threadId, stats.newScore, nextQ); await saveKeyword(threadId, nextQ.keyword || nextQ.question.substring(0, 30));
                        await sendParsedMsg(formatQuestionString(nextQ, stats.newScore, currentLevel));
                    } else {
                        // REACTION NO THAY CHO TEARS_OF_JOY
                        executeWithRetry("Zalo_Reaction", () => api.addReaction(Reactions.NO, message), 3).catch(console.error);
                        const stats = await updateUserAnswerStats(userId, false, current_score); await endSession(threadId);
                        const correctTextDisplay = q.options[correct] ? ` (${q.options[correct]})` : "";
                        const wrongStr = `<red><b>❌ Sai rồi! ${displayName} chọn ${answer} — Đáp án đúng là ${correct}${correctTextDisplay}.</b></red>\n\n📖 Giải thích:\n${q.explanation || q.explanationWrong}\n\n<b>━━━━━━━━━━━━━━━━━━━━</b>\n💔 Game Over!\n📊 Điểm lần này : ${current_score}\n🏆 Kỷ lục của bạn: ${stats.max_score}\n<b>━━━━━━━━━━━━━━━━━━━━</b>\n\n👉 /quiz để chơi lại`;
                        await sendParsedMsg(wrongStr); triggerPrefetch(threadId, currentLevel, currentMode); 
                    }
                } 
                else {
                    const session = await getSession(threadId);
                    if (session && session.question_data) await sendParsedMsg(`<red>⚠️ ${displayName} vui lòng chỉ gõ A, B, C hoặc D!</red>\n\n` + formatQuestionString(session.question_data, session.current_score, currentLevel));
                    else await sendParsedMsg(`👋 Xin chào <b>${displayName}</b>!\n\nGõ /quiz để bắt đầu luyện tập\nGõ /help để xem hướng dẫn 📖`);
                }
            } finally { processingLock.delete(threadId); }
        });

        api.listener.on('reaction', async (reactionEvent) => {
            const threadId = reactionEvent.threadId;
            if (!threadId) return;
            try {
                await werewolf.handleReaction(reactionEvent);
            } catch (e) { console.error("Lỗi WW handleReaction:", e); }
        });

    } catch (error) { console.error("❌ Đăng nhập Zalo thất bại:", error); }
}

const shutdown = async () => {
    console.log("\n⚠️ Nhận tín hiệu đóng. Đang lưu database và tắt Bot...");
    try { await pool.end(); } catch (err) {}
    process.exit(0);
};
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('unhandledRejection', (reason) => { console.error('❌ Unhandled Rejection:', reason); }); process.on('uncaughtException', (err) => { console.error('❌ Uncaught Exception:', err); });

startBot();