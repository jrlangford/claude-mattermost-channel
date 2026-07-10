---
name: configure
description: Set up the Mattermost channel — save bot tokens, server URLs, manage multiple bots, and review access policy. Use when the user pastes a Mattermost bot token, asks to configure Mattermost, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /mattermost:configure — Mattermost Channel Setup

Manages bot configuration for the Mattermost channel plugin. Supports
multiple bots via `~/.claude/channels/mattermost/bots.json`.

Arguments passed: `$ARGUMENTS`

---

## Config format

**`bots.json`** (preferred, supports multiple bots):
```json
[
  {
    "name": "amelia",
    "url": "https://mattermost.example.com",
    "token": "abc123...",
    "userId": "def456..."
  }
]
```

**`.env`** (legacy single-bot, still supported as fallback if `bots.json` absent):
```
MM_URL=https://mattermost.example.com
MM_BOT_TOKEN=abc123...
MM_BOT_USER_ID=def456...
```

When `bots.json` exists, the server uses it and ignores `.env`.

---

## Dispatch on arguments

### No args — status and guidance

Read both config files and give the user a complete picture:

1. **Bots** — check `~/.claude/channels/mattermost/bots.json` first. If it
   exists, list each bot: name, URL (masked token — first 6 chars + `...`),
   userId. If no `bots.json`, check `.env` for the legacy single-bot config.
   Show the effective bot count.

2. **Access** — read `~/.claude/channels/mattermost/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count and list of user IDs
   - Pending pairings: count, with codes and sender IDs if any
   - Group channels opted in: count and channel IDs

3. **What next** — end with a concrete next step based on state:
   - No bots → *"Run `/mattermost:configure add <name> <url> <token> <userId>`
     to add your first bot."*
   - Bots set, policy is pairing, nobody allowed → *"DM your bot on
     Mattermost. It replies with a code; approve with `/mattermost:access pair
     <code>`."*
   - Bots set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** Once all intended users are paired,
recommend switching to `allowlist` policy via `/mattermost:access policy allowlist`.

### `add <name> <url> <token> <userId>` — add a bot

1. `mkdir -p ~/.claude/channels/mattermost`
2. Read existing `bots.json` if present (default to `[]`).
3. Check for duplicate name — if found, update in place.
4. Append `{ name, url, token, userId }` to the array.
5. Write back as pretty JSON. `chmod 600 bots.json`.
6. Confirm, then show status.
7. Remind: *"Restart the session or run `/reload-plugins` to pick up the new bot."*

### `remove <name>` — remove a bot

1. Read `bots.json`. Filter out the entry with matching name.
2. If array is now empty, delete the file.
3. Otherwise write back. `chmod 600 bots.json`.
4. Confirm.
5. Remind about restart.

### `<token>` — legacy single-arg (save to bots.json as "default")

If a single argument is passed that looks like a Mattermost personal access
token (26-char alphanumeric string):

1. `mkdir -p ~/.claude/channels/mattermost`
2. Read existing `bots.json` if present. Find entry named "default" and update
   its token, or create `[{ name: "default", url: "http://localhost:8065", token, userId: "" }]`.
3. Write `bots.json`. `chmod 600`.
4. Confirm, then show status.
5. Remind: *"You also need `url` and `userId`. Run
   `/mattermost:configure add default <url> <token> <userId>` with all fields,
   or edit `~/.claude/channels/mattermost/bots.json` directly."*

### `<url> <token> <userId>` — legacy three-arg (save as "default")

If three arguments are passed:

1. `mkdir -p ~/.claude/channels/mattermost`
2. Read existing `bots.json`. Find entry named "default" and update, or create
   `[{ name: "default", url, token, userId }]`.
3. Write `bots.json`. `chmod 600`.
4. Confirm, then show status.

### `clear` — remove all credentials

Delete both `~/.claude/channels/mattermost/bots.json` and `.env` if they exist.

---

## Migration note

If `.env` exists but `bots.json` does not, the server still works (single-bot
fallback). Offer to migrate: *"You have a legacy .env config. Want me to
migrate it to bots.json? This enables multi-bot support."* If yes, read `.env`,
create `bots.json` with a single "default" entry, and rename `.env` to
`.env.bak`.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `bots.json` (or `.env`) once at boot. Config changes need a
  session restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/mattermost:access` take effect immediately, no restart.
- Bot names must be unique within `bots.json`.
- Set file permissions to `0o600` for `bots.json` (contains tokens).
