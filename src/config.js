'use strict';
require('dotenv').config();

const API_KEYS = (process.env.GROQ_API_KEYS || 'YOUR_GROQ_API_KEY').split(',').map(k => k.trim());
let currentKeyIndex = 0;
const AI_MODEL = 'openai/gpt-oss-120b';
const ADMIN_ID = process.env.ADMIN_ID || 'YOUR_ADMIN_ID';

function getCurrentKey() { return API_KEYS[currentKeyIndex]; }
function rotateKey() {
    currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
    console.warn(`[API Key] Rotated to key ${currentKeyIndex + 1}/${API_KEYS.length}`);
}
function getKeyCount() { return API_KEYS.length; }

module.exports = { API_KEYS, AI_MODEL, ADMIN_ID, getCurrentKey, rotateKey, getKeyCount };