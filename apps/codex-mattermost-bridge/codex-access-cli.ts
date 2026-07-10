#!/usr/bin/env bun
/**
 * Codex access-control wrapper.
 *
 * Reuses the shared access CLI, but points it at Codex's Mattermost state
 * directory via MATTERMOST_ACCESS_HOME (a CLI-only override — neither server
 * reads it, so it cannot cross the Claude/Codex trust domains).
 */

import { homedir } from "os";
import { join } from "path";

process.env.MATTERMOST_ACCESS_HOME ??=
  process.env.CODEX_MATTERMOST_HOME || join(homedir(), ".codex", "mattermost");

await import("mattermost-shared/access-cli");
