# Bot Custom Signature and Font Size Design

## Goal
Add a global font size control and an automatic signature "Coded by Lò Hiếu Kỳ ❤️" in a small font at the end of every bot message.

## Features

### 1. Global Font Size Control
- **Configuration**: The base font size for all bot messages will be set in `src/config.js`.
- **Implementation**: The Zalo message `propertyExt.size` field will be used to set the global font size.

### 2. Automatic Signature
- **Content**: `\n\nCoded by Lò Hiếu Kỳ ❤️`
- **Style**: Always in "Small" font size (`TextStyle.Small`).
- **Implementation**: The signature will be appended to the message text before parsing Zalo tags in `index.js`.

### 3. Enhanced Rich Text Support
- **New Tags**:
    - `<small>`: Maps to `TextStyle.Small` ('f_13').
    - `<big>`: Maps to `TextStyle.Big` ('f_18').
- **Implementation**: Update `src/utils.js` to handle these tags in `parseZaloTags`.

## Technical Implementation Details

### `src/config.js` Update
- Add a new section for bot-wide settings:
    ```javascript
    BOT_CONFIG: {
        fontSize: 15, // Base size for all messages
        signature: "Coded by Lò Hiếu Kỳ ❤️"
    }
    ```

### `src/utils.js` Update
- Update `parseZaloTags(text, defaultFontSize)`:
    - Add `small` and `big` to the regex and the mapping.
    - Map `small` -> `TextStyle.Small`.
    - Map `big` -> `TextStyle.Big`.
    - Return an object with `msg`, `styles`, and `propertyExt`.
    - `propertyExt` will include `size: defaultFontSize`.

### `index.js` Update
- Modify `sendParsedMsg` to:
    - Append `\n\n<small>${config.BOT_CONFIG.signature}</small>` to the input text.
    - Pass `config.BOT_CONFIG.fontSize` to `utils.parseZaloTags`.
    - Pass the resulting `propertyExt` to `api.sendMessage`.

## Success Criteria
- All bot messages have the "Coded by Lò Hiếu Kỳ ❤️" signature at the end.
- The signature is smaller than the main message text.
- The global font size can be easily adjusted in the config file.
