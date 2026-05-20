/**
 * Locate a running WindsurfAPI proxy.
 *
 * Resolution order (first match wins):
 *   1. Explicit `options.baseURL` from opencode.json
 *   2. `WINDSURF_API_URL` environment variable
 *   3. Each URL in `options.candidates` (if provided)
 *   4. Each URL in `DEFAULT_PROXY_CANDIDATES`
 *
 * The candidate must respond to `GET /health` with
 * `provider: "WindsurfAPI..."` — anything else is treated as not-ours
 * and skipped (we do not want to send `POST /auth/login {token}` blindly
 * to a random service).
 *
 * No spawning happens here — that's the user's responsibility
 * (`docker compose up`, `node src/index.js`, `pm2 start ...`, or our
 * `scripts/setup-wizard.js`). Keeping the plugin itself "discover-only"
 * means it works equally well against:
 *   - localhost dev proxy
 *   - team-shared VPS proxy
 *   - LAN proxy on another machine
 */

import { DEFAULT_PROXY_CANDIDATES } from "../constants.js";
import { log } from "../logger.js";
import type { LocatedProxy, PluginOptions } from "../types.js";
import { tryHealthcheck } from "./health.js";

export class ProxyNotFoundError extends Error {
  constructor(public readonly candidates: string[]) {
    super(
      `No reachable WindsurfAPI proxy.\n` +
        `Tried: ${candidates.join(", ")}\n\n` +
        `Quick fixes:\n` +
        `  • Set 'baseURL' in opencode.jsonc -> provider.windsurf.options\n` +
        `  • Or export WINDSURF_API_URL=http://your-host:3003\n` +
        `  • Or run the WindsurfAPI proxy yourself:\n` +
        `      git clone https://github.com/dwgx/WindsurfAPI && cd WindsurfAPI\n` +
        `      bash setup.sh && node src/index.js\n` +
        `  • Or use the bundled wizard:\n` +
        `      npx opencode-windsurf-auth setup`,
    );
  }
}

function uniq(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = x.replace(/\/+$/, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Walk the resolution chain and return the first healthy proxy.
 *
 * NOTE: callers should cache the result for the lifetime of the OpenCode
 * session — re-locating per request is wasteful and the URL doesn't change
 * mid-session.
 */
export async function locateProxy(options: PluginOptions = {}): Promise<LocatedProxy> {
  const candidates: string[] = [];

  if (options.baseURL) {
    candidates.push(options.baseURL.replace(/\/+$/, ""));
  }
  if (process.env.WINDSURF_API_URL) {
    candidates.push(process.env.WINDSURF_API_URL.replace(/\/+$/, ""));
  }
  if (Array.isArray(options.candidates) && options.candidates.length > 0) {
    candidates.push(...options.candidates.map((u) => u.replace(/\/+$/, "")));
  }
  candidates.push(...DEFAULT_PROXY_CANDIDATES);

  const unique = uniq(candidates);
  log.debug(`locateProxy: probing ${unique.length} candidate(s): ${unique.join(", ")}`);

  for (const url of unique) {
    const health = await tryHealthcheck(url);
    if (health.ok && health.body) {
      log.info(
        `connected to WindsurfAPI at ${url}` +
          (health.body.version ? ` (v${health.body.version})` : "") +
          (health.body.accounts?.active != null
            ? ` — ${health.body.accounts.active} active account(s)`
            : ""),
      );
      return { url, health: health.body };
    }
    log.debug(`locateProxy: ${url} not WindsurfAPI (${health.error ?? "no health body"})`);
  }

  throw new ProxyNotFoundError(unique);
}
