# Quiz Bot Advanced Features Design

## Goal
Enhance the Zalo Quiz Bot with competitive, social, and analytical features to increase user engagement and provide better learning insights.

## Features

### 1. Leaderboard (`/leaderboard` or `/top`)
- **Global Leaderboard**: Top 10 users across the entire system based on `max_score`.
- **Group Leaderboard**: Top users within the current Zalo group.
- **Implementation**: 
    - Query `bot_user_scores` for global top 10.
    - For group leaderboard, fetch member IDs from Zalo API, then filter and sort from `bot_user_scores`.

### 2. Hint System (`/hint`)
- **Functionality**: Removes one incorrect option from the current question ABCD.
- **Cost**: Deducts 1 point from the `current_score` in the active session.
- **Constraint**: Only available if a session is active and has a question. Max 3 hints per question (optional, but 1 is usually enough).

### 3. Detailed Statistics (`/stats` or `/s`)
- **Tracking**: Record every answer in a new `bot_answer_history` table.
- **Metrics**:
    - Accuracy % per category (Stress, Pronunciation, Vocabulary, Word Form).
    - Improvement trend: Compare accuracy of the last 20 questions vs. lifetime average.
- **UI**: Text-based summary with emojis.

### 4. Daily Challenge (`/daily`)
- **Format**: A fixed set of 10 questions every day, identical for all users.
- **Reset**: Resets at 00:00 (Vietnam Time).
- **Generation**: AI generates the 10 questions once per day (the first user to call `/daily` triggers generation).
- **Participation**: Users can play only once per day.
- **Leaderboard**: Separate daily leaderboard.

## Data Schema Changes

### New Tables

#### `bot_answer_history`
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | INT AUTO_INCREMENT | Primary Key |
| `chat_id` | VARCHAR(255) | User ID |
| `q_type` | VARCHAR(50) | Question type (stress, vocab, etc.) |
| `is_correct` | TINYINT | 1 for correct, 0 for incorrect |
| `answered_at` | DATETIME | Timestamp |

#### `bot_daily_questions`
| Column | Type | Description |
| :--- | :--- | :--- |
| `day` | DATE | Primary Key (YYYY-MM-DD) |
| `questions` | JSON | Array of 10 question objects |
| `created_at` | DATETIME | Timestamp |

#### `bot_daily_results`
| Column | Type | Description |
| :--- | :--- | :--- |
| `chat_id` | VARCHAR(255) | User ID |
| `day` | DATE | Date of challenge |
| `score` | INT | Number of correct answers (0-10) |
| `current_index` | INT | Current question index (0-9) |
| `is_completed` | TINYINT | 1 if finished |
| `completed_at` | DATETIME | Timestamp |

## Technical Implementation Details

### `/hint` Logic
- Check `bot_quiz_sessions` for active question.
- Randomly pick an option that is NOT the correct answer.
- Update `current_score = current_score - 1`.
- Inform user which option is incorrect.

### Statistics Collection
- Wrap answer processing to insert into `bot_answer_history`.

### Daily Challenge Flow
- `00:00` check: If `bot_daily_questions` for today is empty, call AI 10 times or once with a prompt for 10 questions.
- User session for `/daily` is separate from regular `/quiz`.
- Use a state machine or separate session table (`bot_daily_results`) to track progress.

## Success Criteria
- Users can view their rank globally and in groups.
- Hints are functional and deduct points correctly.
- Statistics accurately reflect performance by type.
- Daily challenge is consistent for all users and limited to one try.
