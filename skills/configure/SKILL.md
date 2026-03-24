---
name: configure
description: Set up the Mattermost channel — save the bot token, server URL, and review access policy. Use when the user pastes a Mattermost bot token, asks to configure Mattermost, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /mattermost:configure — Mattermost Channel Setup

Writes the bot token and server URL to `~/.claude/channels/mattermost/.env`
and orients the user on access policy. The server reads the env file at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Token** — check `~/.claude/channels/mattermost/.env` for
   `MM_BOT_TOKEN`. Show set/not-set; if set, show first 6 chars masked.
   Also check `MM_URL` and `MM_BOT_USER_ID`.

2. **Access** — read `~/.claude/channels/mattermost/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count and list of user IDs
   - Pending pairings: count, with codes and sender IDs if any
   - Group channels opted in: count and channel IDs

3. **What next** — end with a concrete next step based on state:
   - No token → *"Run `/mattermost:configure <token>` with your bot's
     personal access token from Mattermost > Integrations > Bot Accounts."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Mattermost. It replies with a code; approve with `/mattermost:access pair
     <code>`."*
   - Token set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** Once all intended users are paired,
recommend switching to `allowlist` policy via `/mattermost:access policy allowlist`.

### `<token>` — save it

If a single argument is passed that looks like a Mattermost personal access
token (26-char alphanumeric string):

1. `mkdir -p ~/.claude/channels/mattermost`
2. Read existing `.env` if present; update/add the `MM_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
3. `chmod 600 ~/.claude/channels/mattermost/.env`
4. Confirm, then show the no-args status.
5. Remind: *"You also need `MM_URL` and `MM_BOT_USER_ID` in the .env file.
   Set MM_URL to your Mattermost server URL (e.g. http://localhost:8065)
   and MM_BOT_USER_ID to the bot's user ID."*

### `<url> <token> <bot_user_id>` — save all three

If three arguments are passed:

1. `mkdir -p ~/.claude/channels/mattermost`
2. Write `.env` with all three values:
   ```
   MM_URL=<url>
   MM_BOT_TOKEN=<token>
   MM_BOT_USER_ID=<bot_user_id>
   ```
3. `chmod 600 ~/.claude/channels/mattermost/.env`
4. Confirm, then show the no-args status.

### `clear` — remove credentials

Delete `~/.claude/channels/mattermost/.env`.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Token changes need a session restart
  or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/mattermost:access` take effect immediately, no restart.
