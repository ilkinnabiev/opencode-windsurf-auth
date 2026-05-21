/**
 * Public helpers for tooling that wants to compose with the WindsurfAPI proxy
 * outside of OpenCode's plugin loader (custom plugins, tests, scripts).
 *
 * Do NOT export these from `index.ts` — OpenCode iterates every named export
 * and treats it as a plugin factory, so non-plugin exports crash the loader
 * with `TypeError: Plugin export is not a function`.
 */

export { applyOpenCodePrompts } from "./lib/prompts/opencode-bridge.js";
export {
  loginWithWindsurfToken,
  verifyProxyApiKey,
  listAccounts,
} from "./lib/auth/token.js";
export { locateProxy, ProxyNotFoundError } from "./lib/proxy/locate.js";
export { tryHealthcheck, waitUntilHealthy } from "./lib/proxy/health.js";
export {
  evaluateProxyCompat,
  logProxyCompat,
  parseSemver,
  compareSemver,
} from "./lib/proxy/compat.js";
export { openaiToAnthropic } from "./lib/request/convert.js";
export {
  PROVIDER_ID,
  PROXY_PATHS,
  DEFAULT_PROXY_CANDIDATES,
  SUPPORTED_PROXY,
} from "./lib/constants.js";
