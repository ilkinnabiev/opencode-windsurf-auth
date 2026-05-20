/**
 * Plugin logger — file-first, never corrupts the OpenCode TUI.
 *
 * Why not `console.error`/stderr?
 * ───────────────────────────────
 * OpenCode's TUI draws into the user's terminal via an alternate screen
 * buffer. BOTH stdout AND stderr of the plugin (and of `bun install`,
 * which OpenCode runs to materialize the plugin) end up on that same
 * terminal device. Anything we write there is painted on top of the TUI
 * and stays as visual junk until the next full redraw (SIGWINCH on
 * resize, `Ctrl+L`, etc).
 *
 * So we log to a file by default:
 *   - Always:  ~/.opencode/windsurf-auth/log.txt  (rotated at ~1 MiB)
 *   - Stderr:  only when explicitly requested (see toggles below) AND
 *              stderr is NOT a TTY (i.e. we're piped or headless, e.g.
 *              `opencode run ... 2>&1 | tee out.log`).
 *
 * Toggles (env vars):
 *   WINDSURF_AUTH_DEBUG=1        enable debug-level lines (still file-only
 *                                unless mirroring is on)
 *   WINDSURF_AUTH_LOG_STDERR=1   force mirror to stderr even if it's a TTY
 *                                (use ONLY when running outside the TUI)
 *   WINDSURF_AUTH_LOG_FILE=path  override the log file path
 *   WINDSURF_AUTH_LOG_SILENT=1   disable all logging (file + stderr)
 *
 * Live tailing: `tail -f ~/.opencode/windsurf-auth/log.txt`
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LOG_PREFIX, PLUGIN_STATE_DIRNAME } from "./constants.js";

const MAX_LOG_BYTES = 1024 * 1024; // 1 MiB before rotation

let silent = false;

export function setSilent(value: boolean): void {
  silent = value;
}

function isDebugEnabled(): boolean {
  return process.env.WINDSURF_AUTH_DEBUG === "1";
}

function isGloballySilent(): boolean {
  return silent || process.env.WINDSURF_AUTH_LOG_SILENT === "1";
}

/**
 * Mirror log lines to stderr only when the user explicitly opts in AND
 * stderr is not a TTY. The TTY check is the safety net: even if the user
 * sets WINDSURF_AUTH_LOG_STDERR=1 by accident inside a TUI session, we
 * still won't smear the screen.
 */
function shouldMirrorToStderr(): boolean {
  if (process.env.WINDSURF_AUTH_LOG_STDERR !== "1") return false;
  if (process.stderr.isTTY) return false;
  return true;
}

function logFilePath(): string {
  const override = process.env.WINDSURF_AUTH_LOG_FILE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".opencode", PLUGIN_STATE_DIRNAME, "log.txt");
}

function ensureLogDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    const { size } = statSync(path);
    if (size < MAX_LOG_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // Rotation is best-effort; logging must never throw.
  }
}

function formatExtra(extra: unknown): string {
  if (extra === undefined) return "";
  if (extra instanceof Error) {
    return ` ${extra.stack ?? extra.message}`;
  }
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

function write(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string, extra?: unknown): void {
  if (isGloballySilent()) return;
  if (level === "DEBUG" && !isDebugEnabled()) return;

  const line = `${new Date().toISOString()} ${LOG_PREFIX} ${level}: ${message}${formatExtra(extra)}\n`;

  try {
    const path = logFilePath();
    ensureLogDir(path);
    rotateIfNeeded(path);
    appendFileSync(path, line, "utf-8");
  } catch {
    // If file logging fails (read-only HOME, ENOSPC, etc.) we silently
    // give up rather than fall through to stderr — corrupting the TUI is
    // worse than losing log lines.
  }

  if (shouldMirrorToStderr()) {
    try {
      process.stderr.write(line);
    } catch {
      // Same reasoning as above.
    }
  }
}

export const log = {
  info(message: string, extra?: unknown): void {
    write("INFO", message, extra);
  },
  warn(message: string, extra?: unknown): void {
    write("WARN", message, extra);
  },
  error(message: string, extra?: unknown): void {
    write("ERROR", message, extra);
  },
  debug(message: string, extra?: unknown): void {
    write("DEBUG", message, extra);
  },
};
