/**
 * Compile-time constants for the WindsurfAPI OpenCode plugin.
 */

export const PLUGIN_NAME = "opencode-windsurf-auth";

export const PROVIDER_ID = "windsurf";

/**
 * Common URLs probed by `locateProxy()` when neither `options.baseURL`
 * nor `WINDSURF_API_URL` is set. Ordered by likelihood — the default
 * `node src/index.js` deploys to 3003 (see WindsurfAPI `src/config.js`).
 */
export const DEFAULT_PROXY_CANDIDATES = [
  "http://localhost:3003",
  "http://127.0.0.1:3003",
  "http://localhost:3000",
];

/** WindsurfAPI emits this exact string in `GET /health.provider`. */
export const PROXY_PROVIDER_MARKER = "WindsurfAPI";

/**
 * Upstream WindsurfAPI version compatibility window.
 *
 * The plugin contract relies on these proxy endpoints / payload shapes:
 *   • GET  /health                    — { provider, version, accounts.active }
 *   • GET  /v1/models                 — OpenAI-style models list
 *   • POST /v1/chat/completions       — OpenAI chat semantics
 *   • POST /v1/messages               — Anthropic messages semantics (tool_use blocks)
 *   • POST /auth/login                — accepts { apiKey } and { token } payloads
 *   • GET  /auth/accounts             — { accounts: [...] }
 *   • PUT  /dashboard/api/system-prompts (X-Dashboard-Password header)
 *
 * If upstream bumps `MAJOR` or removes/renames any of the above, this
 * plugin will start failing at runtime. We bake in the version we last
 * verified end-to-end so we can warn the user when their proxy is older
 * (likely-missing endpoints) or significantly newer (possibly-breaking
 * changes we haven't audited yet).
 *
 * Update both constants whenever you E2E-test against a new upstream tag.
 */
export const SUPPORTED_PROXY = {
  /** Lowest semver we have verified the plugin works against. */
  MIN: "2.0.96",
  /** Highest semver we have verified the plugin works against. */
  LAST_VERIFIED: "2.0.96",
  /** Display URL used in warning messages and README references. */
  TAG_URL: "https://github.com/dwgx/WindsurfAPI/releases/tag/v2.0.96",
} as const;

/** Path inside `~/.opencode/` where we keep our state. */
export const PLUGIN_STATE_DIRNAME = "windsurf-auth";

/** Plugin auth labels visible in OpenCode `/connect` menu. */
export const AUTH_LABELS = {
  DESKTOP_IMPORT: "Sign in with Windsurf (import desktop login)",
  WINDSURF_TOKEN: "Sign in with Windsurf (paste auth token)",
  API_KEY: "WindsurfAPI proxy API key (advanced)",
  DASHBOARD: "Open WindsurfAPI dashboard to add an account (advanced)",
  INSTRUCTIONS_API_KEY:
    "Enter the API_KEY value from your WindsurfAPI `.env` file " +
    "(or the dashboard's Settings → API key panel).\n" +
    "Leave empty only if the proxy was started without an API_KEY.",
  INSTRUCTIONS_DESKTOP_IMPORT:
    "Reads the apiKey stored by the Windsurf desktop app on this machine " +
    "and registers it with your local WindsurfAPI proxy. Zero clicks — " +
    "requires (a) Windsurf desktop installed AND signed in and (b) the " +
    "proxy running locally in open mode (.env API_KEY= empty) OR with " +
    "WINDSURFAPI_KEY exported in your shell.",
  INSTRUCTIONS_WINDSURF_TOKEN:
    "A browser tab will open at https://windsurf.com/show-auth-token .\n" +
    "Sign in with your normal Windsurf account (Google / GitHub / email), " +
    "copy the token shown on that page, and paste it here.\n" +
    "The proxy bearer is auto-resolved (open mode or WINDSURFAPI_KEY env).",
  INSTRUCTIONS_DASHBOARD:
    "A browser tab will open at the WindsurfAPI dashboard. Add your " +
    "Windsurf account (Google / GitHub OAuth or token), then return here " +
    "and press Enter. The plugin will detect the newest account automatically.",
} as const;

/** Dummy key we pass to `@ai-sdk/openai-compatible` when proxy runs open. */
export const DUMMY_API_KEY = "windsurf-proxy-open";

/** Headers we always strip before forwarding to the proxy. */
export const HEADERS_TO_STRIP = ["x-api-key", "anthropic-version"] as const;

/** Anthropic-API version that the proxy understands. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** `GET /v1/models` path on the proxy. */
export const PROXY_PATHS = {
  HEALTH: "/health",
  MODELS: "/v1/models",
  CHAT: "/v1/chat/completions",
  MESSAGES: "/v1/messages",
  RESPONSES: "/v1/responses",
  AUTH_LOGIN: "/auth/login",
  AUTH_ACCOUNTS: "/auth/accounts",
  AUTH_STATUS: "/auth/status",
  DASHBOARD: "/dashboard",
  DASHBOARD_API_SYSTEM_PROMPTS: "/dashboard/api/system-prompts",
} as const;

/** Healthcheck timing. */
export const HEALTH_TIMEOUT_MS = 1500;
export const HEALTH_RETRY_COUNT = 1;

/** Stream sanitize tag for log lines. */
export const LOG_PREFIX = "[opencode-windsurf-auth]";

/**
 * Model name prefixes routed to the Anthropic `/v1/messages` endpoint.
 *
 * Cascade exposes Claude through native Anthropic semantics, and the
 * proxy's `messages` handler preserves `tool_use` blocks more faithfully
 * than the OpenAI bridge — better tool-call stability for Claude family
 * (per WindsurfAPI README v2.0.82+ notes).
 */
export const ANTHROPIC_ROUTED_PREFIXES = ["claude-"];

/** Default reasoning effort when caller didn't specify one. */
export const DEFAULT_REASONING_EFFORT = "medium";
