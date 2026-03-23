const db = require('./database');
const ai = require('./ai');
const utils = require('./utils');

// --- Helpers Quiz AI ---
async function upsertUser(userId, displayName = "Nguoi dung") { await db.runQuery(`INSERT INTO bot_user_scores (chat_id, display_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,[userId, displayName]); }
async function getUserInfo(userId) { return await db.getQuery("SELECT * FROM bot_user_scores WHERE chat_id = ?",[userId]); }
async function changeLevel(userId, level) { await db.runQuery("UPDATE bot_user_scores SET level = ? WHERE chat_id = ?",[level, userId]); }
async function changeMode(userId, mode) { await db.runQuery("UPDATE bot_user_scores SET mode = ? WHERE chat_id = ?",[mode, userId]); }

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
    
    await db.runQuery(`UPDATE bot_user_scores SET max_score = ?, current_streak = ?, best_streak = ?, total_questions = ?, correct_answers = ?, total_games = ?, last_played = ? WHERE chat_id = ?`,[max_score, current_streak, best_streak, total_questions, correct_answers, total_games, utils.getCurrentTime(), userId]);
    return { isNewRecord, newScore, current_streak, max_score };
}

async function getSession(threadId) {
    const row = await db.getQuery("SELECT chat_id, current_score, question_data, is_active FROM bot_quiz_sessions WHERE chat_id = ? AND is_active = 1",[threadId]);
    return row ? { ...row, question_data: row.question_data ? JSON.parse(row.question_data) : null } : null;
}
async function saveSession(threadId, currentScore, questionData) { await db.runQuery(`INSERT INTO bot_quiz_sessions (chat_id, current_score, question_data, is_active) VALUES (?, ?, ?, 1) ON DUPLICATE KEY UPDATE current_score = VALUES(current_score), question_data = VALUES(question_data), is_active = 1`,[threadId, currentScore, JSON.stringify(questionData)]); }
async function endSession(threadId) { await db.runQuery("UPDATE bot_quiz_sessions SET is_active = 0 WHERE chat_id = ?", [threadId]); }
async function getRecentKeywords(threadId, limit = 20) { const rows = await db.allQuery("SELECT keyword FROM bot_question_history WHERE chat_id = ? ORDER BY answered_at DESC LIMIT ?",[threadId, limit]); return rows.map(r => r.keyword); }
async function saveKeyword(threadId, keyword) { await db.runQuery("INSERT INTO bot_question_history (chat_id, keyword) VALUES (?, ?)", [threadId, keyword]); }

const getLevelBadge = (lvl) => { const map = { 'A1': '🌱', 'A2': '🌿', 'B1': '🌳', 'B2': '🔥', 'C1': '💎', 'C2': '👑' }; return map[lvl] || '🌳'; };
const getRankTitle = (score) => score >= 500 ? "Grand Master 🐲" : score >= 200 ? "Master 🦁" : score >= 100 ? "Advanced 🐯" : score >= 50 ? "Intermediate 🐺" : score >= 10 ? "Beginner 🦊" : "Novice 🐰";
const getStreakEmoji = (streak) => streak >= 10 ? "🔥🔥🔥" : streak >= 5 ? "🔥🔥" : streak >= 3 ? "🔥" : "⚡";

// --- 3. TẠO CÂU HỎI VỚI AI (QUIZ) ---
const AI_MODEL = "openai/gpt-oss-120b"; 

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
        const resp = await ai.executeWithRetry("AI_Generate", async () => {
            const client = ai.getOpenAIClient();
            return await client.chat.completions.create({
                model: AI_MODEL, response_format: { type: "json_object" }, temperature: 0.6, 
                messages:[{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `Hãy tạo 1 câu hỏi JSON. Bắt buộc thuộc dạng: ${chosen}. Tuân thủ tuyệt đối quy tắc của dạng bài này.` }]
            });
        }, 5);
        let raw = resp.choices[0].message.content.trim().replace(/```json\s*|\s*```/g, "");
        let q = JSON.parse(raw);
        
        // Validation schema (Phase 4, Task 7, Step 2)
        if (!q.question || !q.options || !q.options.A || !q.options.B || !q.options.C || !q.options.D || !q.correct || !q.explanation) {
            throw new Error("Missing required fields in AI response JSON");
        }
        
        q.type = chosen;
        if (q.type !== 'pronunciation difference') {
            for (let key in q.options) {
                if (typeof q.options[key] === 'string') q.options[key] = q.options[key].replace(/<\/?u>/gi, "");
            }
        }
        return q;
    } catch (error) { 
        console.error("❌ Lỗi AI hoặc Parse JSON:", error.message); 
        return null; 
    }
}

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

module.exports = {
    upsertUser, getUserInfo, changeLevel, changeMode, updateUserAnswerStats,
    getSession, saveSession, endSession, getRecentKeywords, saveKeyword,
    getLevelBadge, getRankTitle, getStreakEmoji,
    generateQuestion, triggerPrefetch, getPrefetchedQuestion,
    prefetchQueue
};
