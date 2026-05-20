/**
 * Type contracts for the WindsurfAPI plugin.
 *
 * These are intentionally narrow — we only model the bits of the proxy /
 * OpenAI / Anthropic protocols that the plugin actually inspects. Everything
 * else is forwarded opaque.
 */

/** Options block under `provider.windsurf.options` in opencode.json. */
export interface PluginOptions {
  /** Explicit proxy URL. Overrides everything else. */
  baseURL?: string;
  /** Override the candidate list. Useful for non-standard ports. */
  candidates?: string[];
  /**
   * When true, the plugin will PUT OpenCode-tuned system prompts into
   * `/dashboard/api/system-prompts` on first init. Default: true.
   */
  installPromptOverrides?: boolean;
  /**
   * Dashboard admin password (proxy's `DASHBOARD_PASSWORD` env). Required
   * only to push OpenCode-tuned system prompts via `applyOpenCodePrompts`.
   * Falls back to env vars `WINDSURFAPI_DASHBOARD_PASSWORD` /
   * `DASHBOARD_PASSWORD`. If absent, prompt push is silently skipped and
   * the plugin relies on its own post-sanitiser only.
   */
  dashboardPassword?: string;
  /**
   * When true, plugin will route `claude-*` requests via `/v1/messages`
   * instead of `/v1/chat/completions`. Default: true.
   */
  routeClaudeToAnthropic?: boolean;
  /**
   * When true (default), dedupe byte-identical / empty system messages
   * in the outbound body. Safe; only collapses exact duplicates that
   * never carry signal. See lib/request/shrink.ts for the full policy.
   */
  shrinkBody?: boolean;
  /**
   * When true (default), stamp Anthropic `cache_control: ephemeral` on
   * the `system` + `tools` prefix of /v1/messages requests. The proxy
   * currently doesn't propagate these to Cascade, but the marking is
   * future-proof and immediately correct for non-Cascade Anthropic
   * upstreams. See lib/request/cache-control.ts for details.
   */
  injectCacheControl?: boolean;
  /**
   * When true, run a stream-level scrub for residual "Cascade" / "Windsurf"
   * mentions. Default: true.
   */
  postSanitize?: boolean;
  /** Disable plugin's debug logging. */
  silent?: boolean;
}

/** Per-model `provider.windsurf.models[id].options` (currently unused). */
export interface PerModelOptions {
  reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  reasoningSummary?: "auto" | "detailed" | "concise";
  textVerbosity?: "low" | "medium" | "high";
}

/** Shape of `GET /health` (subset we care about). */
export interface ProxyHealth {
  status?: string;
  provider?: string;
  version?: string;
  commit?: string;
  branch?: string;
  uptime?: number;
  accounts?: {
    active?: number;
    total?: number;
    [k: string]: unknown;
  };
}

/** Shape of `GET /auth/accounts` (subset). */
export interface ProxyAccount {
  id: string;
  email?: string;
  status?: string;
  method?: string;
  [k: string]: unknown;
}

/** Result returned by `locateProxy()` — both URL and verified health. */
export interface LocatedProxy {
  url: string;
  health: ProxyHealth;
}

/** OpenAI chat-completions message — generic enough to forward. */
export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool" | string;
  content: string | OpenAIChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIChatToolCall[];
}

export interface OpenAIChatContentPart {
  type: "text" | "image_url" | string;
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI chat-completions request body — fields we touch. */
export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [k: string]: unknown;
}

/** Anthropic Messages request body — what we emit when routing claude-*. */
export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicSystemPart[];
  max_tokens: number;
  stream?: boolean;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  [k: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemPart {
  type: "text";
  text: string;
  /**
   * Anthropic prompt-cache marker. Only `{type: "ephemeral"}` is
   * currently defined upstream. The proxy may or may not propagate it
   * to Cascade (see lib/request/cache-control.ts header).
   */
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result" | string;
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

/** Stored plugin state. */
export interface PluginAuthFile {
  proxyUrl: string;
  apiKey: string;
  /** Last-seen proxy version, for diagnostics. */
  proxyVersion?: string;
  /** Timestamp we last pushed system-prompt overrides. */
  promptsAppliedAt?: number;
}
