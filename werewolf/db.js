let runQuery, getQuery, allQuery;

function init(rq, gq, aq) {
    runQuery = rq;
    getQuery = gq;
    allQuery = aq;
}

async function initTables() {
    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_ww_games (
            group_id VARCHAR(255) PRIMARY KEY,
            state VARCHAR(50) DEFAULT 'NEW_GAME',
            day_count INT DEFAULT 0,
            timer_ends_at DATETIME,
            winner VARCHAR(50) NULL,
            werewolf_group_id VARCHAR(255) NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_ww_players (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id VARCHAR(255),
            user_id VARCHAR(255),
            name VARCHAR(255) NULL,
            role VARCHAR(50),
            is_alive TINYINT DEFAULT 1,
            lover_id VARCHAR(255) NULL,
            status JSON,
            UNIQUE KEY (group_id, user_id)
        )
    `);

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_ww_votes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id VARCHAR(255),
            day INT,
            voter_id VARCHAR(255),
            target_id VARCHAR(255),
            UNIQUE KEY (group_id, day, voter_id)
        )
    `);

    await runQuery(`
        CREATE TABLE IF NOT EXISTS bot_ww_night_actions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            group_id VARCHAR(255),
            day INT,
            user_id VARCHAR(255),
            action_type VARCHAR(50),
            target_id VARCHAR(255) NULL,
            extra JSON,
            UNIQUE KEY (group_id, day, user_id, action_type)
        )
    `);

    try { await runQuery(`ALTER TABLE bot_ww_games CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch (e) {}
    try { await runQuery(`ALTER TABLE bot_ww_players ADD COLUMN name VARCHAR(255) NULL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE bot_ww_players CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch (e) {}
    try { await runQuery(`ALTER TABLE bot_ww_votes CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch (e) {}
    try { await runQuery(`ALTER TABLE bot_ww_night_actions CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } catch (e) {}
}

// Helpers
async function getGame(groupId) {
    return await getQuery("SELECT * FROM bot_ww_games WHERE group_id = ?", [groupId]);
}

async function getPlayers(groupId) {
    return await allQuery("SELECT * FROM bot_ww_players WHERE group_id = ?", [groupId]);
}

async function saveGame(game) {
    await runQuery(
        "INSERT INTO bot_ww_games (group_id, state, day_count, timer_ends_at, winner, werewolf_group_id) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state), day_count = VALUES(day_count), timer_ends_at = VALUES(timer_ends_at), winner = VALUES(winner), werewolf_group_id = VALUES(werewolf_group_id)",
        [game.group_id, game.state, game.day_count, game.timer_ends_at, game.winner, game.werewolf_group_id]
    );
}

async function savePlayer(p) {
    await runQuery(
        "INSERT INTO bot_ww_players (group_id, user_id, name, role, is_alive, lover_id, status) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role), is_alive = VALUES(is_alive), lover_id = VALUES(lover_id), status = VALUES(status)",
        [p.group_id, p.user_id, p.name, p.role, p.is_alive, p.lover_id, JSON.stringify(p.status)]
    );
}

module.exports = { 
    init, initTables, 
    getGame, getPlayers, saveGame, savePlayer,
    get runQuery() { return runQuery; }, 
    get getQuery() { return getQuery; }, 
    get allQuery() { return allQuery; } 
};
