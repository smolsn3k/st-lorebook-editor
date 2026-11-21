# Lorebook Editor

A SillyTavern extension for editing many lorebook entries at once. Pick one or more lorebooks, then mass-edit entry settings or generate keywords with AI.

Works on desktop and mobile.

## Features

- **Mass edit entry settings** across any number of lorebooks: Enabled, Constant, Vectorized, Ignore budget, Non-recursable, Prevent further recursion, Delay until recursion, Case-sensitive, Match whole words, Group scoring.
- **Mass edit values**: Position, Depth, Depth role, Order, Trigger %, Scan depth, Sticky, Cooldown, Delay.
- **Apply to** all entries, or only a subset (without keywords, enabled, disabled, constant, non-constant, or title/keywords containing some text).
- **Preview** shows how many entries would change before you apply anything.
- **Keyword generation** with AI, using any of your API profiles or the current connection.
- Searchable lorebook list, responsive layout, large tap targets for mobile.

## Installation

1. Open SillyTavern and go to the **Extensions** panel (the stacked-blocks icon).
2. Click **Install extension**.
3. Paste this URL and confirm:

   ```
   https://github.com/smolsn3k/st-lbnonrec
   ```

4. Reload SillyTavern if it doesn't refresh on its own.

To update later, open **Manage extensions** in the Extensions panel and update it from there.

## Opening the editor

Either:

- the **Lorebook Editor** entry in the Extensions panel, then **Open Lorebook Editor**, or
- the **Lorebook Editor** item in the magic wand menu next to the chat input.

## Usage

### Entry settings

1. Tick the lorebooks you want to edit.
2. Choose which entries to touch under **Apply to**.
3. In **Entry settings**, set each option you care about:
   - **—** leaves it unchanged (default)
   - **On** turns it on for every matching entry
   - **Off** turns it off for every matching entry
4. Optionally fill in any of the **Values** fields. Empty fields are left unchanged.
5. Press **Preview** to see how many entries would change, then **Apply**.

Entries that already have the requested state are skipped, and a lorebook is only saved if something actually changed.

> If a lorebook is open in the World Info editor while it gets changed, reopen it to see the updated values.

### Keywords

1. Pick an **API profile** from the dropdown. Press **Update** if you just created or changed a profile. Leave it on *Current connection* to use whatever API you're connected to right now.
2. Choose a **Mode**:
   - *Only fill entries without keywords* (default)
   - *Add to existing keywords*
   - *Replace existing keywords*
3. Set the maximum number of keywords, and optionally add extra instructions (for example, "keywords in English" or "include nicknames").
4. Press **Generate keywords**. Progress and the generated keywords show in the log. Use **Stop** to cancel; results so far are saved.

Entries are processed one at a time. Entries with empty content are skipped, and constant entries are skipped by default since they don't need keywords. If three requests fail in a row, the run stops so you don't burn through your API.

**Requirements for API profiles:** the built-in *Connection Manager* extension must be enabled and have at least one profile. Without it, the editor falls back to the current connection.

## Notes

- Options map to the lorebook entry fields in SillyTavern (for example, Non-recursable is `excludeRecursion`, Enabled is the inverse of `disable`).
- All settings are stored in your SillyTavern settings.
- Changes are saved directly to your lorebooks, so consider exporting a backup before large bulk edits.

## License

Add the license of your choice here (for example MIT).
