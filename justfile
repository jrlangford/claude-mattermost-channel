project_dir := justfile_directory()

# Recipes inherited from Amelia's mattermost-integration tooling at handover
# (2026-07-04) — only the plugin-dev pieces; the MM server stack stays hers.

default:
    @just --list

# Launch a Claude Code session with THIS working tree as the plugin (dev
# loop: test changes without touching the marketplace cache the fleet runs).
claude-channel:
    cd {{project_dir}} && claude --plugin-dir {{project_dir}} --dangerously-load-development-channels server:mattermost

# Manage channel access control (access-cli against the live access.json).
access *ARGS:
    cd {{project_dir}} && bun access-cli.ts {{ARGS}}

# Type-check / smoke: bun can parse the server.
check:
    bun build {{project_dir}}/server.ts --target=bun --outfile=/tmp/mm-channel-check.js && rm /tmp/mm-channel-check.js && echo "check OK"
