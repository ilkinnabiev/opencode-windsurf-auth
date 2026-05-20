/**
 * Auto-import the Windsurf account from a locally-installed Windsurf
 * desktop app.
 *
 * Why this exists
 * ────────────────
 * Windsurf desktop stores an `apiKey` in its global state vscdb. This is
 * the same `devin-session-token$…` string that the WindsurfAPI proxy
 * accepts as `{api_key: …}` in `POST /auth/login` — exactly the token the
 * proxy produces internally after its own Auth1 → PostAuth dance.
 *
 * So: if the user already logged into Windsurf desktop on this machine,
 * we can register that account into the proxy without any browser flow,
 * any password prompt, or any dashboard interaction. Zero clicks.
 *
 * How
 * ───
 * `state.vscdb` is a vanilla SQLite database with an `ItemTable(key, value)`
 * schema. We open it read-only and read the value of
 * `windsurfAuthStatus` — which is a JSON blob containing the `apiKey`
 * field plus an opaque protobuf-base64 `userStatusProtoBinaryBase64`.
 *
 * We deliberately don't link sqlite3 from npm — Node 20+ has no built-in
 * sqlite client and the proxy already runs zero-dep, so we shell out to
 * the system `sqlite3` CLI binary (always present on macOS by default,
 * trivially installable on Linux, bundled on Windows 10+). If sqlite3 is
 * missing we fall back to a heuristic regex extraction (the apiKey is
 * stored as a contiguous ASCII run inside the binary blob and is
 * straightforward to grep out).
 *
 * Security
 * ─────────
 * Read-only. We never write to the vscdb. We never log the token (just a
 * prefix). If the token looks malformed we refuse to import.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { log } from "../logger.js";

export interface DesktopAuthCandidate {
  apiKey: string;
  source: string;
  email?: string;
  apiServerUrl?: string;
}

const VSCDB_KEY = "windsurfAuthStatus";

/**
 * The `apiKey` Windsurf desktop stores always starts with one of these
 * prefixes. We use this as a sanity check before forwarding the value to
 * the proxy.
 */
const VALID_API_KEY_PREFIXES = [
  "devin-session-token$",
  "sk-ws-",
  "ws-",
];

/**
 * Where Windsurf desktop stores its globalStorage state.vscdb on each
 * OS. Returns an array (not just one path) because some users have
 * multiple Windsurf installs (e.g. Insiders) and we want to try them
 * in priority order.
 */
function candidateVscdbPaths(): string[] {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return [
        join(home, "Library", "Application Support", "Windsurf", "User", "globalStorage", "state.vscdb"),
        join(home, "Library", "Application Support", "Windsurf - Insiders", "User", "globalStorage", "state.vscdb"),
        join(home, "Library", "Application Support", "Windsurf-Next", "User", "globalStorage", "state.vscdb"),
      ];
    case "win32": {
      const appdata = process.env.APPDATA || join(home, "AppData", "Roaming");
      return [
        join(appdata, "Windsurf", "User", "globalStorage", "state.vscdb"),
        join(appdata, "Windsurf - Insiders", "User", "globalStorage", "state.vscdb"),
      ];
    }
    default:
      return [
        join(home, ".config", "Windsurf", "User", "globalStorage", "state.vscdb"),
        join(home, ".config", "Windsurf - Insiders", "User", "globalStorage", "state.vscdb"),
      ];
  }
}

function findVscdb(): string | null {
  for (const p of candidateVscdbPaths()) {
    if (existsSync(p)) {
      try {
        if (statSync(p).size > 0) return p;
      } catch {
        // unreadable — move on
      }
    }
  }
  return null;
}

function isValidApiKey(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  if (value.length < 16) return false;
  return VALID_API_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Pull `windsurfAuthStatus` out via the system `sqlite3` CLI.
 *
 * Args are passed via separate argv (no shell), so a quirky path or token
 * can't inject. We open the DB in read-only URI mode to be extra-careful.
 */
function readViaSqliteCli(dbPath: string): DesktopAuthCandidate | null {
  let sqlite3 = "sqlite3";
  if (platform() === "win32") sqlite3 = "sqlite3.exe";
  try {
    const result = spawnSync(
      sqlite3,
      [
        `file:${dbPath}?mode=ro&immutable=1`,
        "-readonly",
        ".timeout 1500",
        `SELECT value FROM ItemTable WHERE key = '${VSCDB_KEY}';`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (result.status !== 0) {
      log.debug?.(`sqlite3 exited non-zero: ${result.stderr?.trim() ?? "(no stderr)"}`);
      return null;
    }
    const raw = (result.stdout ?? "").trim();
    if (!raw) return null;
    return parseAuthStatusJson(raw, dbPath, "sqlite3-cli");
  } catch (err) {
    log.debug?.(`sqlite3 CLI invocation failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Last-resort: scrape the apiKey out of the raw vscdb file. SQLite stores
 * `ItemTable(value TEXT)` cells as plain UTF-8 in the database pages, so
 * the JSON containing `"apiKey":"…"` shows up contiguous in the file.
 *
 * This is a fallback for systems without a `sqlite3` CLI on PATH (rare on
 * macOS/Linux, but possible on minimal Windows).
 */
function readViaScraping(dbPath: string): DesktopAuthCandidate | null {
  try {
    const buf = readFileSync(dbPath);
    const haystack = buf.toString("latin1"); // preserve byte positions
    const re = /"apiKey":"([^"\\]{16,512})"/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(haystack))) {
      const candidate = match[1];
      if (isValidApiKey(candidate)) {
        const emailMatch = haystack.slice(Math.max(0, match.index - 4000), match.index + 4000)
          .match(/"lastLoginEmail":"([^"]+)"/);
        return {
          apiKey: candidate,
          source: `${dbPath} (binary scrape)`,
          email: emailMatch?.[1],
        };
      }
    }
    return null;
  } catch (err) {
    log.debug?.(`vscdb scrape failed: ${(err as Error).message}`);
    return null;
  }
}

function parseAuthStatusJson(
  raw: string,
  dbPath: string,
  via: "sqlite3-cli" | "scrape",
): DesktopAuthCandidate | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const apiKey = data.apiKey;
    if (typeof apiKey !== "string" || !isValidApiKey(apiKey)) {
      log.debug?.(`vscdb entry present but apiKey missing/invalid (via=${via})`);
      return null;
    }
    return {
      apiKey,
      source: `${dbPath} (via ${via})`,
      apiServerUrl: typeof data.apiServerUrl === "string" ? data.apiServerUrl : undefined,
    };
  } catch (err) {
    log.debug?.(`could not parse vscdb apiKey JSON: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Main entry — tries every candidate path and every read strategy.
 * Returns `null` if no Windsurf desktop login is present on this machine.
 */
export function findWindsurfDesktopAuth(): DesktopAuthCandidate | null {
  const path = findVscdb();
  if (!path) {
    log.debug?.("no Windsurf desktop globalStorage vscdb found on this machine");
    return null;
  }
  return readViaSqliteCli(path) ?? readViaScraping(path);
}

/**
 * Convenience for installer / CLI tooling — returns a redacted summary
 * suitable for printing to the terminal.
 */
export function summarizeAuthCandidate(c: DesktopAuthCandidate): string {
  const masked = `${c.apiKey.slice(0, 20)}…${c.apiKey.slice(-4)}`;
  const who = c.email ? ` (${c.email})` : "";
  return `Windsurf desktop login${who} — apiKey=${masked}`;
}
