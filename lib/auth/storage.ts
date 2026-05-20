/**
 * Plugin-local state cache.
 *
 * OpenCode itself owns the user's authentication record (in
 * `~/.local/share/opencode/auth.json`) and gives it back to us through
 * the SDK's `getAuth()` callback. So we don't duplicate the API key here.
 *
 * What we DO need to remember between OpenCode sessions:
 *   - Which proxy URL we last bound to (so we can warn on URL drift)
 *   - When we last pushed system-prompt overrides (so we don't spam the
 *     proxy with redundant PUTs on every loader invocation)
 *
 * Stored at `~/.opencode/windsurf-auth/state.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_STATE_DIRNAME } from "../constants.js";
import { log } from "../logger.js";
import type { PluginAuthFile } from "../types.js";

export function stateDir(): string {
  return join(homedir(), ".opencode", PLUGIN_STATE_DIRNAME);
}

export function statePath(): string {
  return join(stateDir(), "state.json");
}

export function readState(): Partial<PluginAuthFile> {
  const path = statePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<PluginAuthFile>;
  } catch (err) {
    log.warn(`state.json unreadable, ignoring: ${(err as Error).message}`);
    return {};
  }
}

export function writeState(next: Partial<PluginAuthFile>): void {
  const path = statePath();
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const merged = { ...readState(), ...next };
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  } catch (err) {
    log.warn(`failed to persist state.json: ${(err as Error).message}`);
  }
}
