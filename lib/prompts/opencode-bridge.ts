/**
 * OpenCode-tuned system prompts pushed into the proxy's runtime config.
 *
 * The proxy exposes `PUT /dashboard/api/system-prompts` (see
 * WindsurfAPI `src/dashboard/api.js`) which writes into the editable
 * communication / tool-reinforcement slots in
 * `CascadeConversationalPlannerConfig.communication_section` etc.
 *
 * Those slots are the highest-leverage place to neutralise Cascade's
 * baked-in "I'm a coding agent at Windsurf" priors: they replace the
 * proto-level system prompt sections that the LS binary would otherwise
 * inject. See the comment block in `windsurf.js` around line 420 for
 * the field-numbering rationale.
 *
 * We push these prompts once per session (debounced via state.json) so
 * we don't spam the dashboard on every loader call. The proxy persists
 * them to `runtime-config.json` so they survive restarts.
 */

import { log } from "../logger.js";
import { PROXY_PATHS } from "../constants.js";
import { readState, writeState } from "../auth/storage.js";

/** Inject ONCE every 12 hours — covers normal session cadence. */
const REAPPLY_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Communication section overrides — pushed into Cascade's
 * `communication_section` (proto field 13) via SectionOverrideConfig.
 *
 * IMPORTANT — what we deliberately do NOT include here:
 *   • Identity manipulation ("don't call yourself X", "say you are Y"):
 *     Cascade's anti-prompt-injection layer flags these as injection
 *     attempts and rejects the entire request with `an internal error
 *     occurred` (see comments in proxy's src/windsurf.js around line 471
 *     and our own production observation 2026-05-20 on gemini-2.5-flash).
 *     We let the model keep its baked-in identity at the proto level and
 *     rely on our outbound stream sanitiser to scrub residual "Cascade" /
 *     "Windsurf" mentions instead.
 *   • XML `<tool_call>` reinforcement: the proxy already inserts the
 *     correct tool-call markup per model (openai_json_xml / glm47 /
 *     kimi_k2 …) via src/handlers/tool-emulation.js. Pushing our own
 *     XML format dupes (or worse — contradicts) the proxy's choice.
 *     We omit `toolReinforcement` from the payload entirely; the proxy
 *     keeps its own default which is model-aware.
 */
export const OPENCODE_PROMPT_WITH_TOOLS = `You are running as the backing model for OpenCode, a terminal coding agent. The OpenCode client executes tools LOCALLY on the user's machine on your behalf.

Operating rules:
- When the user asks for an action that maps to one of the provided functions (read/modify a file, run a shell command, search the codebase, manage the task list, etc.), CALL that function instead of describing what you would do.
- Do not narrate planning preambles such as "Let me check that file" — call the function directly.
- Never reference paths under /tmp/windsurf-workspace or any other proxy-internal scratch directory; those are not part of the user's project.
- Respond in the exact same language the user used in their latest message; never switch mid-conversation.`;

export const OPENCODE_PROMPT_WITHOUT_TOOLS = `You are running as the backing model for OpenCode (no tools attached this turn).

Operating rules:
- You have NO file access, NO shell, NO web. Answer from your training only.
- Do not claim to have viewed, read, opened, or executed anything in the user's environment. If a file is referenced but its contents aren't in the conversation, ask the user to paste them.
- Respond in the exact same language the user used in their latest message; never switch mid-conversation.`;

/**
 * PUT the OpenCode-tuned prompts into the proxy's runtime config.
 * Idempotent — checks state.json to avoid re-applying within
 * REAPPLY_INTERVAL_MS.
 */
export async function applyOpenCodePrompts(
  proxyUrl: string,
  apiKey: string,
  options: { force?: boolean; dashboardPassword?: string } = {},
): Promise<{ applied: boolean; reason: string }> {
  const state = readState();
  const stale =
    options.force ||
    !state.promptsAppliedAt ||
    Date.now() - state.promptsAppliedAt > REAPPLY_INTERVAL_MS;
  if (!stale) {
    return { applied: false, reason: "recently applied (state.json)" };
  }

  // Resolve the dashboard admin password — option wins, then env vars.
  // We deliberately accept the bare `DASHBOARD_PASSWORD` because that's
  // the same name the proxy uses in its `.env` (low-friction copy-paste).
  const dashboardPassword =
    options.dashboardPassword ??
    process.env.WINDSURFAPI_DASHBOARD_PASSWORD ??
    process.env.DASHBOARD_PASSWORD ??
    "";

  // Bail out BEFORE the network call when we have no password configured.
  // Hitting the endpoint with no auth would (a) always 401 and (b) bump
  // the proxy's per-IP bruteforce counter — repeated OpenCode restarts
  // would eventually get this IP temp-banned from the dashboard. We mark
  // the attempt as "soft-applied" so we don't retry until the next
  // REAPPLY_INTERVAL_MS window.
  if (!dashboardPassword) {
    log.info(
      "skipping system-prompt push: no dashboard password configured. " +
        "Set provider.windsurf.options.dashboardPassword or env var " +
        "WINDSURFAPI_DASHBOARD_PASSWORD if you want the proxy to inject " +
        "OpenCode-tuned prompts at the source. The plugin's own " +
        "post-sanitiser still scrubs the response stream.",
    );
    writeState({ promptsAppliedAt: Date.now() });
    return { applied: false, reason: "no dashboard password" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    accept: "application/json",
    "X-Dashboard-Password": dashboardPassword,
  };

  try {
    const response = await fetch(`${proxyUrl}${PROXY_PATHS.DASHBOARD_API_SYSTEM_PROMPTS}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        prompts: {
          // toolReinforcement is intentionally omitted — see file header.
          communicationWithTools: OPENCODE_PROMPT_WITH_TOOLS,
          communicationNoTools: OPENCODE_PROMPT_WITHOUT_TOOLS,
        },
      }),
    });
    if (!response.ok) {
      // 401 = wrong password. Soft-skip and back off for REAPPLY_INTERVAL_MS
      // so we don't keep trying (and accumulating bruteforce strikes).
      // 429 = already rate-limited / banned. Same treatment.
      if (response.status === 401 || response.status === 429) {
        const text = await response.text().catch(() => "");
        log.info(
          `skipping system-prompt push (HTTP ${response.status}): ` +
            `${text.slice(0, 160)}. The plugin's post-sanitiser still ` +
            `runs, so model output stays clean. Will retry in ~12h.`,
        );
        writeState({ promptsAppliedAt: Date.now() });
        return { applied: false, reason: `HTTP ${response.status}` };
      }
      const text = await response.text().catch(() => "");
      log.warn(`could not apply OpenCode prompts: HTTP ${response.status} ${text.slice(0, 200)}`);
      return { applied: false, reason: `HTTP ${response.status}` };
    }
    writeState({ promptsAppliedAt: Date.now() });
    log.info("OpenCode-tuned system prompts applied to proxy");
    return { applied: true, reason: "ok" };
  } catch (err) {
    const message = (err as Error).message;
    log.warn(`could not apply OpenCode prompts: ${message}`);
    return { applied: false, reason: message };
  }
}
