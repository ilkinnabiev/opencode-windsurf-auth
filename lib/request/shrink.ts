/**
 * Minimal, conservative body shrinking — runs on the request just before
 * it hits the proxy.
 *
 * Why this exists
 * ───────────────
 * Cascade's LS pipeline has a soft ceiling around 30KB on the assembled
 * system payload (proxy logs literally print a WARN above ~27KB and a
 * second WARN about the toolPreamble exceeding 23KB). Once the LS panel
 * state drifts past that ceiling the upstream returns an opaque
 * `internal error occurred` and the proxy translates it as
 * `model_not_entitled`.
 *
 * OpenCode itself happens to emit large, sometimes *redundant* system
 * messages (the tools spec + a few <system-reminder> echoes), and the
 * AI SDK doesn't dedupe them on the way out. Cheapest fix that respects
 * "do nothing surprising": collapse byte-identical adjacent system
 * messages into one.
 *
 * What we deliberately DON'T do
 * ─────────────────────────────
 *   • Re-summarise the tools spec — that risks dropping params the model
 *     needs to make a valid tool_call. Leave compression to the proxy
 *     (it already falls back to schema-compact tier at 14KB).
 *   • Truncate or rewrite arbitrary user content — never.
 *   • Strip <system-reminder> blocks — they often carry useful state
 *     diffs between turns.
 *
 * The deduplication is byte-for-byte; we never modify strings, only drop
 * duplicates that contribute nothing.
 */

import type { OpenAIChatMessage, OpenAIChatRequest } from "../types.js";

export interface ShrinkResult {
  body: OpenAIChatRequest;
  changed: boolean;
  droppedBytes: number;
  droppedMessages: number;
}

/**
 * Stringify message content for equality checks. We only collapse
 * messages whose stringified content is byte-identical — anything more
 * clever risks dropping meaningful differences (e.g. role: "system" with
 * different cache_control hints).
 */
function contentSignature(message: OpenAIChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    try {
      return JSON.stringify(message.content);
    } catch {
      return "";
    }
  }
  return "";
}

function byteLength(message: OpenAIChatMessage): number {
  const sig = contentSignature(message);
  return Buffer.byteLength(sig, "utf8");
}

/**
 * Dedupe byte-identical system messages, preserving the first
 * occurrence. We also drop empty system messages (some clients emit
 * `{role: "system", content: ""}` as a placeholder).
 */
export function shrinkRequestBody(body: OpenAIChatRequest): ShrinkResult {
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return { body, changed: false, droppedBytes: 0, droppedMessages: 0 };
  }

  const seenSystemSignatures = new Set<string>();
  const kept: OpenAIChatMessage[] = [];
  let droppedBytes = 0;
  let droppedMessages = 0;

  for (const message of body.messages) {
    if (message.role !== "system") {
      kept.push(message);
      continue;
    }
    const sig = contentSignature(message);
    if (sig.trim().length === 0) {
      droppedBytes += byteLength(message);
      droppedMessages += 1;
      continue;
    }
    if (seenSystemSignatures.has(sig)) {
      droppedBytes += byteLength(message);
      droppedMessages += 1;
      continue;
    }
    seenSystemSignatures.add(sig);
    kept.push(message);
  }

  const changed = droppedMessages > 0;
  if (!changed) {
    return { body, changed: false, droppedBytes: 0, droppedMessages: 0 };
  }

  return {
    body: { ...body, messages: kept },
    changed: true,
    droppedBytes,
    droppedMessages,
  };
}
