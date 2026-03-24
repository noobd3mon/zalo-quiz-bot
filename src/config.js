require('dotenv').config();

module.exports = {
    API_KEYS: (process.env.GROQ_API_KEYS || "YOUR_GROQ_API_KEY").split(',').map(k => k.trim()),
    AI_MODEL: "openai/gpt-oss-120b",
    ADMIN_ID: process.env.ADMIN_ID || "YOUR_ADMIN_ID",
    DB: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS || process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    },
    ZALO: {
        cookie: process.env.ZALO_COOKIE,
        imei: process.env.ZALO_IMEI,
        userAgent: process.env.ZALO_USER_AGENT
    },
    BOT_CONFIG: {
        fontSize: 15,
        signature: "Coded by Lò Hiếu Kỳ ❤️",
        includeSignature: true
    }
};
