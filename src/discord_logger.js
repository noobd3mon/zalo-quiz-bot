const WEBHOOK_URL = "https://discord.com/api/webhooks/1490215821870497823/X2doPBsGIlH7GHL2ZcmaIAP3hUKqA2YtmLdexPbYiy3MDLGudjEx0hnSTOmA5fIl-i0K";

let logBuffer = [];
let isFlushing = false;

async function flushLogs() {
    if (logBuffer.length === 0 || isFlushing) return;
    isFlushing = true;
    
    // Discord message max length is ~2000 chars. We reserve chars for formatting.
    let content = "";
    while (logBuffer.length > 0 && content.length + logBuffer[0].length < 1900) {
        content += logBuffer.shift() + "\n";
    }
    
    if (content.trim()) {
        try {
            await fetch(WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: "```\n" + content + "```" })
            });
        } catch (e) {
            // Ignore error silently to prevent recursive crash
        }
    }
    
    isFlushing = false;
    if (logBuffer.length > 0) {
        setTimeout(flushLogs, 2000); // 2s rate limit buffer
    }
}

function queueLog(msg) {
    // Escape discord backticks to not break markdown block
    let cleanMsg = msg.replace(/```/g, "'''");
    logBuffer.push(cleanMsg);
    if (logBuffer.length > 200) logBuffer.shift(); // Keep buffer max 200 lines to avoid spam
    if (!isFlushing) setTimeout(flushLogs, 1500);
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function formatArgs(args) {
    return args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
}

// Override console methods to queue to Discord
console.log = function(...args) {
    originalLog.apply(console, args);
    const time = new Date().toISOString().substring(11, 19);
    queueLog(`[${time} INFO] ${formatArgs(args)}`);
};

console.error = function(...args) {
    originalError.apply(console, args);
    const time = new Date().toISOString().substring(11, 19);
    queueLog(`[${time} ERROR] ${formatArgs(args)}`);
};

console.warn = function(...args) {
    originalWarn.apply(console, args);
    const time = new Date().toISOString().substring(11, 19);
    queueLog(`[${time} WARN] ${formatArgs(args)}`);
};
