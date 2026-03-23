const { OpenAI } = require('openai');
const config = require('./config');

let currentKeyIndex = 0;
const keyCooldowns = new Map(); // Index -> Cooldown timestamp

function getOpenAIClient() {
    // Check if current key is in cooldown
    const now = Date.now();
    let attempts = 0;
    while (keyCooldowns.has(currentKeyIndex) && keyCooldowns.get(currentKeyIndex) > now && attempts < config.API_KEYS.length) {
        currentKeyIndex = (currentKeyIndex + 1) % config.API_KEYS.length;
        attempts++;
    }

    return new OpenAI({
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: config.API_KEYS[currentKeyIndex],
    });
}

function rotateApiKey() {
    // Set cooldown for current key (60s)
    keyCooldowns.set(currentKeyIndex, Date.now() + 60000);
    currentKeyIndex = (currentKeyIndex + 1) % config.API_KEYS.length;
    console.warn(`🔄[API Key] Đã xoay tua sang API Key thứ ${currentKeyIndex + 1}/${config.API_KEYS.length}`);
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

module.exports = { getOpenAIClient, rotateApiKey, executeWithRetry };
