/**
 * Dashboard-assisted login flow.
 *
 * We can't reimplement Google/GitHub OAuth here without re-doing what the
 * proxy's `src/dashboard/windsurf-login.js` already does (and re-implementing
 * is fragile across upstream changes). Instead we delegate to the proxy:
 *
 *   1. Snapshot the proxy's current account list (their ids).
 *   2. Open the dashboard URL in the user's default browser.
 *   3. User logs in via the dashboard (Google / GitHub / token / email+password).
 *   4. We poll `/auth/accounts` and return the first id we didn't see in (1).
 *
 * If the polling deadline passes without a new account, we return failed
 * — the user can re-trigger from `opencode auth login`.
 */

import { spawn } from "node:child_process";
import { PROXY_PATHS } from "../constants.js";
import { log } from "../logger.js";
import { listAccounts } from "./token.js";
import type { ProxyAccount } from "../types.js";

const PLATFORM_OPENERS = {
  darwin: "open",
  win32: "cmd",
  linux: "xdg-open",
} as const;

/**
 * Open a URL in the user's default browser. Best-effort: if the platform
 * opener isn't available, we print the URL so the user can open it manually.
 */
export function openBrowser(url: string): boolean {
  const opener = PLATFORM_OPENERS[process.platform as keyof typeof PLATFORM_OPENERS];
  if (!opener) {
    log.warn(`unsupported platform=${process.platform}, please open manually: ${url}`);
    return false;
  }
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch (err) {
    log.warn(`browser opener failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Build the dashboard URL with a tiny hint that the login panel should
 * be focused. The query-param is informational — the dashboard ignores
 * unknown params today, but it gives us a place to attach a callback
 * later (see roadmap PR in README).
 */
export function dashboardUrl(proxyUrl: string): string {
  return `${proxyUrl}${PROXY_PATHS.DASHBOARD}?focus=login`;
}

/**
 * Wait until the proxy reports a new account (id not in `seenIds`), or
 * until `deadlineMs` ms elapses.
 */
export async function waitForNewAccount(
  proxyUrl: string,
  apiKey: string,
  seenIds: Set<string>,
  deadlineMs: number,
  pollIntervalMs = 1500,
): Promise<ProxyAccount | null> {
  const stopAt = Date.now() + deadlineMs;
  while (Date.now() < stopAt) {
    const accounts = await listAccounts(proxyUrl, apiKey);
    for (const account of accounts) {
      if (account.id && !seenIds.has(account.id)) {
        return account;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return null;
}
