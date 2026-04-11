const { ThreadType } = require('zca-js');
const utils = require('./utils');
const ai = require('./ai');

// Lưu trạng thái live của các khóa học (Cache)
// Key: courseId, Value: true/false
const liveStatusCache = new Map();

function decodeJsString(str) {
    let jsonStr = str.replace(/\\x([0-9A-Fa-f]{2})/g, '\\u00$1');
    try { return JSON.parse('"' + jsonStr + '"'); } catch (e) { return str; }
}

async function fetchViaCodeTabs(targetUrl) {
    const proxyUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error("Lỗi kết nối tới CodeTabs proxy");
    return await res.text();
}

/**
 * Pings the HLS URL to check if it's currently live.
 * 200 OK + #EXTM3U usually means live.
 */
async function isStreamLive(streamUrl) {
    try {
        const res = await fetch(streamUrl, {
            method: 'GET',
            headers: {
                // Thêm User-Agent để tránh bị block bởi server stream
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
            },
            // Timeout ngắn để tránh bị treo nếu stream m3u8 down timeout
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) return false;
        
        const text = await res.text();
        return text.includes('#EXTM3U');
    } catch (error) {
        return false;
    }
}

/**
 * Trích xuất danh sách các phòng từ source
 */
async function scrapeCourses() {
    let jsUrl = "https://tenschool.vn/_next/static/chunks/app/user/class/page-7a3475eaf0ff1155.js";
    try {
        // Cố gắng tìm chunk JS mới nhất từ trang html
        const htmlCode = await fetchViaCodeTabs('https://tenschool.vn/user/class');
        const matchChunk = htmlCode.match(/src="(\/_next\/static\/chunks\/app\/user\/class\/page-[^"]+\.js)"/);
        if (matchChunk && matchChunk[1]) {
            jsUrl = "https://tenschool.vn" + matchChunk[1];
        }
    } catch (e) {
        console.warn("[TenSchool Live] Lỗi đọc trang chủ, sử dụng link JS mặc định.");
    }

    const jsCode = await fetchViaCodeTabs(jsUrl);
    const courses = [];
    const regex = /courseId:\s*"([^"]+)",\s*courseTitle:\s*"((?:[^"\\]|\\.)*)",.*?bytePlusStreamPull:\s*"([^"]+)",.*?thumbnail:\s*"([^"]+)"/gs;
    
    let match;
    while ((match = regex.exec(jsCode)) !== null) {
        let thumbnail = match[4];
        if (thumbnail.startsWith('/')) thumbnail = 'https://tenschool.vn' + thumbnail;
        courses.push({
            courseId: match[1],
            courseTitle: decodeJsString(match[2]),
            bytePlusStreamPull: match[3]
        });
    }

    return courses;
}

/**
 * Láy danh sách các group_id đã đăng ký thông báo từ DB
 */
async function getSubscribedGroups(db) {
    try {
        const rows = await db.allQuery("SELECT group_id FROM bot_tenschool_groups_config WHERE enabled = 1");
        return rows.map(r => r.group_id);
    } catch (e) {
        console.error("[TenSchool Live] Lỗi lấy danh sách nhóm:", e);
        return [];
    }
}

async function checkAndNotify(api, db) {
    try {
        const courses = await scrapeCourses();
        if (courses.length === 0) return;

        let anyNewLive = false;
        const newlyLiveCourses = [];

        for (const course of courses) {
            const currentlyLive = await isStreamLive(course.bytePlusStreamPull);
            const wasLive = liveStatusCache.get(course.courseId) || false;

            // Nếu trạng thái đổi từ offline -> online
            if (currentlyLive && !wasLive) {
                newlyLiveCourses.push(course);
                liveStatusCache.set(course.courseId, true);
                anyNewLive = true;
            } 
            // Nếu stream đã tắt
            else if (!currentlyLive && wasLive) {
                liveStatusCache.set(course.courseId, false);
            }
        }

        if (anyNewLive) {
            const groupIds = await getSubscribedGroups(db);
            if (groupIds.length === 0) return;

            for (const course of newlyLiveCourses) {
                const messageText = `🔴 <b>TenSchool Live!</b>\n━━━━━━━━━━━━━━━━━━━━\nGiáo viên vừa mở live môn:\n📖 <b>${course.courseTitle}</b>\n\n👉 @All Vào xem trực tiếp ngay tại trang web/app TenSchool!\nhttps://cungtienbo.ddns.net/Custom/tenschool/xemlive.html`;
                
                // Parse tags format cho Zalo
                const payload = utils.parseZaloTags(messageText, 15);

                // Gắn Mention @All chuẩn cho ZCA-JS
                const mentionText = "@All";
                const mPos = payload.msg.indexOf(mentionText);
                if (mPos !== -1) {
                    payload.mentions = [{
                        pos: mPos,
                        uid: "-1",
                        len: mentionText.length
                    }];
                }

                for (const groupId of groupIds) {
                    try {
                        await ai.executeWithRetry("Zalo_Broadcast_Tenschool", () => api.sendMessage(payload, groupId, ThreadType.Group), 3);
                        await utils.sleep(2000); // Tránh spam quá nhanh
                    } catch (err) {
                        console.error(`[TenSchool Live] Lỗi gửi thông báo cho nhóm ${groupId}:`, err.message);
                    }
                }
            }
        }

    } catch (error) {
        console.error("[TenSchool Live] Lỗi trong chu trình kiểm tra:", error.message);
    }
}

let pollingIntervalId = null;

function startPolling(api, db, intervalMs = 3 * 60 * 1000) {
    // Clear previous polling interval if any (prevents stacking on reconnect)
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
    }

    console.log(`[TenSchool Live] Bắt đầu chạy ngầm kiểm tra Live Stream mỗi ${intervalMs / 1000} giây.`);

    // Gọi thử luôn 1 lần khi start
    checkAndNotify(api, db).catch(() => {});

    pollingIntervalId = setInterval(() => {
        checkAndNotify(api, db);
    }, intervalMs);
}

function stopPolling() {
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
        console.log("[TenSchool Live] Đã dừng polling.");
    }
}

module.exports = {
    startPolling,
    stopPolling
};
