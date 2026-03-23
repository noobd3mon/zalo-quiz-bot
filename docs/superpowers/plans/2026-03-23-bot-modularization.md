# Zalo Bot Modularization & Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the monolithic `index.js` into a modular structure, improve reliability with auto-reconnect and message queuing, and optimize performance with caching.

**Architecture:** 
- Modularize logic into `src/` directory (database, ai, quiz, wordchain, utils, config).
- Implement a message queue per thread to handle requests sequentially.
- Add auto-reconnect logic with exponential backoff for the Zalo listener.
- Cache dictionary lookups to reduce API latency.

**Tech Stack:** Node.js, zca-js, mysql2, openai, dotenv.

---

### Phase 1: Preparation & Base Modules

#### Task 1: Create `src/config.js` and `src/utils.js`

**Files:**
- Create: `src/config.js`
- Create: `src/utils.js`

- [ ] **Step 1: Create `src/config.js`**
Extract environment variables and configuration.

```javascript
require('dotenv').config();

module.exports = {
    API_KEYS: (process.env.GROQ_API_KEYS || "YOUR_GROQ_API_KEY").split(',').map(k => k.trim()),
    AI_MODEL: "openai/gpt-oss-120b",
    ADMIN_ID: process.env.ADMIN_ID || "YOUR_ADMIN_ID",
    DB: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
    },
    ZALO: {
        cookie: process.env.ZALO_COOKIE,
        imei: process.env.ZALO_IMEI,
        userAgent: process.env.ZALO_USER_AGENT
    }
};
```

- [ ] **Step 2: Create `src/utils.js`**
Move helper functions like `getCurrentTime`, `parseZaloTags`, etc.

```javascript
const { TextStyle } = require('zca-js');

function getCurrentTime() { 
    return new Date().toISOString().replace('T', ' ').substring(0, 19); 
}

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

module.exports = { getCurrentTime, parseZaloTags };
```

- [ ] **Step 3: Commit Phase 1 Preparation**

#### Task 2: Create `src/database.js`

**Files:**
- Create: `src/database.js`

- [ ] **Step 1: Implement `src/database.js`**
Move database initialization and helper functions.

```javascript
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
    ...config.DB,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const runQuery = async (query, params = []) => { const [result] = await pool.execute(query, params); return result; };
const getQuery = async (query, params =[]) => { const [rows] = await pool.execute(query, params); return rows[0] || null; };
const allQuery = async (query, params = []) => { const [rows] = await pool.execute(query, params); return rows; };

async function initDB() {
    // ... Copy all CREATE TABLE queries from index.js ...
}

module.exports = { pool, runQuery, getQuery, allQuery, initDB };
```

- [ ] **Step 2: Commit Database Module**

#### Task 3: Create `src/ai.js`

**Files:**
- Create: `src/ai.js`

- [ ] **Step 1: Implement `src/ai.js`**
Move AI client, rotation, and retry logic.

```javascript
const { OpenAI } = require('openai');
const config = require('./config');

let currentKeyIndex = 0;

function getOpenAIClient() {
    return new OpenAI({
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: config.API_KEYS[currentKeyIndex],
    });
}

function rotateApiKey() {
    currentKeyIndex = (currentKeyIndex + 1) % config.API_KEYS.length;
    console.warn(`🔄[API Key] Đã xoay tua sang API Key thứ ${currentKeyIndex + 1}/${config.API_KEYS.length}`);
}

async function executeWithRetry(actionName, actionFn, maxRetries = 5) {
    // ... Copy retry logic from index.js ...
}

module.exports = { getOpenAIClient, rotateApiKey, executeWithRetry };
```

- [ ] **Step 2: Commit AI Module**

### Phase 2: Feature Modules

#### Task 4: Create `src/wordchain.js`

**Files:**
- Create: `src/wordchain.js`

- [ ] **Step 1: Implement `src/wordchain.js`**
Move word chain helpers, state management, and dictionary lookups. Include caching.

```javascript
const db = require('./database');
// Add cache Map
const dictionaryCache = new Map(); // word -> { valid, definition }

// ... Move Word Chain helpers and lookups here ...
// Wrap lookups with cache check
```

- [ ] **Step 2: Commit Word Chain Module**

#### Task 5: Create `src/quiz.js`

**Files:**
- Create: `src/quiz.js`

- [ ] **Step 1: Implement `src/quiz.js`**
Move quiz helpers, question generation, and prefetch logic.

- [ ] **Step 2: Commit Quiz Module**

### Phase 3: Integration & Reliability

#### Task 6: Implement Message Queue and Reconnect in `index.js`

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Implement Message Queue per thread**
Replace `processingLock` with a queue-based approach.

- [ ] **Step 2: Implement Auto-reconnect for Zalo listener**
Use exponential backoff.

- [ ] **Step 3: Refactor `index.js` to use modules**

- [ ] **Step 4: Commit Integration**

### Phase 4: Refinement

#### Task 7: Rate Limit Tracking & AI Validation

- [ ] **Step 1: Add cooldown tracking per API key in `src/ai.js`**
- [ ] **Step 2: Add JSON schema validation for AI responses in `src/quiz.js`**
- [ ] **Step 3: Commit Refinements**
