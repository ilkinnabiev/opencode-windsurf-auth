/**
 * Per-request routing — decide which proxy endpoint best serves the model.
 *
 * Why bother?
 *   The proxy exposes both `/v1/chat/completions` (OpenAI dialect) AND
 *   `/v1/messages` (Anthropic dialect). For Claude family the Anthropic
 *   path preserves `tool_use` blocks more faithfully (the proxy's own
 *   `src/handlers/messages.js` uses the native Cascade Anthropic bridge).
 *
 *   For everything else (GPT, Gemini, Kimi, GLM, …) `/v1/chat/completions`
 *   is what those models were trained on.
 *
 * Strategy:
 *   model.startsWith("claude-") AND options.routeClaudeToAnthropic
 *     → /v1/messages, body converted to Anthropic shape
 *   else → /v1/chat/completions, body forwarded as-is
 *
 * The routing decision happens per-request, not at loader time, because
 * a single OpenCode session can call multiple models.
 */

import { ANTHROPIC_ROUTED_PREFIXES, PROXY_PATHS } from "../constants.js";
import type { AnthropicMessagesRequest, OpenAIChatRequest } from "../types.js";
import { openaiToAnthropic } from "./convert.js";
import { injectCacheControl } from "./cache-control.js";
import { shrinkRequestBody } from "./shrink.js";

export type RouteProtocol = "openai" | "anthropic";

export interface RoutedRequest {
  url: string;
  body: unknown;
  protocol: RouteProtocol;
  /**
   * Diagnostics — populated when our pre-flight reshaping actually
   * mutated the body. Useful for the loader to surface a log line.
   */
  diagnostics?: {
    shrinkDroppedBytes?: number;
    shrinkDroppedMessages?: number;
    cacheControlInjected?: boolean;
  };
}

export interface RouteOptions {
  routeClaudeToAnthropic: boolean;
  /**
   * When true (default), dedupe byte-identical system messages and
   * drop empty placeholder system messages before sending. Conservative
   * by design — see lib/request/shrink.ts header for what we won't touch.
   */
  shrinkBody?: boolean;
  /**
   * When true (default), mark Anthropic /v1/messages bodies with
   * `cache_control: ephemeral` on the system + tools prefix. No-op for
   * /v1/chat/completions. See lib/request/cache-control.ts header for
   * what proxies will/won't honour today.
   */
  injectCacheControl?: boolean;
}

export function pickEndpointPath(
  model: string | undefined,
  options: RouteOptions,
): { path: string; protocol: RouteProtocol } {
  const name = String(model ?? "").toLowerCase();
  if (
    options.routeClaudeToAnthropic &&
    ANTHROPIC_ROUTED_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    return { path: PROXY_PATHS.MESSAGES, protocol: "anthropic" };
  }
  return { path: PROXY_PATHS.CHAT, protocol: "openai" };
}

/**
 * Inspect the original request URL — if the upstream SDK has explicitly
 * picked a non-chat dialect (e.g. `@ai-sdk/anthropic` posting to /v1/messages
 * or the Responses API) we respect that and skip our model-based routing.
 *
 * NOTE: we do NOT short-circuit on `/v1/chat/completions` because the
 * OpenAI-compatible SDK always sends there as a default — that's the case
 * where our model-based routing actually kicks in (e.g. claude-* → /v1/messages).
 */
export function detectPreEncodedProtocol(url: string): RouteProtocol | null {
  if (url.endsWith(PROXY_PATHS.MESSAGES)) return "anthropic";
  if (url.endsWith(PROXY_PATHS.RESPONSES)) return "openai";
  return null;
}

/**
 * Main entrypoint: given the original OpenCode request URL and body,
 * return the rewritten URL + body and the protocol the proxy will speak
 * back to us in.
 *
 * `proxyUrl` is the WindsurfAPI base URL ("http://localhost:3003").
 */
export function routeRequest(
  proxyUrl: string,
  originalUrl: string,
  originalBody: OpenAIChatRequest,
  options: RouteOptions,
): RoutedRequest {
  const shrinkEnabled = options.shrinkBody !== false;
  const cacheControlEnabled = options.injectCacheControl !== false;
  const diagnostics: RoutedRequest["diagnostics"] = {};

  // Stage 1 — body shrink (OpenAI shape, before any conversion). Safe to
  // run unconditionally; it's a no-op when there's nothing to dedupe.
  let workingBody: OpenAIChatRequest = originalBody;
  if (shrinkEnabled) {
    const shrinkResult = shrinkRequestBody(originalBody);
    if (shrinkResult.changed) {
      workingBody = shrinkResult.body;
      diagnostics.shrinkDroppedBytes = shrinkResult.droppedBytes;
      diagnostics.shrinkDroppedMessages = shrinkResult.droppedMessages;
    }
  }

  const preEncoded = detectPreEncodedProtocol(originalUrl);
  if (preEncoded === "anthropic") {
    // Caller already produced an Anthropic body — we just stamp cache
    // breakpoints on top. Body is already in Anthropic shape so we can
    // pass it straight to injectCacheControl after a structural cast.
    const finalBody = cacheControlEnabled
      ? injectCacheControl(workingBody as unknown as AnthropicMessagesRequest)
      : (workingBody as unknown as AnthropicMessagesRequest);
    diagnostics.cacheControlInjected = cacheControlEnabled;
    return {
      url: `${proxyUrl}${PROXY_PATHS.MESSAGES}`,
      body: finalBody,
      protocol: "anthropic",
      diagnostics,
    };
  }
  if (preEncoded === "openai") {
    return {
      url: `${proxyUrl}${PROXY_PATHS.RESPONSES}`,
      body: workingBody,
      protocol: "openai",
      diagnostics,
    };
  }

  // Default: route by model family.
  const { path, protocol } = pickEndpointPath(workingBody.model, options);
  if (protocol === "anthropic") {
    const anthropicBody = openaiToAnthropic(workingBody);
    const finalBody = cacheControlEnabled
      ? injectCacheControl(anthropicBody)
      : anthropicBody;
    diagnostics.cacheControlInjected = cacheControlEnabled;
    return {
      url: `${proxyUrl}${path}`,
      body: finalBody,
      protocol,
      diagnostics,
    };
  }
  return {
    url: `${proxyUrl}${path}`,
    body: workingBody,
    protocol,
    diagnostics,
  };
}
