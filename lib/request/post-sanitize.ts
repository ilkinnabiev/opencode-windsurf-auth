/**
 * Stream-level scrubber for residual Windsurf / Cascade fingerprints.
 *
 * The proxy already runs three layers of sanitisation (`src/sanitize.js`),
 * but a few markers occasionally leak through:
 *
 *   • Literal "/tmp/windsurf-workspace/" paths in model output
 *   • Self-references to "Cascade" / "Windsurf" when the user asks
 *     "what model are you?"
 *   • Quoted IDE-specific tool names ("apply_changes", "view_file", …)
 *     emitted in narration rather than tool calls
 *
 * This module wraps a fetch Response to scrub those tokens from the
 * SSE / JSON body as it flows back to OpenCode. We are deliberately
 * conservative — replacing too aggressively would corrupt legitimate
 * mentions (e.g. a user asking about WindsurfAPI itself).
 */

import { log } from "../logger.js";

/** Replacements applied to plain text chunks before they reach OpenCode. */
const SCRUB_RULES: Array<[RegExp, string]> = [
  // Strip the workspace stub path entirely — model has no reason to
  // mention it under any prompt, and seeing it usually means the
  // proxy missed a sanitize hop.
  [/\/tmp\/windsurf-workspace\/?[A-Za-z0-9._\-/]*/g, ""],
  // First-person identity claims about Cascade / Windsurf. The proxy's
  // identity-injection panel already discourages these, but cold-cache
  // turns sometimes regress to baked-in text.
  [/\bI(?:'m| am)\s+(?:Cascade|Windsurf)(?:\s*,?\s*an?\s*[A-Za-z-]*AI)?/gi, "I'm an AI assistant"],
  [/\bCascade\b/g, "the assistant"],
  // Don't touch "Windsurf" if it's in a URL or code reference (e.g.
  // github.com/dwgx/WindsurfAPI in docs). Only neutralise it inside
  // narration phrases.
  [/(?<![A-Za-z0-9_/.-])Windsurf(?:\s+(?:AI|model|assistant))?(?![A-Za-z0-9_/.-])/g, "Claude"],
];

function scrubText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Determine whether a response body is worth scrubbing. We skip:
 *   - Non-text responses (binary, JSON of unknown shape)
 *   - Responses without a body (HEAD, 204, etc.)
 */
function shouldScrub(response: Response): boolean {
  if (!response.body) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return (
    contentType.includes("event-stream") ||
    contentType.includes("text/plain") ||
    contentType.includes("application/json")
  );
}

/**
 * Wrap a Response so its body is scrubbed line-by-line. The wrapper
 * preserves status, headers, and stream-vs-buffered semantics — only
 * the visible bytes change.
 */
export function scrubResponse(response: Response): Response {
  if (!shouldScrub(response)) return response;
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();

  let buffered = "";
  let scrubCount = 0;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          if (buffered) {
            const scrubbed = scrubText(buffered);
            if (scrubbed !== buffered) scrubCount += 1;
            controller.enqueue(encoder.encode(scrubbed));
          }
          if (scrubCount > 0) {
            log.debug(`post-sanitize: scrubbed ${scrubCount} chunk(s) for ${response.url || "<unknown>"}`);
          }
          controller.close();
          return;
        }
        const chunk = decoder.decode(value, { stream: true });
        buffered += chunk;

        // Process complete lines; keep any trailing partial line buffered
        // so we don't scrub mid-token. SSE is line-oriented (events end
        // with "\n\n") so partial lines are common.
        const lastNewline = buffered.lastIndexOf("\n");
        if (lastNewline === -1) return;
        const complete = buffered.slice(0, lastNewline + 1);
        buffered = buffered.slice(lastNewline + 1);

        const scrubbed = scrubText(complete);
        if (scrubbed !== complete) scrubCount += 1;
        controller.enqueue(encoder.encode(scrubbed));
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
