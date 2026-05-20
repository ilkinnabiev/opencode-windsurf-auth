/**
 * Token helpers — coerce whatever OpenCode hands us into the value we
 * actually send as Bearer to the proxy.
 *
 * OpenCode auth types we accept:
 *   - { type: "api", key: "<API_KEY of proxy>" }              ← primary
 *   - { type: "oauth", access: "<API_KEY of proxy>", ... }   ← legacy/extension
 *
 * If the user runs the proxy without an API_KEY (open mode), we still
 * send a synthetic Bearer so headers stay shaped consistently — the proxy
 * just ignores it.
 */

import { DUMMY_API_KEY, PROXY_PATHS } from "../constants.js";
import { log } from "../logger.js";
import type { ProxyAccount } from "../types.js";

/** Generic Auth type — we duck-type to avoid pulling @opencode-ai/sdk only for this. */
type AuthLike =
  | { type: "api"; key?: string }
  | { type: "oauth"; access?: string; refresh?: string; expires?: number }
  | { type?: string; [k: string]: unknown };

export function extractBearer(auth: AuthLike | undefined): string {
  if (!auth || typeof auth !== "object") return DUMMY_API_KEY;
  if (auth.type === "api" && typeof (auth as { key?: string }).key === "string") {
    return (auth as { key: string }).key || DUMMY_API_KEY;
  }
  if (auth.type === "oauth" && typeof (auth as { access?: string }).access === "string") {
    return (auth as { access: string }).access || DUMMY_API_KEY;
  }
  return DUMMY_API_KEY;
}

/**
 * Pre-flight check before fetch — quickly tell the user whether the
 * stored API key actually works against the proxy in front of us.
 *
 * Hit `GET /auth/accounts` (which requires the proxy's API key) and look
 * for HTTP 200. We do this once per loader invocation, not per request.
 */
export async function verifyProxyApiKey(
  proxyUrl: string,
  apiKey: string,
): Promise<{ ok: boolean; status?: number; reason?: string }> {
  try {
    const response = await fetch(`${proxyUrl}${PROXY_PATHS.AUTH_ACCOUNTS}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });
    if (response.status === 200) return { ok: true, status: 200 };
    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        reason:
          "Proxy rejected the API key. Re-run `opencode auth login`, " +
          "select Windsurf, and paste the API_KEY from the proxy's `.env`.",
      };
    }
    return { ok: false, status: response.status, reason: `Unexpected HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/**
 * List Windsurf accounts currently in the proxy pool. Used by the
 * dashboard-login flow to detect "the newest account" added during the
 * browser dance.
 */
export async function listAccounts(
  proxyUrl: string,
  apiKey: string,
): Promise<ProxyAccount[]> {
  try {
    const response = await fetch(`${proxyUrl}${PROXY_PATHS.AUTH_ACCOUNTS}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      log.warn(`listAccounts: HTTP ${response.status}`);
      return [];
    }
    const body = (await response.json()) as { accounts?: ProxyAccount[] };
    return Array.isArray(body?.accounts) ? body.accounts : [];
  } catch (err) {
    log.warn(`listAccounts failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Auth payload accepted by `POST /auth/login` on WindsurfAPI. The proxy
 * accepts ONE of:
 *   - `{ token }`    — Windsurf auth token from windsurf.com/show-auth-token
 *   - `{ api_key }`  — Codeium API key OR a devin-session-token (the latter
 *                       is what Windsurf desktop stores on disk as `apiKey`)
 *   - `{ email, password }`  — full Auth1 login (we don't expose this in
 *                              the OpenCode UI by default; password prompts
 *                              are awkward and lock-prone).
 *
 * `label` is purely cosmetic — shows up in the dashboard's account list.
 */
export type WindsurfLoginPayload =
  | { token: string; label?: string }
  | { api_key: string; label?: string }
  | { email: string; password: string; label?: string };

async function postLogin(
  proxyUrl: string,
  apiKey: string,
  payload: WindsurfLoginPayload,
): Promise<ProxyAccount> {
  const response = await fetch(`${proxyUrl}${PROXY_PATHS.AUTH_LOGIN}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: { account?: ProxyAccount; error?: string | { message?: string }; success?: boolean };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Proxy returned non-JSON for /auth/login (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const msg =
      typeof body.error === "string"
        ? body.error
        : body.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`/auth/login rejected payload: ${msg}`);
  }
  if (!body.account) {
    throw new Error(`/auth/login returned no account object`);
  }
  return body.account;
}

/**
 * POST a Windsurf auth token (the one users copy from
 * `https://windsurf.com/show-auth-token`) to `/auth/login`.
 */
export async function loginWithWindsurfToken(
  proxyUrl: string,
  apiKey: string,
  token: string,
  label?: string,
): Promise<ProxyAccount> {
  return postLogin(proxyUrl, apiKey, { token, label });
}

/**
 * POST a raw Codeium API key OR a devin-session-token (the format Windsurf
 * desktop stores at `windsurfAuthStatus.apiKey` in its globalStorage vscdb)
 * to `/auth/login`. The proxy treats both the same — registers it as an
 * `api_key` account and starts routing requests through it.
 */
export async function loginWithApiKey(
  proxyUrl: string,
  apiKey: string,
  windsurfApiKey: string,
  label?: string,
): Promise<ProxyAccount> {
  return postLogin(proxyUrl, apiKey, { api_key: windsurfApiKey, label });
}
