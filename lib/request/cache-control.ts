/**
 * Add Anthropic prompt-cache breakpoints to outbound /v1/messages bodies.
 *
 * Background
 * ──────────
 * Anthropic's Messages API supports `cache_control: {type: "ephemeral"}`
 * on `system`, `tools`, and individual `messages[*].content[*]` blocks.
 * Each cached chunk is stored for ~5 minutes and replayed on subsequent
 * requests at ~10% of the original input-token price (input write costs
 * 25% extra, but reads at the same breakpoint give back ~90%).
 *
 * For an OpenCode session this is huge — every turn re-sends the same
 * 27KB system + ~14KB tools spec; without caching every turn pays for
 * that prefix from scratch. With caching, turns 2..N reuse the prefix.
 *
 * Constraints
 * ───────────
 *   • Max 4 cache breakpoints per request — we use at most 2 (system +
 *     trailing tool, plus one safety slot).
 *   • Breakpoint must be on the LAST block of whatever you want cached —
 *     Anthropic caches everything UP TO (and including) the marker.
 *   • Empty / tiny prefixes (<~1024 tokens) won't be cached even if
 *     marked — wasted breakpoint. Skip those.
 *   • Existing breakpoints on the inbound body take precedence — never
 *     overwrite cache hints the caller already set.
 *
 * What the proxy will actually do
 * ───────────────────────────────
 * The WindsurfAPI proxy passes /v1/messages through its native
 * cascade-anthropic-bridge — which currently does NOT propagate
 * cache_control downstream to Anthropic. Marking the body here is
 * therefore a no-op TODAY against Cascade, but:
 *   1. It's correct against any other Anthropic-compatible upstream the
 *      user might swap in (some users front a real Anthropic key with
 *      this proxy for non-Cascade routes).
 *   2. WindsurfAPI is actively working on cache_control passthrough
 *      (see proxy issue tracker). Marking the body now means we get
 *      the savings the moment that lands, with zero plugin update.
 *
 * So this is "future-proof + correct under direct Anthropic" rather
 * than "immediately saves money on Cascade today".
 */

import type {
  AnthropicMessagesRequest,
  AnthropicSystemPart,
} from "../types.js";

/** Rough char→token ratio for English/code; conservative under-estimate. */
const CHARS_PER_TOKEN = 4;

/** Anthropic refuses to cache prefixes under this token count anyway. */
const MIN_CACHEABLE_TOKENS = 1024;

/** Anthropic hard limit (4) minus the headroom we leave for caller hints. */
const MAX_BREAKPOINTS_WE_ADD = 2;

interface CacheControlMark {
  cache_control?: { type: "ephemeral" };
}

function estTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function alreadyHasCacheBreakpoints(
  body: AnthropicMessagesRequest,
): number {
  let count = 0;
  const sys = body.system;
  if (Array.isArray(sys)) {
    count += sys.filter((p) => (p as AnthropicSystemPart & CacheControlMark).cache_control).length;
  }
  const tools = body.tools as Array<Record<string, unknown> & CacheControlMark> | undefined;
  if (Array.isArray(tools)) {
    count += tools.filter((t) => t.cache_control).length;
  }
  for (const msg of body.messages ?? []) {
    if (Array.isArray(msg.content)) {
      count += msg.content.filter(
        (b) => (b as CacheControlMark).cache_control,
      ).length;
    }
  }
  return count;
}

/**
 * Stamp `cache_control: ephemeral` on the LAST block of `system` (if it
 * exists and is large enough to be worth caching). The proxy/upstream
 * caches the entire `system` prefix up to and including that marker.
 *
 * Returns true if we mutated the body.
 */
function markSystem(body: AnthropicMessagesRequest): boolean {
  const sys = body.system;
  if (!sys) return false;

  // Normalise: if `system` is a string, leave it alone — string-form
  // doesn't carry cache_control. Caller is expected to use the array
  // form (our openaiToAnthropic already does this whenever there's >1
  // system message).
  if (typeof sys === "string") {
    const tokens = estTokens(sys);
    if (tokens < MIN_CACHEABLE_TOKENS) return false;
    // Convert to one-element array so we can attach cache_control.
    body.system = [
      {
        type: "text",
        text: sys,
        cache_control: { type: "ephemeral" },
      } as AnthropicSystemPart & CacheControlMark,
    ];
    return true;
  }

  if (!Array.isArray(sys) || sys.length === 0) return false;

  // Total tokens across all blocks — only worth marking if combined
  // prefix exceeds the cache floor.
  const totalChars = sys.reduce((acc, p) => acc + (p.text?.length ?? 0), 0);
  if (Math.ceil(totalChars / CHARS_PER_TOKEN) < MIN_CACHEABLE_TOKENS) return false;

  // Find the last text block that doesn't already have cache_control.
  for (let i = sys.length - 1; i >= 0; i--) {
    const block = sys[i] as AnthropicSystemPart & CacheControlMark;
    if (block.type === "text" && !block.cache_control) {
      block.cache_control = { type: "ephemeral" };
      return true;
    }
  }
  return false;
}

/**
 * Stamp `cache_control: ephemeral` on the LAST entry in `tools`. The
 * tools array is the second-most-repeated chunk between turns; caching
 * it pays off after just 2-3 calls with the same toolset.
 */
function markTools(body: AnthropicMessagesRequest): boolean {
  const tools = body.tools as Array<Record<string, unknown> & CacheControlMark> | undefined;
  if (!Array.isArray(tools) || tools.length === 0) return false;

  // Total serialised size of tools; skip if too tiny.
  let totalChars = 0;
  try {
    totalChars = JSON.stringify(tools).length;
  } catch {
    return false;
  }
  if (Math.ceil(totalChars / CHARS_PER_TOKEN) < MIN_CACHEABLE_TOKENS) return false;

  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i]!;
    if (!tool.cache_control) {
      tool.cache_control = { type: "ephemeral" };
      return true;
    }
  }
  return false;
}

/**
 * Public entrypoint — call right before sending the body to the proxy.
 * Mutates and returns the body for convenience (we already cloned upstream).
 */
export function injectCacheControl(
  body: AnthropicMessagesRequest,
): AnthropicMessagesRequest {
  const existing = alreadyHasCacheBreakpoints(body);
  // Anthropic hard cap is 4; reserve one slot for the caller in case
  // they add their own per-message marker mid-conversation.
  const budget = Math.max(0, 4 - existing - 1);
  if (budget <= 0) return body;

  let added = 0;
  if (added < Math.min(budget, MAX_BREAKPOINTS_WE_ADD) && markSystem(body)) {
    added += 1;
  }
  if (added < Math.min(budget, MAX_BREAKPOINTS_WE_ADD) && markTools(body)) {
    added += 1;
  }
  return body;
}
