/**
 * opencode-windsurf-auth — Windsurf (Cascade) provider plugin for OpenCode.
 *
 * Overview
 * ─────────
 * OpenCode hands every model request to the AI SDK; the SDK looks up a
 * provider (e.g. `@ai-sdk/openai-compatible`), and the provider's
 * `fetch` is what hits the wire. This plugin returns its own `fetch` from
 * the auth-loader, so we get a hook on every request.
 *
 * Per request the plugin:
 *   1. Routes the call to the best WindsurfAPI endpoint for the model
 *      (Claude family → /v1/messages, everything else → /v1/chat/completions).
 *   2. Injects `Authorization: Bearer <proxy API_KEY>`.
 *   3. Optionally scrubs Cascade/Windsurf fingerprints from the streaming
 *      response (defence-in-depth on top of the proxy's own sanitiser).
 *
 * On loader init (once per session) we:
 *   • Locate a running WindsurfAPI proxy (autodetect on common ports,
 *     overridable via options.baseURL / WINDSURF_API_URL env).
 *   • Verify the stored API key actually works against the proxy.
 *   • Push OpenCode-tuned system prompts into the proxy's runtime config
 *     (`PUT /dashboard/api/system-prompts`) — debounced to once per 12h.
 *
 * We deliberately do NOT spawn/supervise the proxy ourselves — WindsurfAPI
 * is best run as a separate process (docker, pm2, or `node src/index.js`),
 * and treating it as an external dependency means the same plugin works
 * against localhost dev proxies AND team-shared VPS deployments.
 *
 * @license MIT
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { setSilent, log } from "./lib/logger.js";
import {
  AUTH_LABELS,
  DUMMY_API_KEY,
  PROVIDER_ID,
} from "./lib/constants.js";
import type { LocatedProxy, PluginOptions } from "./lib/types.js";
import { locateProxy, ProxyNotFoundError } from "./lib/proxy/locate.js";
import {
  extractBearer,
  listAccounts,
  loginWithApiKey,
  loginWithWindsurfToken,
  verifyProxyApiKey,
} from "./lib/auth/token.js";
import {
  dashboardUrl,
  openBrowser,
  waitForNewAccount,
} from "./lib/auth/dashboard-login.js";
import {
  findWindsurfDesktopAuth,
  summarizeAuthCandidate,
} from "./lib/auth/desktop-import.js";
import { routeRequest } from "./lib/request/route.js";
import { scrubResponse } from "./lib/request/post-sanitize.js";
import { applyOpenCodePrompts } from "./lib/prompts/opencode-bridge.js";
import { readState, writeState } from "./lib/auth/storage.js";

function parseProviderOptions(rawProvider: unknown): PluginOptions {
  if (!rawProvider || typeof rawProvider !== "object") return {};
  const options = (rawProvider as { options?: Record<string, unknown> }).options;
  if (!options || typeof options !== "object") return {};
  return options as PluginOptions;
}

/**
 * Auto-resolve which bearer to send to the proxy during the auth flow,
 * without asking the user. Strategy (highest priority first):
 *
 *   1. Empty bearer (DUMMY_API_KEY → proxy in open mode accepts any).
 *      If the proxy answers /auth/accounts with 200, we're done.
 *   2. `WINDSURFAPI_KEY` (preferred) or `WINDSURF_API_KEY` env var.
 *   3. Fail (caller surfaces a friendly message pointing at the advanced
 *      auth method or env var).
 *
 * Returns the bearer string to send, or `null` if no working bearer was
 * found (caller treats this as "ask the user explicitly").
 */
