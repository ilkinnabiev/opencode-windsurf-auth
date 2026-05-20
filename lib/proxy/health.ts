/**
 * Health-check helpers for the WindsurfAPI proxy.
 *
 * The proxy exposes `GET /health` (public, no auth required) which returns
 * `{ status, provider, version, commit, uptime, accounts }`. We use the
 * `provider` string to disambiguate WindsurfAPI from any other service that
 * happened to claim port 3003 on the user's machine.
 */

import { HEALTH_TIMEOUT_MS, PROXY_PATHS, PROXY_PROVIDER_MARKER } from "../constants.js";
import { log } from "../logger.js";
import type { ProxyHealth } from "../types.js";

export interface HealthResult {
  ok: boolean;
  status?: number;
  body?: ProxyHealth;
  error?: string;
}

/**
 * Try `GET {baseUrl}/health` with a small timeout and validate that the
 * service identifies as WindsurfAPI.
 */
export async function tryHealthcheck(
  baseUrl: string,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${PROXY_PATHS.HEALTH}`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as ProxyHealth;
    const provider = body?.provider ?? "";
    const isWindsurfApi = provider.includes(PROXY_PROVIDER_MARKER);
    if (!isWindsurfApi) {
      // Something else lives on this port — we must not assume it speaks
      // our protocol. Treating as not-ok prevents subsequent /auth/login
      // calls hitting a random API.
      return {
        ok: false,
        status: response.status,
        body,
        error: `Endpoint responded but provider="${provider}" — expected "${PROXY_PROVIDER_MARKER}"`,
      };
    }
    return { ok: true, status: response.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Poll `/health` until it responds or the deadline passes. Used by setup
 * wizard after spawning a fresh proxy, and never from the hot path.
 */
export async function waitUntilHealthy(
  baseUrl: string,
  deadlineMs: number,
  pollIntervalMs = 500,
): Promise<HealthResult> {
  const deadline = Date.now() + deadlineMs;
  let lastResult: HealthResult = { ok: false, error: "never polled" };
  while (Date.now() < deadline) {
    lastResult = await tryHealthcheck(baseUrl, 1000);
    if (lastResult.ok) return lastResult;
    log.debug(`waitUntilHealthy: ${baseUrl} not ready (${lastResult.error}), retrying`);
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return lastResult;
}
