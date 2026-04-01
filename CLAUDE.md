# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Zalo Bot - A multi-feature chatbot for Zalo messenger with educational quiz games and social games.

## Tech Stack

- **Runtime**: Node.js
- **Zalo SDK**: `zca-js`
- **Database**: MySQL (via `mysql2` with connection pooling)
- **AI**: OpenAI SDK (`openai`) connecting to Groq API
- **Utilities**: `dotenv`

## Commands

```bash
# Start the bot
node index.js

# Environment setup
# Copy .env.example to .env and configure:
# - GROQ_API_KEYS (comma-separated for rotation)
# - DB_HOST, DB_USER, DB_PASS, DB_NAME
# - ZALO_COOKIE, ZALO_IMEI, ZALO_USER_AGENT
# - ADMIN_ID
```

## Architecture

### Modular Structure (`src/`)

```
src/
├── config.js       # Environment variables, API keys, DB/Zalo config
├── database.js     # MySQL pool, query helpers (runQuery, getQuery, allQuery), table initialization
├── ai.js           # Groq client with API key rotation, rate limit cooldowns, retry logic
├── quiz.js         # Quiz game logic: question generation, sessions, stats, leaderboard, daily challenges
├── wordchain.js    # Word chain game: Vietnamese/English dictionary lookups, game state
└── utils.js        # Zalo message parser (parseZaloTags), time helpers
```

### Game Modules

- **werewolf/** - Complete Werewolf (Ma Sói) game implementation
  - `db.js`: Game database layer
  - `game.js`: Core game logic, role assignment, phase management
  - `roles.js`: Role classes (Werewolf, Seer, Guard, Witch, etc.)
  - `index.js`: Message handlers for group/private commands

### Key Design Patterns

1. **Message Queue Per Thread**: All messages are queued per `threadId` to ensure sequential processing. Inactive queues are cleaned up after 5 minutes to prevent memory leak (`index.js:14-52`)

2. **API Key Rotation**: Multiple Groq API keys with automatic rotation, 60s cooldown, and cached client instance. Throws error when all keys are in cooldown (`src/ai.js`)

3. **OpenAI Client Cache**: Single cached client instance reused across calls; only recreated when rotating keys to reduce memory allocation (`src/ai.js:6-35`)

4. **Question Prefetch Pool**: Maintains a pool of 3 prefetched quiz questions per thread for instant response (`src/quiz.js:375-397`)

5. **Dictionary Caching**: In-memory cache for word lookups to reduce external API calls (`src/wordchain.js:4-8`)

6. **Auto-Reconnect**: Exponential backoff (1s-60s) with jitter for Zalo listener disconnections. Max 10 attempts (`index.js:670-710`)

## Database Tables

- `bot_user_scores` - User quiz stats (max_score, streaks, accuracy)
- `bot_quiz_sessions` - Active quiz sessions per thread
- `bot_question_history` / `bot_answer_history` - Question/answer history for stats
- `bot_daily_questions` / `bot_daily_results` - Daily challenge system
- `bot_group_settings` - Group-specific settings (wordchain enabled/mode)
- `bot_wordchain_state` / `bot_wordchain_history` - Word chain game state
- `bot_ww_*` - Werewolf game tables (games, players, votes, night_actions)

## Common Commands (In-Bot)

```
/quiz or /q     - Start quiz game
/daily          - Daily 10-question challenge
/review         - Review incorrect answers (flashcard mode)
/hint           - Remove one wrong option (-1 point)
/level [A1-C2]  - Set difficulty level
/mode [type]    - Set question type (random, tuvung, trongam, phatam, wordform)
/stats          - Detailed accuracy statistics
/top            - Global leaderboard

/wordchain on/off  - Enable Vietnamese word chain in groups
/wc on/off         - Enable English word chain in groups
/nghia             - Show meaning of current word
/voteskip          - Vote to skip difficult word

/ww create      - Create Werewolf game room
/ww join        - Join game
/ww start       - Start game (admin only)
/ww roles       - Show all role descriptions
```

## Implementation Notes

- All database queries use parameterized statements to prevent SQL injection
- Zalo message formatting uses custom XML-like tags: `<b>`, `<u>`, `<red>`, `<green>`, `<small>`, `<big>`
- Signature and font size are configurable via `BOT_CONFIG` in `src/config.js`
- Werewolf game uses a 5-second tick interval (`gameTick`) to check timer expirations
- Rate limiting: 1 second throttle between messages per thread (`index.js:98-109`)
