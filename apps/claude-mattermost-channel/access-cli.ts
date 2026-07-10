#!/usr/bin/env bun
/**
 * Claude bridge access-control CLI.
 *
 * Thin wrapper over the shared access CLI. The Claude bridge uses the default
 * state directory (~/.claude/channels/mattermost, CLAUDE_CONFIG_DIR-aware), so
 * there is nothing to re-point — just run the shared core.
 */

await import("mattermost-shared/access-cli");
