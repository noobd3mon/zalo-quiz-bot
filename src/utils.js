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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { getCurrentTime, parseZaloTags, sleep };
