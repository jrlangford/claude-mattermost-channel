project_dir := justfile_directory()
claude_app := project_dir / "apps/claude-mattermost-channel"
codex_app := project_dir / "apps/codex-mattermost-bridge"

# Recipes inherited from Amelia's mattermost-integration tooling at handover
# (2026-07-04) — only the plugin-dev pieces; the MM server stack stays hers.
# Reorganized into a bun + turborepo monorepo (apps/*, packages/*).

default:
    @just --list

# Launch a Claude Code session with the Claude channel app as the plugin (dev
# loop: test changes without touching the marketplace cache the fleet runs).
claude-channel:
    cd {{project_dir}} && claude --plugin-dir {{claude_app}} --dangerously-load-development-channels server:mattermost

# Manage Claude channel access control (access-cli against the live access.json).
access *ARGS:
    cd {{claude_app}} && bun access-cli.ts {{ARGS}}

# Manage Codex bridge access control (points at ~/.codex/mattermost).
codex-access *ARGS:
    cd {{codex_app}} && bun codex-access-cli.ts {{ARGS}}

# Type-check / smoke + unit tests across the whole workspace (via turbo).
check:
    cd {{project_dir}} && bun run check
    cd {{project_dir}} && bun run test
    @echo "check OK"