async function resolveProxyBearer(proxyUrl: string): Promise<string | null> {
  // 1. Try open mode.
  const openProbe = await verifyProxyApiKey(proxyUrl, DUMMY_API_KEY);
  if (openProbe.ok) {
    log.debug("proxy is in open mode — no API_KEY required");
    return DUMMY_API_KEY;
  }
  // 2. Try env var (covers WINDSURFAPI_KEY first, then WINDSURF_API_KEY).
  const envKey = (process.env.WINDSURFAPI_KEY ?? process.env.WINDSURF_API_KEY ?? "").trim();
  if (envKey) {
    const envProbe = await verifyProxyApiKey(proxyUrl, envKey);
    if (envProbe.ok) {
      log.debug("proxy bearer resolved from env var");
      return envKey;
    }
    log.warn("WINDSURFAPI_KEY env var present but proxy rejected it (401)");
  }
  return null;
}

async function buildLoaderConfig(
  options: PluginOptions,
  authBearer: string,
): Promise<{
  apiKey: string;
  baseURL: string;
  fetch: typeof fetch;
} | undefined> {
  let located: LocatedProxy;
  try {
    located = await locateProxy(options);
  } catch (err) {
    if (err instanceof ProxyNotFoundError) {
      log.error(err.message);
    } else {
      log.error(`locateProxy threw: ${(err as Error).message}`);
    }
    return undefined;
  }

  const verify = await verifyProxyApiKey(located.url, authBearer);
  if (!verify.ok) {
    if (verify.status === 401) {
      log.error(
        verify.reason ?? "Proxy API key rejected (401). Re-run `opencode auth login`.",
      );
    } else {
      log.warn(
        `Proxy API key probe inconclusive (${verify.reason ?? "unknown"}). ` +
          `Continuing — requests may fail.`,
      );
    }
  }

  if (options.installPromptOverrides !== false) {
    await applyOpenCodePrompts(located.url, authBearer, {
      dashboardPassword: options.dashboardPassword,
    }).catch((err) => {
      log.warn(`applyOpenCodePrompts: ${(err as Error).message}`);
    });
  }

  // Remember which proxy we bound to — surfaces in `state.json` for
  // debugging and lets the wizard warn on URL drift.
  writeState({
    proxyUrl: located.url,
    apiKey: authBearer,
    proxyVersion: located.health.version,
  });

  const routeOptions = {
    routeClaudeToAnthropic: options.routeClaudeToAnthropic !== false,
    shrinkBody: options.shrinkBody !== false,
    injectCacheControl: options.injectCacheControl !== false,
  };
  const postSanitize = options.postSanitize !== false;
  const proxyUrl = located.url;

  // The fetch shape AI SDK expects exactly mirrors WHATWG fetch.
  const wrappedFetch: typeof fetch = async (input, init) => {
    let originalUrl: string;
    if (typeof input === "string") originalUrl = input;
    else if (input instanceof URL) originalUrl = input.toString();
    else if (input instanceof Request) originalUrl = input.url;
    else originalUrl = String(input);

    let bodyJson: Record<string, unknown> = {};
    if (init?.body) {
      try {
        bodyJson = JSON.parse(init.body as string) as Record<string, unknown>;
      } catch {
        // Pass-through for non-JSON bodies; the proxy will reject if needed.
      }
    }

    const routed = routeRequest(
      proxyUrl,
      originalUrl,
      bodyJson as never,
      routeOptions,
    );

    const headers = new Headers(init?.headers ?? {});
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${authBearer}`);
    headers.set("Content-Type", "application/json");
    if (routed.protocol === "anthropic") {
      headers.set("anthropic-version", "2023-06-01");
    }

    log.debug(`request → ${routed.url} (${routed.protocol}, model=${String(bodyJson.model)})`);
    if (routed.diagnostics?.shrinkDroppedMessages) {
      log.debug(
        `shrink: dropped ${routed.diagnostics.shrinkDroppedMessages} system msg(s) / ` +
          `${routed.diagnostics.shrinkDroppedBytes} bytes`,
      );
    }
    if (routed.diagnostics?.cacheControlInjected && routed.protocol === "anthropic") {
      log.debug("anthropic: cache_control markers stamped on system/tools prefix");
    }

    const response = await fetch(routed.url, {
      ...init,
      method: init?.method ?? "POST",
      headers,
      body: JSON.stringify(routed.body),
    });

    if (!response.ok) {
      log.debug(`response ← HTTP ${response.status} from ${routed.url}`);
      return response;
    }

    return postSanitize ? scrubResponse(response) : response;
  };

  return {
    apiKey: authBearer || DUMMY_API_KEY,
    baseURL: `${proxyUrl}/v1`,
    fetch: wrappedFetch,
  };
}

export const WindsurfAuthPlugin: Plugin = async (_input: PluginInput) => {
  // OpenCode plugins receive a PluginInput we don't currently need.
  // If we later add session-scoped behaviour (e.g. per-project model
  // pinning), pull `input.project.directory` from here.
  return {
    auth: {
      provider: PROVIDER_ID,

      /**
       * Called once per session when the AI SDK needs provider config.
       * Returning `{}` makes OpenCode fall back to whatever's in
       * opencode.json — useful when our preconditions aren't met (no proxy
       * running, etc.) so the user still sees a clear error rather than a
       * silent fail.
       */
      async loader(getAuth, provider) {
        const options = parseProviderOptions(provider);
        if (options.silent) setSilent(true);

        const auth = await getAuth();
        const bearer = extractBearer(auth);

        if (!bearer || bearer === DUMMY_API_KEY) {
          log.debug("loader: no auth bearer present — relying on proxy open mode");
        }

        const config = await buildLoaderConfig(options, bearer);
        return config ?? {};
      },

      methods: [
        // ─────────────────────────────────────────────────────────────
        // Method 1: zero-click Windsurf desktop import.
        //
        // Reads `windsurfAuthStatus.apiKey` from the locally-installed
        // Windsurf desktop app's globalStorage vscdb, then POSTs it to the
        // proxy's `/auth/login` as `{api_key: …}`. Same shape the proxy
        // already produces internally after Auth1+PostAuth, so no extra
        // network round-trip to Windsurf is needed.
        // ─────────────────────────────────────────────────────────────
        {
          // type: "oauth" with method: "auto" — zero prompts. The whole
          // flow runs inside callback(): probe the proxy, auto-discover the
          // bearer (open mode → none; otherwise WINDSURFAPI_KEY env var),
          // read the Windsurf desktop apiKey, register it with the proxy.
          type: "oauth",
          label: AUTH_LABELS.DESKTOP_IMPORT,
          async authorize(_inputs) {
            return {
              url: "about:blank",
              method: "auto" as const,
              instructions: AUTH_LABELS.INSTRUCTIONS_DESKTOP_IMPORT,
              callback: async () => {
                const candidate = findWindsurfDesktopAuth();
                if (!candidate) {
                  log.error(
                    "No Windsurf desktop login found. Install + sign into Windsurf " +
                      "desktop first, or use the 'paste auth token' method.",
                  );
                  return { type: "failed" as const };
                }
                log.info(`Found ${summarizeAuthCandidate(candidate)}`);

                try {
                  const located = await locateProxy({});
                  const bearer = await resolveProxyBearer(located.url);
                  if (bearer === null) {
                    log.error(
                      "Proxy requires an API_KEY but none provided.\n" +
                        "Either:\n" +
                        "  • restart the proxy with API_KEY= (open mode), or\n" +
                        "  • export WINDSURFAPI_KEY=<value> and retry, or\n" +
                        "  • pick 'WindsurfAPI proxy API key (advanced)' to enter it once.",
                    );
                    return { type: "failed" as const };
                  }
                  const account = await loginWithApiKey(
                    located.url,
                    bearer,
                    candidate.apiKey,
                    candidate.email ?? "windsurf-desktop",
                  );
                  log.info(
                    `Registered Windsurf account in proxy: ${account.id} (${account.email ?? "unknown"})`,
                  );
                  return {
                    type: "success" as const,
                    // Stored under auth.access. Empty for open-mode proxies;
                    // extractBearer() in the loader substitutes DUMMY_API_KEY.
                    access: bearer === DUMMY_API_KEY ? "" : bearer,
                    refresh: "",
                    expires: 0,
                  };
                } catch (err) {
                  if (err instanceof ProxyNotFoundError) {
                    log.error(
                      `${err.message}\nStart WindsurfAPI first (see the plugin README).`,
                    );
                  } else {
                    log.error(`desktop import failed: ${(err as Error).message}`);
                  }
                  return { type: "failed" as const };
                }
              },
            };
          },
        },

        // ─────────────────────────────────────────────────────────────
        // Method 2: paste a Windsurf auth token (one browser visit).
        //
        // Opens https://windsurf.com/show-auth-token. User signs in with
        // whatever they normally use (Google / GitHub / email) and the
        // page renders the token in plain text. Paste it in here, done.
        // ─────────────────────────────────────────────────────────────
        {
          // type: "oauth" with method: "code" — OpenCode opens the URL,
          // prompts "Paste the authorization code here:" and feeds the
          // value into our callback. We use that prompt for the Windsurf
          // auth token. Proxy bearer auto-resolved (open mode or env var).
          type: "oauth",
          label: AUTH_LABELS.WINDSURF_TOKEN,
          async authorize(_inputs) {
            const showAuthUrl = "https://windsurf.com/show-auth-token";
            openBrowser(showAuthUrl);
            return {
              url: showAuthUrl,
              method: "code" as const,
              instructions: AUTH_LABELS.INSTRUCTIONS_WINDSURF_TOKEN,
              callback: async (windsurfToken: string) => {
                const token = (windsurfToken ?? "").trim();
                if (!token) {
                  log.error("No Windsurf token provided.");
                  return { type: "failed" as const };
                }
                try {
                  const located = await locateProxy({});
                  const bearer = await resolveProxyBearer(located.url);
                  if (bearer === null) {
                    log.error(
                      "Proxy requires an API_KEY but none provided.\n" +
                        "Either:\n" +
                        "  • restart the proxy with API_KEY= (open mode), or\n" +
                        "  • export WINDSURFAPI_KEY=<value> and retry, or\n" +
                        "  • pick 'WindsurfAPI proxy API key (advanced)' to enter it once.",
                    );
                    return { type: "failed" as const };
                  }
                  const account = await loginWithWindsurfToken(
                    located.url,
                    bearer,
                    token,
                    "windsurf-token",
                  );
                  log.info(
                    `Registered Windsurf account in proxy: ${account.id} (${account.email ?? "unknown"})`,
                  );
                  return {
                    type: "success" as const,
                    access: bearer === DUMMY_API_KEY ? "" : bearer,
                    refresh: "",
                    expires: 0,
                  };
                } catch (err) {
                  if (err instanceof ProxyNotFoundError) {
                    log.error(
                      `${err.message}\nStart WindsurfAPI first (see the plugin README).`,
                    );
                  } else {
                    log.error(`windsurf token login failed: ${(err as Error).message}`);
                  }
                  return { type: "failed" as const };
                }
              },
            };
          },
        },

        // ─────────────────────────────────────────────────────────────
        // Method 3: only the proxy API key, no Windsurf account.
        //
        // For setups where the proxy already has accounts (added via
        // dashboard / other machines / CI seed). This just records the
        // proxy bearer so the plugin can talk to it.
        // ─────────────────────────────────────────────────────────────
        {
          type: "api",
          label: AUTH_LABELS.API_KEY,
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: AUTH_LABELS.INSTRUCTIONS_API_KEY,
              placeholder: "WindsurfAPI API_KEY",
            },
          ],
          async authorize(inputs) {
            const apiKey = (inputs?.apiKey ?? "").trim();
            if (!apiKey) {
              return { type: "failed" };
            }
            // Quick sanity-check that the proxy accepts this key before
            // we commit it to OpenCode's auth store.
            try {
              const located = await locateProxy({});
              const verify = await verifyProxyApiKey(located.url, apiKey);
              if (!verify.ok && verify.status === 401) {
                log.error(verify.reason ?? "API key rejected by proxy");
                return { type: "failed" };
              }
              return {
                type: "success",
                key: apiKey,
                provider: PROVIDER_ID,
                metadata: {
                  proxyUrl: located.url,
                  proxyVersion: located.health.version ?? "",
                },
              };
            } catch (err) {
              if (err instanceof ProxyNotFoundError) {
                log.error(err.message);
              } else {
                log.error(`auth.authorize failed: ${(err as Error).message}`);
              }
              // Even on locate failure, accept the key — user can fix
              // the proxy and the loader will pick it up next session.
              return {
                type: "success",
                key: apiKey,
                provider: PROVIDER_ID,
              };
            }
          },
        },

        {
          type: "oauth",
          label: AUTH_LABELS.DASHBOARD,
          async authorize(_inputs) {
            let located: LocatedProxy;
            try {
              located = await locateProxy({});
            } catch (err) {
              const message =
                err instanceof ProxyNotFoundError
                  ? err.message
                  : (err as Error).message;
              log.error(message);
              return {
                url: "about:blank",
                method: "auto",
                instructions: message,
                callback: async () => ({ type: "failed" }),
              };
            }

            // Need the API key NOW to read /auth/accounts and detect the
            // newly-added one. Read from on-disk state — set by previous
            // "API key" flow.
            const state = readState();
            const apiKey = state.apiKey ?? "";
            if (!apiKey) {
              const msg =
                "Run `opencode auth login` and pick the API-key method first, " +
                "then this dashboard flow can detect the new account.";
              log.error(msg);
              return {
                url: "about:blank",
                method: "auto",
                instructions: msg,
                callback: async () => ({ type: "failed" }),
              };
            }

            const url = dashboardUrl(located.url);
            const opened = openBrowser(url);
            const beforeAccounts = await listAccounts(located.url, apiKey);
            const seenIds = new Set(beforeAccounts.map((a) => a.id));

            return {
              url,
              method: "auto",
              instructions: opened
                ? AUTH_LABELS.INSTRUCTIONS_DASHBOARD
                : `Open this URL in your browser:\n  ${url}\n\n` +
                    AUTH_LABELS.INSTRUCTIONS_DASHBOARD,
              callback: async () => {
                const fresh = await waitForNewAccount(
                  located.url,
                  apiKey,
                  seenIds,
                  5 * 60 * 1000, // 5-minute deadline
                );
                if (!fresh) {
                  log.warn("dashboard login: no new account detected within 5 minutes");
                  return { type: "failed" };
                }
                log.info(
                  `dashboard login: account ${fresh.id} (${fresh.email ?? "unknown"}) added`,
                );
                // Re-use the existing API key — the new account joined
                // the pool, plugin doesn't need different credentials.
                return {
                  type: "success",
                  key: apiKey,
                  provider: PROVIDER_ID,
                  metadata: {
                    addedAccountId: fresh.id,
                    addedAccountEmail: fresh.email ?? "",
                  },
                };
              },
            };
          },
        },
      ],
    },
  };
};

export default WindsurfAuthPlugin;

// IMPORTANT: do NOT re-export anything else from this module.
//
// OpenCode's plugin loader iterates `Object.values(mod)` and treats EVERY
// export as a candidate plugin factory — any non-function export crashes
// the loader with `TypeError: Plugin export is not a function`, and any
// non-plugin function export would be incorrectly invoked as a plugin
// factory.
//
// Helper utilities live in `helpers.ts` and are exposed via the
// `opencode-windsurf-auth/helpers` subpath import.
export type { PluginOptions };
