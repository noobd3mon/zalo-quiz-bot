'use strict';  
const mysql = require('mysql2/promise');  
const pool = mysql.createPool({  
    host: process.env.DB_HOST, user: process.env.DB_USER,  
    password: process.env.DB_PASS, database: process.env.DB_NAME,  
    charset: 'utf8mb4', waitForConnections: true, connectionLimit: 10, queueLimit: 0  
}); 
pool.getConnection().then(() => console.log('[DB] Connected')).catch(e => console.error('[DB]', e.message));  
const run = async (q, p = []) => { const [r] = await pool.execute(q, p); return r; };  
const get = async (q, p = []) => { const [rows] = await pool.execute(q, p); return rows[0] || null; };  
const all = async (q, p = []) => { const [rows] = await pool.execute(q, p); return rows; }; 
async function initDB() {  
    await run(`CREATE TABLE IF NOT EXISTS bot_user_scores (chat_id VARCHAR(255) PRIMARY KEY, display_name VARCHAR(255) DEFAULT 'Nguoi dung', max_score INT DEFAULT 0, total_games INT DEFAULT 0, last_played DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, level VARCHAR(10) DEFAULT 'B1', current_streak INT DEFAULT 0, best_streak INT DEFAULT 0, correct_answers INT DEFAULT 0, total_questions INT DEFAULT 0, mode VARCHAR(50) DEFAULT 'random')`);  
    try { await run(`ALTER TABLE bot_user_scores ADD COLUMN mode VARCHAR(50) DEFAULT 'random'`); } catch(e) {} 
    await run(`CREATE TABLE IF NOT EXISTS bot_quiz_sessions (chat_id VARCHAR(255) PRIMARY KEY, current_score INT DEFAULT 0, question_data JSON, is_active TINYINT DEFAULT 1)`);  
    await run(`CREATE TABLE IF NOT EXISTS bot_question_history (id INT AUTO_INCREMENT PRIMARY KEY, chat_id VARCHAR(255), keyword VARCHAR(255), answered_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);  
    await run(`CREATE TABLE IF NOT EXISTS bot_group_settings (group_id VARCHAR(255) PRIMARY KEY, wordchain_enabled TINYINT DEFAULT 0, wordchain_mode VARCHAR(10) DEFAULT 'vi')`);  
    try { await run(`ALTER TABLE bot_group_settings ADD COLUMN wordchain_mode VARCHAR(10) DEFAULT 'vi'`); } catch(e) {} 
    await run(`CREATE TABLE IF NOT EXISTS bot_wordchain_state (group_id VARCHAR(255) PRIMARY KEY, current_word VARCHAR(255), last_player_id VARCHAR(255))`);  
    await run(`CREATE TABLE IF NOT EXISTS bot_wordchain_history (id INT AUTO_INCREMENT PRIMARY KEY, group_id VARCHAR(255), word VARCHAR(255), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);  
    const tables = ['bot_user_scores','bot_quiz_sessions','bot_question_history','bot_group_settings','bot_wordchain_state','bot_wordchain_history'];  
    for (const t of tables) { try { await run(`ALTER TABLE ${t} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch(e) {} }  
    console.log('[DB] Tables ready');  
}  
module.exports = { pool, run, get, all, initDB }; 
