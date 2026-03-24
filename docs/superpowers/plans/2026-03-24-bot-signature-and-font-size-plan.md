# Bot Custom Signature and Font Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a custom signature and global font size control for all bot messages.

**Architecture:** Update `src/config.js` for settings, `src/utils.js` for tag parsing and `propertyExt` construction, and `index.js` for message integration.

**Tech Stack:** Node.js, zca-js.

---

### Task 1: Update Configuration

**Files:**
- Modify: `src/config.js`

- [ ] **Step 1: Add `BOT_CONFIG` section**
  - Add `fontSize: 15`.
  - Add `signature: "Coded by Lò Hiếu Kỳ ❤️"`.
  - Add `includeSignature: true`.

### Task 2: Enhance Tag Parsing in `src/utils.js`

**Files:**
- Modify: `src/utils.js`

- [ ] **Step 1: Update `parseZaloTags` signature and logic**
  - Add `defaultFontSize` as the second parameter.
  - Add `small` and `big` to the `regex` and `tagStack` logic.
  - Map `small` -> `TextStyle.Small` and `big` -> `TextStyle.Big`.
  - Construct `propertyExt` with `size: defaultFontSize`.
  - Return `{ msg, styles, propertyExt }`.

### Task 3: Integrate into `index.js`

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Update `sendParsedMsg` to append signature**
  - Read `config.BOT_CONFIG`.
  - Append `\n\n<small>${signature}</small>` to `msgText` if `includeSignature` is true.
  - Pass `fontSize` to `utils.parseZaloTags`.
  - Pass the complete `payload` (including `propertyExt`) to `api.sendMessage`.

### Task 4: Final Verification

- [ ] **Step 1: Check bot messages for the signature**
- [ ] **Step 2: Test `<small>` and `<big>` tags in a quiz question or broadcast**
- [ ] **Step 3: Verify the global font size changes in the config file**
