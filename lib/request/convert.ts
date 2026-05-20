/**
 * OpenAI ↔ Anthropic body conversion.
 *
 * We only convert what we actually emit — `routeRequest` calls
 * `openaiToAnthropic` when it has chosen to send a Claude-family request
 * to the proxy's `/v1/messages` endpoint. The reverse direction is
 * normally unnecessary because the AI SDK's Anthropic adapter handles
 * Anthropic responses natively.
 *
 * Conversion contract — what we MUST preserve:
 *   • System messages — concatenated into `system` (Anthropic top-level)
 *   • Multimodal content — image_url → image source block
 *   • Tool calls — assistant tool_calls → tool_use blocks
 *   • Tool results — tool messages → user `tool_result` blocks
 *
 * Conversion contract — what we SAFELY drop:
 *   • `name` on messages (Anthropic has no equivalent)
 *   • OpenAI-specific reasoning fields (`reasoning_effort`, etc.) —
 *     the proxy doesn't read them on /v1/messages anyway
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicSystemPart,
  OpenAIChatContentPart,
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "../types.js";

function ensureArrayContent(
  content: OpenAIChatMessage["content"],
): OpenAIChatContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content;
  return [];
}

function partToAnthropic(part: OpenAIChatContentPart): AnthropicContentBlock | null {
  if (part.type === "text" && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (part.type === "image_url" && part.image_url?.url) {
    const url = part.image_url.url;
    // data URI: data:image/png;base64,XXXX
    const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
    if (dataMatch) {
      return {
        type: "image",
        source: { type: "base64", media_type: dataMatch[1]!, data: dataMatch[2]! },
      };
    }
    // Plain http(s) URLs — the proxy's image handler downloads + base64s
    // these, but at the API surface we can only express data: URIs in
    // Anthropic shape. Emit a text fallback so the user sees the URL.
    return { type: "text", text: `[image: ${url}]` };
  }
  return null;
}

function buildSystemFromMessages(
  messages: OpenAIChatMessage[],
): string | AnthropicSystemPart[] | undefined {
  const systemTexts = messages
    .filter((m) => m.role === "system")
    .flatMap((m) => ensureArrayContent(m.content))
    .filter((p): p is OpenAIChatContentPart & { text: string } => p.type === "text" && !!p.text)
    .map((p) => p.text);
  if (systemTexts.length === 0) return undefined;
  if (systemTexts.length === 1) return systemTexts[0];
  // Anthropic system blocks are nicer when there are multiple sources
  // (e.g. CLI's system prompt + user-supplied one). Keep them separated
  // so a future cacheControl: ephemeral marker can be added per block.
  return systemTexts.map<AnthropicSystemPart>((text) => ({ type: "text", text }));
}

function assistantToAnthropic(message: OpenAIChatMessage): AnthropicMessage {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of ensureArrayContent(message.content)) {
    const block = partToAnthropic(part);
    if (block) blocks.push(block);
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call?.function?.name) continue;
      let parsedArgs: unknown = {};
      try {
        parsedArgs = call.function.arguments
          ? JSON.parse(call.function.arguments)
          : {};
      } catch {
        // Some models emit non-JSON arguments; pass the string through.
        parsedArgs = call.function.arguments;
      }
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parsedArgs,
      });
    }
  }
  // Anthropic requires at least one content block; a single empty text
  // block is the safe degenerate.
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return { role: "assistant", content: blocks };
}

function userOrToolToAnthropic(message: OpenAIChatMessage): AnthropicMessage {
  if (message.role === "tool" && message.tool_call_id) {
    const text =
      typeof message.content === "string"
        ? message.content
        : ensureArrayContent(message.content)
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text!)
            .join("\n");
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: text,
        },
      ],
    };
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const part of ensureArrayContent(message.content)) {
    const block = partToAnthropic(part);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return { role: "user", content: blocks };
}

function coalesceAdjacentSameRole(messages: AnthropicMessage[]): AnthropicMessage[] {
  // Anthropic disallows two consecutive messages of the same role except
  // through merging. The proxy's /v1/messages handler is more lenient,
  // but we still merge to keep the wire payload smaller.
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    const tail = out[out.length - 1];
    if (tail && tail.role === message.role) {
      const tailBlocks = Array.isArray(tail.content)
        ? tail.content
        : [{ type: "text", text: tail.content } satisfies AnthropicContentBlock];
      const nextBlocks = Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: message.content } satisfies AnthropicContentBlock];
      out[out.length - 1] = { role: tail.role, content: [...tailBlocks, ...nextBlocks] };
    } else {
      out.push(message);
    }
  }
  return out;
}

export function openaiToAnthropic(body: OpenAIChatRequest): AnthropicMessagesRequest {
  const system = buildSystemFromMessages(body.messages);
  const nonSystem = body.messages.filter((m) => m.role !== "system");

  const converted: AnthropicMessage[] = nonSystem.map((message) => {
    if (message.role === "assistant") return assistantToAnthropic(message);
    return userOrToolToAnthropic(message);
  });

  const messages = coalesceAdjacentSameRole(converted);

  const result: AnthropicMessagesRequest = {
    model: body.model ?? "claude-sonnet-4.6",
    messages,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 32768,
    stream: body.stream,
  };

  if (system !== undefined) result.system = system;
  if (typeof body.temperature === "number") result.temperature = body.temperature;

  // Anthropic tool definitions have the same shape as OpenAI's in the
  // proxy's /v1/messages handler — forward without normalisation, the
  // proxy's `cascade-native-bridge.js` handles dialect quirks.
  if (Array.isArray(body.tools)) result.tools = body.tools;
  if (body.tool_choice !== undefined) result.tool_choice = body.tool_choice;

  return result;
}
