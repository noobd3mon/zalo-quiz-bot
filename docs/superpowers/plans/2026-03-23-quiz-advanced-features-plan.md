# Quiz Bot Advanced Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement /leaderboard, /hint, /stats, and /daily features for the Zalo Quiz Bot.

**Architecture:** Extend `src/database.js` with new tables, add logic to `src/quiz.js`, and integrate command handlers in `index.js`. Use a modular approach for daily challenge questions.

**Tech Stack:** Node.js, MySQL (mysql2), Zalo Bot API (zca-js).

---

### Task 1: Update Database Schema

**Files:**
- Modify: `src/database.js`

- [ ] **Step 1: Add new table definitions to `initDB`**
  - Add `bot_answer_history`, `bot_daily_questions`, `bot_daily_results`.
  - Ensure UTF8MB4 conversion.
  
- [ ] **Step 2: Run `initDB` via a temporary script or just restart bot**
  - Verify tables are created in the database.

### Task 2: Implement Statistics Tracking

**Files:**
- Modify: `src/quiz.js`

- [ ] **Step 1: Create `recordAnswer` function**
  - Insert record into `bot_answer_history`.
  
- [ ] **Step 2: Update `updateUserAnswerStats` to call `recordAnswer`**
  - Pass question type to track properly.

- [ ] **Step 3: Create `getUserStats` function**
  - Query `bot_answer_history` to calculate accuracy by type and trend.

### Task 3: Implement Hint Logic

**Files:**
- Modify: `src/quiz.js`

- [ ] **Step 1: Create `useHint` function**
  - Check active session.
  - Pick a random wrong answer.
  - Deduct 1 point from `current_score`.
  - Return the wrong option to remove.

### Task 4: Implement Daily Challenge Logic

**Files:**
- Modify: `src/quiz.js`

- [ ] **Step 1: Create `getDailyQuestions` function**
  - Check `bot_daily_questions` for today's date.
  - If empty, generate 10 questions using AI and save.
  
- [ ] **Step 2: Create `getDailySession` and `updateDailySession` functions**
  - Manage progress in `bot_daily_results`.

### Task 5: Implement Leaderboard Logic

**Files:**
- Modify: `src/quiz.js`

- [ ] **Step 1: Create `getGlobalTop10` function**
  - Query `bot_user_scores` ordered by `max_score` DESC LIMIT 10.

- [ ] **Step 2: Create `getGroupTop10` function**
  - Takes a list of member IDs and returns filtered/sorted scores.

### Task 6: Integrate Commands in `index.js`

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add `/top` and `/leaderboard` handler**
  - Support both global (in private) and group (in group) contexts.

- [ ] **Step 2: Add `/hint` handler**
  - Deduct point and show the hint.

- [ ] **Step 3: Add `/stats` handler**
  - Show detailed performance report.

- [ ] **Step 4: Add `/daily` handler**
  - Implement the 10-question sequence flow.
  - Use a separate state check in `handleMessage` to avoid collisions with regular Quiz.

### Task 7: Final Verification & Testing

- [ ] **Step 1: Test `/leaderboard` in private and group**
- [ ] **Step 2: Test `/hint` during a quiz session**
- [ ] **Step 3: Test `/stats` after answering several questions**
- [ ] **Step 4: Test `/daily` flow from start to finish**
- [ ] **Step 5: Verify points are deducted and recorded correctly in DB**
