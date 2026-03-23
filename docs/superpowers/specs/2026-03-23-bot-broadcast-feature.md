# Bot Broadcast Feature Design

## Goal
Allow the bot administrator (`ADMIN_ID`) to send update notifications or custom messages to all users who have interacted with the bot.

## Features

### 1. Broadcast Commands (Admin only)
- **`/broadcast update`**:
    - Reads content from `src/update_announcement.txt`.
    - Displays a preview to the Admin.
    - Requires `/confirm-broadcast` to execute.
- **`/broadcast [custom text]`**:
    - Takes custom text directly from the command.
    - Displays a preview to the Admin.
    - Requires `/confirm-broadcast` to execute.
- **`/confirm-broadcast`**:
    - Starts the broadcast process to all users in the `bot_user_scores` table.
    - Uses a 1.5 - 2 second delay between messages to avoid Zalo rate limits.
    - Reports real-time progress (e.g., "Sent to 10/100 users").
    - Reports a final summary (Success/Failure count).

## Data Flow
1. Admin triggers command.
2. Bot prepares message and fetches all `chat_id`s from `bot_user_scores`.
3. Bot stores the message and target list in memory (temporary state).
4. Upon confirmation, Bot iterates through the list with a delay.
5. Bot sends messages using `api.sendMessage`.

## Safety & Rate Limiting
- **Authorization**: Hard-check `userId === config.ADMIN_ID`.
- **Throttling**: 2000ms delay between each `api.sendMessage` call.
- **Error Handling**: Catch and log failed sends without stopping the entire broadcast.

## Initial Content
Prepare `src/update_announcement.txt` with:
- `/leaderboard`: Global & Group rankings.
- `/hint`: Remove wrong answers (cost 1pt).
- `/stats`: Detailed performance & trends.
- `/daily`: 10-question daily challenge.
