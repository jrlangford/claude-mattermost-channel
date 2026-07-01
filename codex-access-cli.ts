#!/usr/bin/env bun
/**
 * Codex access-control wrapper.
 *
 * Reuses access-cli.ts, but points it at Codex's Mattermost state directory.
 */

import { homedir } from "os";
import { join } from "path";

process.env.MATTERMOST_CHANNEL_HOME ??= join(homedir(), ".codex", "mattermost");

await import("./access-cli.ts");
