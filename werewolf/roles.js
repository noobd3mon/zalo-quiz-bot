const db = require('./db.js');

class Role {
    constructor(playerData) {
        this.group_id = playerData.group_id;
        this.user_id = playerData.user_id;
        this.name_display = playerData.name || '';
        this.role = playerData.role || 'Villager';
        this.is_alive = playerData.is_alive !== undefined ? playerData.is_alive : 1;
        this.lover_id = playerData.lover_id;
        this.status = typeof playerData.status === 'string' ? JSON.parse(playerData.status || '{}') : (playerData.status || {});
    }

    get name() { return 'Villager'; }
    get party() { return 'Villager'; }
    get emoji() { return '👨‍🌾'; }
    get description() { return `Bạn là ${this.emoji} DÂN LÀNG bình thường. Không có kỹ năng đặc biệt. Hãy dùng trí thông minh để tìm ra Ma Sói vào ban ngày!`; }

    async save() {
        await db.savePlayer({
            group_id: this.group_id,
            user_id: this.user_id,
            name: this.name_display,
            role: this.role,
            is_alive: this.is_alive,
            lover_id: this.lover_id,
            status: this.status
        });
    }

    async onNightAction(targetId, extra) {
        return false;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PHE SÓI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class Werewolf extends Role {
    get name() { return 'Werewolf'; }
    get party() { return 'Werewolf'; }
    get emoji() { return '🐺'; }
    get description() { return `Bạn là ${this.emoji} MA SÓI!\n\n🔪 Kỹ năng: Mỗi đêm, cùng đồng đội chọn 1 mục tiêu để cắn.\n📝 Lệnh: /ww kill <STT>`; }
    
    async onNightAction(targetId, extra) {
        await db.runQuery(
            "INSERT INTO bot_ww_night_actions (group_id, day, user_id, action_type, target_id) VALUES (?, ?, ?, 'KILL', ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)",
            [this.group_id, extra.day, this.user_id, targetId]
        );
        return true;
    }
}

class Lycan extends Role {
    get name() { return 'Lycan'; }
    get party() { return 'Werewolf'; }
    get emoji() { return '🐺'; }
    get description() { return `Bạn là ${this.emoji} SÓI NGỤ TRANG!\n\n🔪 Kỹ năng: Giống Ma Sói thường, nhưng Tiên Tri soi bạn sẽ thấy "KHÔNG PHẢI SÓI".\n📝 Lệnh: /ww kill <STT>`; }
    get appearsAsWolf() { return false; } // Tiên tri soi ra "không phải sói"
    
    async onNightAction(targetId, extra) {
        await db.runQuery(
            "INSERT INTO bot_ww_night_actions (group_id, day, user_id, action_type, target_id) VALUES (?, ?, ?, 'KILL', ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)",
            [this.group_id, extra.day, this.user_id, targetId]
        );
        return true;
    }
}

class WolfSeer extends Role {
    get name() { return 'WolfSeer'; }
    get party() { return 'Werewolf'; }
    get emoji() { return '🐺👁'; }
    get description() { return `Bạn là ${this.emoji} SÓI TIÊN TRI!\n\n🔪 Kỹ năng 1: Cắn giống Sói thường.\n👁 Kỹ năng 2: Soi 1 người mỗi đêm (kết quả trả về ngay).\n📝 Lệnh cắn: /ww kill <STT>\n📝 Lệnh soi: /ww see <STT>`; }

    async onNightAction(targetId, extra) {
        const actionType = extra.action === 'SEE' ? 'SEE' : 'KILL';
        await db.runQuery(
            "INSERT INTO bot_ww_night_actions (group_id, day, user_id, action_type, target_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)",
            [this.group_id, extra.day, this.user_id, actionType, targetId]
        );
        return true;
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PHE DÂN LÀNG
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class Seer extends Role {
    get name() { return 'Seer'; }
    get party() { return 'Villager'; }
    get emoji() { return '👁'; }
    get description() { return `Bạn là ${this.emoji} TIÊN TRI!\n\n🔮 Kỹ năng: Mỗi đêm, soi 1 người để biết họ là Sói hay không.\n📝 Lệnh: /ww see <STT>`; }
    
    async onNightAction(targetId, extra) {
        await db.runQuery(
            "INSERT INTO bot_ww_night_actions (group_id, day, user_id, action_type, target_id) VALUES (?, ?, ?, 'SEE', ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)",
            [this.group_id, extra.day, this.user_id, targetId]
        );
        return true;
    }
}

class Guard extends Role {
    get name() { return 'Guard'; }
    get party() { return 'Villager'; }
    get emoji() { return '🛡'; }
    get description() { return `Bạn là ${this.emoji} BẢO VỆ!\n\n🛡 Kỹ năng: Mỗi đêm, bảo vệ 1 người khỏi bị Sói cắn chết.\n⚠️ Không thể bảo vệ cùng 1 người 2 đêm liên tiếp.\n📝 Lệnh: /ww guard <STT>`; }

    async onNightAction(targetId, extra) {
        await db.runQuery(
            "INSERT INTO bot_ww_night_actions (group_id, day, user_id, action_type, target_id) VALUES (?, ?, ?, 'GUARD', ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id)",
            [this.group_id, extra.day, this.user_id, targetId]
        );
        return true;
    }
}

class Witch extends Role {
    get name() { return 'Witch'; }
    get party() { return 'Villager'; }
    get emoji() { return '🧙‍♀️'; }
    get description() { return `Bạn là ${this.emoji} PHÙ THỦY!\n\n🧪 Kỹ năng: Có 1 thuốc CỨU và 1 thuốc ĐỘC (dùng 1 lần duy nhất mỗi loại).\n📝 Lệnh cứu: /ww witch heal <STT>\n📝 Lệnh giết: /ww witch poison <STT>\n📝 Bỏ qua: /ww witch skip`; }
    
    async onNightAction(targetId, extra) {
        await db.runQuery(
            "INSERT INTO bot_ww_night_actions (group_id, day, user_id, action_type, target_id) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE action_type = VALUES(action_type), target_id = VALUES(target_id)",
            [this.group_id, extra.day, this.user_id, extra.action, targetId || null]
        );
        return true;
    }
}

class Cupid extends Role {
    get name() { return 'Cupid'; }
    get party() { return 'Villager'; }
    get emoji() { return '💘'; }
    get description() { return `Bạn là ${this.emoji} THẦN TÌNH YÊU!\n\n💞 Kỹ năng: Đêm đầu tiên, ghép đôi 2 người. Nếu 1 người chết, người kia cũng chết theo.\n📝 Lệnh: /ship <STT1> <STT2>`; }

    async onNightAction(targetId, extra) {
        // targetId = first player, extra.target2 = second player
        await db.runQuery(
            "INSERT INTO bot_ww_night_actions (group_id, day, user_id, action_type, target_id, extra) VALUES (?, ?, ?, 'SHIP', ?, ?) ON DUPLICATE KEY UPDATE target_id = VALUES(target_id), extra = VALUES(extra)",
            [this.group_id, extra.day, this.user_id, targetId, JSON.stringify({ target2: extra.target2 })]
        );
        return true;
    }
}

class Hunter extends Role {
    get name() { return 'Hunter'; }
    get party() { return 'Villager'; }
    get emoji() { return '🔫'; }
    get description() { return `Bạn là ${this.emoji} THỢ SĂN!\n\n💥 Kỹ năng: Khi bạn chết (bị Sói cắn hoặc bị treo cổ), bạn lập tức bắn chết 1 người trước khi nhắm mắt.\n📝 Kỹ năng tự động kích hoạt khi bạn tử nạn.`; }
}

class Elder extends Role {
    get name() { return 'Elder'; }
    get party() { return 'Villager'; }
    get emoji() { return '👴'; }
    get description() { return `Bạn là ${this.emoji} GIÀ LÀNG!\n\n❤️ Kỹ năng: Bạn sống sót lần đầu tiên bị Sói cắn. Lần thứ 2 mới chết.\n📝 Kỹ năng tự động (passive).`; }
}

class Idiot extends Role {
    get name() { return 'Idiot'; }
    get party() { return 'Villager'; }
    get emoji() { return '🤡'; }
    get description() { return `Bạn là ${this.emoji} THẰNG NGỐC!\n\n🃏 Kỹ năng: Nếu bị dân làng treo cổ, bạn lật bài lên và SỐNG SÓT nhưng mất quyền vote từ đó trở đi.\n📝 Kỹ năng tự động.`; }
}

class Cursed extends Role {
    get name() { return 'Cursed'; }
    get party() { return 'Villager'; } // Ban đầu là dân
    get emoji() { return '😈'; }
    get description() { return `Bạn là ${this.emoji} DÂN BỊ NGUYỀN!\n\n🌑 Kỹ năng: Bạn bắt đầu là Dân Làng. Nhưng nếu bị Sói cắn, thay vì chết bạn sẽ HÓA SÓI và chiến đấu cho phe Sói!\n📝 Kỹ năng tự động.`; }
}

function createRoleObject(playerData) {
    if (!playerData) return null;
    switch (playerData.role) {
        case 'Werewolf': return new Werewolf(playerData);
        case 'Lycan': return new Lycan(playerData);
        case 'WolfSeer': return new WolfSeer(playerData);
        case 'Seer': return new Seer(playerData);
        case 'Guard': return new Guard(playerData);
        case 'Witch': return new Witch(playerData);
        case 'Cupid': return new Cupid(playerData);
        case 'Hunter': return new Hunter(playerData);
        case 'Elder': return new Elder(playerData);
        case 'Idiot': return new Idiot(playerData);
        case 'Cursed': return new Cursed(playerData);
        default: return new Role(playerData); // Villager
    }
}

module.exports = { Role, Werewolf, Lycan, WolfSeer, Seer, Guard, Witch, Cupid, Hunter, Elder, Idiot, Cursed, createRoleObject };
