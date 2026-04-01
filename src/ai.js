const { OpenAI } = require('openai');
const config = require('./config');

let currentKeyIndex = 0;
const keyCooldowns = new Map(); // Index -> Cooldown timestamp
let cachedClient = null; // Cache OpenAI client instance
let cachedClientKeyIndex = -1; // Track which key the cached client uses

function getOpenAIClient() {
    const now = Date.now();
    const totalKeys = config.API_KEYS.length;

    // Find a valid key (not in cooldown)
    let attempts = 0;
    while (keyCooldowns.has(currentKeyIndex) && keyCooldowns.get(currentKeyIndex) > now) {
        currentKeyIndex = (currentKeyIndex + 1) % totalKeys;
        attempts++;
        if (attempts >= totalKeys) {
            // All keys are in cooldown
            const oldestCooldown = Math.min(...Array.from(keyCooldowns.values()));
            const waitTime = Math.ceil((oldestCooldown - now) / 1000);
            throw new Error(`Hết API key khả dụng. Vui lòng đợi ${waitTime}s cho key sớm nhất.`);
        }
    }

    // Create new client only if key changed or no cached client
    if (!cachedClient || cachedClientKeyIndex !== currentKeyIndex) {
        cachedClient = new OpenAI({
            baseURL: 'https://api.groq.com/openai/v1',
            apiKey: config.API_KEYS[currentKeyIndex],
        });
        cachedClientKeyIndex = currentKeyIndex;
    }

    return cachedClient;
}

function rotateApiKey() {
    // Set cooldown for current key (60s)
    keyCooldowns.set(currentKeyIndex, Date.now() + 60000);
    const oldIndex = currentKeyIndex;
    currentKeyIndex = (currentKeyIndex + 1) % config.API_KEYS.length;
    // Invalidate cached client so new key gets a new instance
    cachedClient = null;
    cachedClientKeyIndex = -1;
    console.warn(`🔄[API Key] Đã xoay tua từ key ${oldIndex + 1} sang key ${currentKeyIndex + 1}/${config.API_KEYS.length}`);
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
