const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
    ...config.DB,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const runQuery = async (query, params = []) => { 
    const [result] = await pool.execute(query, params); 
    return result; 
};

const getQuery = async (query, params =[]) => { 
    const [rows] = await pool.execute(query, params); 
    return rows[0] || null; 
};

const allQuery = async (query, params = []) => { 
    const [rows] = await pool.execute(query, params); 
    return rows; 
};

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

    // ==========================================
    // TẠO TABLES CHO QUIZ ADVANCED
    // ==========================================
    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_answer_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            chat_id VARCHAR(255),
            q_type VARCHAR(50),
            is_correct TINYINT,
            question_json TEXT,
            answered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    try { await runQuery("ALTER TABLE bot_answer_history ADD COLUMN question_json TEXT"); } catch (e) {}

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_daily_questions (
            day DATE PRIMARY KEY,
            questions TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_daily_results (
            chat_id VARCHAR(255),
            day DATE,
            score INT DEFAULT 0,
            current_index INT DEFAULT 0,
            is_completed TINYINT DEFAULT 0,
            completed_at DATETIME,
            PRIMARY KEY (chat_id, day)
        )
    `);

    // Convert tất cả bảng sang UTF8MB4 để hỗ trợ tiếng Việt
    const tablesToConvert = [
        'bot_user_scores', 'bot_quiz_sessions', 'bot_question_history',
        'bot_group_settings', 'bot_wordchain_state', 'bot_wordchain_history',
        'bot_answer_history', 'bot_daily_questions', 'bot_daily_results'
    ];
    for (const table of tablesToConvert) {
        try { await runQuery(`ALTER TABLE ${table} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch (e) {}
    }
}

module.exports = { pool, runQuery, getQuery, allQuery, initDB };
