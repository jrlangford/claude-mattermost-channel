project_dir := justfile_directory()

# Originally inherited from Amelia's mattermost-integration tooling at
# handover (2026-07-04); reshaped for the lego-bot monorepo (apps/bot +
# packages/*). The MM server stack stays hers.

default:
    @just --list

# Run the polymorphic bot with a config file.
bot CONFIG:
    cd {{project_dir}} && bun apps/bot/main.ts {{CONFIG}}

# Launch a Claude Code session with apps/bot as the channel plugin (dev
# loop: test changes without touching the marketplace cache the fleet runs).
# Uses ~/.channel-bot/bot.config.json (see /channel:configure).
claude-channel:
    cd {{project_dir}} && claude --plugin-dir {{project_dir}}/apps/bot --dangerously-load-development-channels server:channel

# Manage bot access control (pairing/allowlists; BOT_STATE_DIR-aware).
access *ARGS:
    cd {{project_dir}} && bun packages/bot/access-cli.ts {{ARGS}}

# Type-check / smoke + unit tests across the whole workspace (via turbo).
check:
    cd {{project_dir}} && bun run check
    cd {{project_dir}} && bun run test
    @echo "check OK"

# Transport integration tests (docker compose; real Mattermost / Synapse).
integration:
    cd {{project_dir}}/packages/mattermost-client && bash integration/run.sh
    cd {{project_dir}}/packages/matrix-client && bash integration/run.sh
