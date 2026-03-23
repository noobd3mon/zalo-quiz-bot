# Bot Broadcast Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a broadcast system for the Bot Administrator to send update notifications or custom messages to all users.

**Architecture:** 
- `src/utils.js`: Add a sleep utility.
- `src/quiz.js`: Add `getAllUserIds` helper.
- `index.js`: Implement `/broadcast`, `/broadcast update`, and `/confirm-broadcast` commands with rate limiting.

**Tech Stack:** Node.js, mysql2, zca-js.

---

### Task 1: Utility & Database Helpers

**Files:**
- Modify: `src/utils.js`
- Modify: `src/quiz.js`

- [ ] **Step 1: Add `sleep(ms)` to `src/utils.js`**
  ```javascript
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  ```
- [ ] **Step 2: Add `getAllUserIds()` to `src/quiz.js`**
  ```javascript
  async function getAllUserIds() {
      const rows = await db.allQuery("SELECT chat_id FROM bot_user_scores");
      return rows.map(r => r.chat_id);
  }
  ```

### Task 2: Command Implementation in index.js

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Setup temporary broadcast state (memory)**
  ```javascript
  let pendingBroadcast = null; // { messageText: string, targets: string[] }
  ```
- [ ] **Step 2: Implement `/broadcast` and `/broadcast update`**
  - Check `userId === config.ADMIN_ID`.
  - For `update`: Read from `src/update_announcement.txt`.
  - For custom: Take text from args.
  - Store in `pendingBroadcast`.
  - Show preview to Admin.
- [ ] **Step 3: Implement `/confirm-broadcast`**
  - Check `userId === config.ADMIN_ID` and `pendingBroadcast`.
  - Iterate through `pendingBroadcast.targets`.
  - Use `sleep(2000)` between sends.
  - Update Admin on progress every 5-10 users.
  - Final report (Success/Fail).

### Task 4: Final Verification

- [ ] **Step 1: Test `/broadcast update` (Admin only)**
- [ ] **Step 2: Test `/broadcast hello world` (Admin only)**
- [ ] **Step 3: Test `/confirm-broadcast` (with 2-3 dummy IDs in DB)**
- [ ] **Step 4: Verify rate limiting (should be 2 seconds per message)**
