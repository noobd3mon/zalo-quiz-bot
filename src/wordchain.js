const db = require('./database');

// In-memory definition cache: word -> { valid, definition }
const dictionaryCache = new Map();
const DICTIONARY_CACHE_MAX = 500;
// In-memory voteskip tracking: groupId -> Set of userIds
const voteskipMap = new Map();
// In-memory last word definition cache: groupId -> { word, definition }
const wordDefinitionCache = new Map();

// --- Helpers GAME NỐI TỪ ---
async function isWordChainEnabled(groupId) {
    const row = await db.getQuery("SELECT wordchain_enabled FROM bot_group_settings WHERE group_id = ?", [groupId]);
    return row ? row.wordchain_enabled === 1 : false;
}

async function getWordChainMode(groupId) {
    const row = await db.getQuery("SELECT wordchain_mode FROM bot_group_settings WHERE group_id = ?", [groupId]);
    return row ? (row.wordchain_mode || 'vi') : 'vi';
}

async function setWordChainEnabled(groupId, isEnabled, mode = 'vi') {
    await db.runQuery("INSERT INTO bot_group_settings (group_id, wordchain_enabled, wordchain_mode) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE wordchain_enabled = VALUES(wordchain_enabled), wordchain_mode = VALUES(wordchain_mode)", [groupId, isEnabled ? 1 : 0, mode]);
}

async function getWordChainState(groupId) {
    return await db.getQuery("SELECT * FROM bot_wordchain_state WHERE group_id = ?", [groupId]);
}

async function updateWordChainState(groupId, word, playerId) {
    await db.runQuery("INSERT INTO bot_wordchain_state (group_id, current_word, last_player_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE current_word = VALUES(current_word), last_player_id = VALUES(last_player_id)", [groupId, word, playerId]);
}

async function getWordHistory(groupId, limit = 100) {
    const rows = await db.allQuery("SELECT word FROM bot_wordchain_history WHERE group_id = ? ORDER BY id DESC LIMIT ?", [groupId, limit]);
    return rows.map(r => r.word);
}

async function addWordHistory(groupId, word) {
    await db.runQuery("INSERT INTO bot_wordchain_history (group_id, word) VALUES (?, ?)",[groupId, word]);
}

async function clearWordChainGame(groupId) {
    await db.runQuery("DELETE FROM bot_wordchain_state WHERE group_id = ?", [groupId]);
    await db.runQuery("DELETE FROM bot_wordchain_history WHERE group_id = ?", [groupId]);
}

// --- Vietnamese Word Lookup via tratu.soha.vn API ---
const SOHA_HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "vi,en;q=0.9",
    "cache-control": "no-cache",
    "pragma": "no-cache",
};

async function lookupVietnameseWord(word) {
    const lowerWord = word.toLowerCase();
    if (dictionaryCache.has(lowerWord)) return dictionaryCache.get(lowerWord);

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
            definition = await getVietnameseWordMeaning(word);
        }
        
        const result = { valid: wordExists, definition };
        if (dictionaryCache.size >= DICTIONARY_CACHE_MAX) {
            const firstKey = dictionaryCache.keys().next().value;
            dictionaryCache.delete(firstKey);
        }
        dictionaryCache.set(lowerWord, result);
        return result;
    } catch (e) {
        console.error("Lỗi tratu.soha.vn API:", e.message);
        return { valid: false, definition: null };
    }
}

async function getVietnameseWordMeaning(word) {
    try {
        const suggestUrl = `http://tratu.soha.vn/extensions/curl_suggest.php?search=${encodeURIComponent(word)}&dict=vn_vn`;
        const res = await fetch(suggestUrl, {
            method: "GET",
            headers: { "accept": "*/*", "accept-language": "vi,en;q=0.9" }
        });
        const xmlText = await res.text();
        
        const rsRegex = /<rs[^>]*mean="([^"]*)"[^>]*>([^<]*)<\/rs>/gi;
        let match;
        const results = [];
        while ((match = rsRegex.exec(xmlText)) !== null) {
            const meanRaw = match[1];
            const rsWord = match[2];
            const mean = meanRaw
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/<[^>]*>/g, '') 
                .trim();
            if (rsWord.toLowerCase() === word.toLowerCase() && mean) {
                return mean;
            }
            if (mean) results.push({ word: rsWord, mean });
        }
        if (results.length > 0) return `${results[0].word}: ${results[0].mean}`;
        return null;
    } catch (e) {
        console.error("Lỗi curl_suggest API:", e.message);
        return null;
    }
}

async function checkWordChainDeadEnd(lastSyllable, usedWords = []) {
    try {
        const suggestUrl = `http://tratu.soha.vn/extensions/curl_suggest.php?search=${encodeURIComponent(lastSyllable)}&dict=vn_vn`;
        const res = await fetch(suggestUrl, {
            method: "GET",
            headers: { "accept": "*/*", "accept-language": "vi,en;q=0.9" }
        });
        const xmlText = await res.text();
        
        const rsRegex = /<rs[^>]*>([^<]*)<\/rs>/gi;
        let match;
        const suggestions = [];
        while ((match = rsRegex.exec(xmlText)) !== null) {
            const suggestedWord = match[1].trim().toLowerCase();
            const syllables = suggestedWord.split(/\s+/);
            if (syllables.length === 2 && syllables[0] === lastSyllable.toLowerCase()) {
                if (!usedWords.includes(suggestedWord)) {
                    suggestions.push(suggestedWord);
                }
            }
        }
        
        return { isDeadEnd: suggestions.length === 0, suggestions };
    } catch (e) {
        console.error("Lỗi checkWordChainDeadEnd:", e.message);
        return { isDeadEnd: false, suggestions: [] }; 
    }
}

function getViSyllables(word) {
    return word.trim().split(/\s+/);
}

async function isValidEnglishWord(word) {
    const lowerWord = word.toLowerCase();
    if (dictionaryCache.has(lowerWord)) return dictionaryCache.get(lowerWord).valid;

    try {
        const res = await fetch(`https://dictionary.cambridge.org/vi/dictionary/english/${encodeURIComponent(word)}`, {
            method: "GET",
            redirect: "manual"
        });
        if (res.status === 200) {
            // We don't have definition yet, but we know it's valid
            return true;
        }
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

async function lookupEnglishWord(word) {
    const lowerWord = word.toLowerCase();
    if (dictionaryCache.has(lowerWord) && dictionaryCache.get(lowerWord).definition) return dictionaryCache.get(lowerWord);

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
            
            const result = { valid: true, definition: defs.length > 0 ? defs.slice(0, 3).join(", ") : null };
            if (dictionaryCache.size >= DICTIONARY_CACHE_MAX) {
                const firstKey = dictionaryCache.keys().next().value;
                dictionaryCache.delete(firstKey);
            }
            dictionaryCache.set(lowerWord, result);
            return result;
        }
        
        return { valid: false, definition: null };
    } catch (e) {
        console.error("Lỗi tra từ tiếng Anh:", e.message);
        return { valid: false, definition: null };
    }
}

module.exports = {
    isWordChainEnabled, getWordChainMode, setWordChainEnabled, getWordChainState,
    updateWordChainState, getWordHistory, addWordHistory, clearWordChainGame,
    lookupVietnameseWord, checkWordChainDeadEnd, getViSyllables,
    isValidEnglishWord, lookupEnglishWord,
    voteskipMap, wordDefinitionCache
};
