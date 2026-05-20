# opencode-windsurf-auth

> Use Windsurf's 130+ AI models (Claude Sonnet/Opus 4.x, GPT-5.x, Gemini 3, Kimi, GLM, Grok, …) inside [OpenCode](https://opencode.ai/) through your own [WindsurfAPI](https://github.com/dwgx/WindsurfAPI) proxy.

A thin **companion plugin** — it does not embed or supervise WindsurfAPI. You run the proxy however you like (`node src/index.js`, Docker, PM2, …) and the plugin talks to it over HTTP, adding:

- **Per-model routing** — Claude family → `/v1/messages` (native Anthropic semantics, best tool-call fidelity), everything else → `/v1/chat/completions`.
- **OpenCode-tuned system prompt overrides** — pushed once into the proxy so models don't narrate `/tmp/windsurf-workspace/` paths or refuse to use tools.
- **Defence-in-depth output sanitiser** — streams residual Cascade/Windsurf mentions out of the response.
- **Anthropic prompt-cache markers** + system-message dedup — small but real savings on long sessions (where supported by upstream).

---

## ⚠️ Before you start: pick a Windsurf plan

This plugin reuses your **Windsurf account** to access models through the WindsurfAPI proxy. The plan dictates which models are actually usable through any API surface (including this one):

| Plan | What you get | Verdict |
|---|---|---|
| **Free** | 25 prompts/week, ~4 small models on paper (gpt-4o-mini, gpt-4.1-mini, gpt-5-mini, gemini-2.5-flash, minimax-m2.5) — but most are deprecated or de-entitled after the first call when accessed outside the Windsurf desktop client. | ⚠️ **Largely non-functional for this plugin.** Use it only to verify the install works end-to-end. |
| **Pro** ($15/mo) | The full ~130-model catalogue (Claude Sonnet 4.6, Opus 4.7, GPT-5.x, Gemini 3, …) with generous quotas. | ✅ **This is the recommended plan.** |
| **Pro Ultimate / Teams** | Higher quotas + 1M-context Claude variants. | ✅ Best, but Pro is enough for most use. |

If you don't have a Pro Windsurf subscription, **install this plugin only to test the pipeline** — none of the high-end models you actually want will respond. Get Pro first, then come back here.

---

## Install

Manual install, three steps. The plugin is registered in OpenCode via the `<name>@file://<dir>` pattern (the same mechanism OpenCode itself uses for `oh-my-opencode` and other local plugins) — no npm publish required.

### 1. Clone and build

```bash
# Pick any directory; ~/.opencode/plugins/ keeps things tidy.
mkdir -p ~/.opencode/plugins
git clone https://github.com/mrnabiev/opencode-windsurf-auth.git \
  ~/.opencode/plugins/opencode-windsurf-auth

cd ~/.opencode/plugins/opencode-windsurf-auth
npm install
npm run build
```

### 2. Register the plugin in OpenCode

Open `~/.config/opencode/opencode.jsonc` and add to the `plugin` array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-windsurf-auth@file:///Users/YOU/.opencode/plugins/opencode-windsurf-auth"
  ],
  "provider": {
    /* see step 3 */
  }
}
```

Replace `/Users/YOU/` with your real home path (`echo $HOME`).

### 3. Add the Windsurf provider

Copy one of the presets from this repo into the `provider` section of your `opencode.jsonc`:

- [`config/opencode-modern.json`](./config/opencode-modern.json) — full curated list (~20 models incl. Claude, GPT-5.x, Gemini, Kimi, GLM, Grok).
- [`config/opencode-claude-only.json`](./config/opencode-claude-only.json) — Claude-only preset, best tool-call stability.

Minimum viable provider block:

```jsonc
"provider": {
  "windsurf": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "Windsurf",
    "options": { "baseURL": "http://localhost:3003/v1" },
    "models": {
      "claude-sonnet-4.6": { "name": "Claude Sonnet 4.6" }
    }
  }
}
```

Restart OpenCode after editing the config. The plugin will autodetect the proxy on first request.

---

## Run the WindsurfAPI proxy

The plugin **does not start** the proxy for you — that's intentional (the proxy can live anywhere: localhost, Docker, a VPS). The proxy is a separate project: [`dwgx/WindsurfAPI`](https://github.com/dwgx/WindsurfAPI). Clone it once, then pick a run mode:

```bash
git clone https://github.com/dwgx/WindsurfAPI.git ~/.windsurfapi
cd ~/.windsurfapi
# Install the Language Server binary it needs (one-time, ~250MB):
bash install-ls.sh
# Configure (see ".env" template below)
cp .env.example .env && $EDITOR .env
```

### Option A — local, foreground (simplest)

```bash
cd ~/.windsurfapi
node src/index.js
```

Leave it running in one terminal, use OpenCode in another.

### Option B — local, background

```bash
cd ~/.windsurfapi
nohup node src/index.js > /tmp/windsurfapi.log 2>&1 &
disown
# logs:    tail -f /tmp/windsurfapi.log
# stop:    lsof -ti:3003 | xargs kill
```

### Option C — Docker

The WindsurfAPI repo ships a `docker-compose.yml`:

```bash
cd ~/.windsurfapi
docker compose up -d
```

### Recommended `.env` for single-user local setups

```bash
HOST=127.0.0.1                    # loopback only — required for open mode
PORT=3003
API_KEY=                          # empty = open mode (no proxy auth)
DASHBOARD_PASSWORD=<your-choice>  # required only if you want the dashboard
LS_BINARY_PATH=~/.windsurf/language_server_macos_arm
```

The empty `API_KEY` is safe because `HOST=127.0.0.1` makes the proxy listen on loopback only — no remote process can reach it. The plugin **auto-detects this** and runs prompt-free during sign-in.

If you want to expose the proxy beyond your machine (team-shared VPS), set `API_KEY=<secret>` and `HOST=0.0.0.0`. The plugin then picks up the bearer either from `WINDSURFAPI_KEY` env or via the "advanced" sign-in method.

---

## Sign in

Once the proxy is running and the plugin is installed:

```bash
opencode auth login
#   → Windsurf
#   → Sign in with Windsurf (import desktop login)   ← zero-click in the best case
```

### Sign-in methods

| Method | What it does | When to pick it |
|---|---|---|
| **Sign in with Windsurf (import desktop login)** | Reads the Windsurf desktop app's stored apiKey from `state.vscdb` and registers it with your proxy. | You have the Windsurf desktop app installed and signed in. **Zero clicks, zero prompts.** |
| **Sign in with Windsurf (paste auth token)** | Opens `https://windsurf.com/show-auth-token` in your browser; you paste the token shown there. | No desktop app, or you want a one-off account. |
| **WindsurfAPI proxy API key (advanced)** | Just records the proxy's `API_KEY`. Does **not** add a Windsurf account on its own. | Your proxy already has accounts (added on another machine, in CI, via the dashboard, etc). |
| **Open WindsurfAPI dashboard (advanced)** | Opens `http://localhost:3003/dashboard`; you add the account there; plugin polls until it appears. | Fine-grained control or the other methods don't work for you. |

### How the proxy bearer is auto-resolved during sign-in

The first two methods never ask you for the proxy's `API_KEY`. They figure it out:

1. **Try open mode** — `GET /auth/accounts` with no `Authorization` header. If it returns 200, the proxy doesn't need auth, done.
2. **Fallback to `WINDSURFAPI_KEY`** env var (legacy alias: `WINDSURF_API_KEY`).
3. **Fail with a friendly hint** pointing at the env var or the "advanced" method.

---

## Use it

```bash
opencode
# /models → Windsurf → Claude Sonnet 4.6
# ask anything; the plugin transparently routes Claude → /v1/messages
# and everything else → /v1/chat/completions
```

### Recommended models

| Goal | Pick | Why |
|---|---|---|
| Daily driver | `claude-sonnet-4.6` | Best tool stability, 200K ctx, sane price. |
| Heavy reasoning | `claude-opus-4-7-medium` or `-high` | Top-tier coding model; pick `-medium` unless you really need `-high`. |
| Cheap & fast | `claude-4.5-haiku` | Same protocol as Sonnet, ⅛ the credit cost. |
| Massive context | `claude-sonnet-4.6-1m` | 1M-token window for whole-repo questions. |
| GPT taste | `gpt-5.2` / `gpt-5.2-codex-medium` | Works, but tool-call reliability is lower than Claude. |
| Reasoning experiments | `gpt-5.2-xhigh`, `claude-opus-4-7-xhigh` | When you want the model to actually think. |

**Avoid in agent loops** (e.g. `opencode run`): `glm-5.1` (occasional empty responses), `gpt-4o-mini` / `gpt-4.1-mini` (deprecated upstream), anything tagged `legacy` in `GET /v1/models`.

---

## Configuration

Everything lives under `provider.windsurf.options` in `~/.config/opencode/opencode.jsonc`:

```jsonc
"windsurf": {
  "npm": "@ai-sdk/openai-compatible",
  "name": "Windsurf",
  "options": {
    "baseURL": "http://localhost:3003/v1",
    "dashboardPassword": "...",        // only if you want prompt-overrides to push
    "shrinkBody": true,                 // default
    "injectCacheControl": true,         // default
    "postSanitize": true                // default
  },
  "models": { /* … */ }
}
```

### Options reference

| Key | Default | Purpose |
|---|---|---|
| `baseURL` | autodetect | Proxy URL. Stripped of the trailing `/v1` for routing internally. |
| `candidates` | `[]` | Extra URLs to probe before falling back to defaults (`localhost:3003`, `127.0.0.1:3003`, `localhost:3000`). |
| `routeClaudeToAnthropic` | `true` | Send `claude-*` requests to `/v1/messages`. Disable only if the proxy doesn't expose that endpoint. |
| `installPromptOverrides` | `true` | PUT OpenCode-tuned prompts into the proxy on first init (debounced to 12h). Soft-skips with an info log if the dashboard refuses (no password / 401 / 429). |
| `dashboardPassword` | from `WINDSURFAPI_DASHBOARD_PASSWORD` or `DASHBOARD_PASSWORD` env | The dashboard admin password. Only needed if you want `installPromptOverrides` to succeed. |
| `shrinkBody` | `true` | Dedupe byte-identical / empty system messages before sending. Conservative — never touches user content or tool specs. |
| `injectCacheControl` | `true` | Mark Anthropic `/v1/messages` bodies with `cache_control: ephemeral` on the system + tools prefix. Currently a no-op against Cascade (proxy doesn't propagate yet) but correct against direct Anthropic. |
| `postSanitize` | `true` | Stream-level scrub of residual `Cascade` / `Windsurf` / `/tmp/windsurf-workspace/` mentions in model output. |
| `silent` | `false` | Suppress plugin log lines on stderr. |

### Environment variables

| Var | Effect |
|---|---|
| `WINDSURF_API_URL` | Force a specific proxy URL (overrides autodetect, beaten by explicit `baseURL`). |
| `WINDSURFAPI_KEY` | Proxy `API_KEY` used during sign-in when the proxy is **not** in open mode. Lets the "Sign in with Windsurf" methods stay prompt-free. (Alias: `WINDSURF_API_KEY`.) |
| `WINDSURFAPI_DASHBOARD_PASSWORD` | Proxy `DASHBOARD_PASSWORD`. Required only for the optional system-prompt push. Falls back to bare `DASHBOARD_PASSWORD` so you can reuse the proxy's `.env` value directly. |
| `WINDSURF_AUTH_DEBUG=1` | Enable debug log lines on stderr (request URLs, shrink stats, cache_control diagnostics, etc.). |

---

## How it actually works

Per request, the plugin's `fetch` hook does this:

```
opencode (TUI)
  → @ai-sdk/openai-compatible
  → THIS PLUGIN
      1. shrink body (drop dup/empty system messages)
      2. pick endpoint:  claude-*  → /v1/messages  (Anthropic body)
                         other     → /v1/chat/completions
      3. inject cache_control on system + tools prefix (Anthropic only)
      4. set Authorization: Bearer + headers
      5. fire request to proxy
      6. stream response, scrubbing Cascade/Windsurf mentions
  → WindsurfAPI proxy
      ├─ tool emulation (handlers/tool-emulation.js)
      └─ Cascade Language Server (gRPC)
  → Windsurf cloud
  → upstream model (Anthropic / OpenAI / Google / …)
```

On loader init (once per session) the plugin additionally:

- **Locates the proxy** — autodetects on common ports, overridable via `options.baseURL` or `WINDSURF_API_URL`.
- **Verifies the stored bearer** actually works (a quick `GET /auth/accounts` round-trip).
- **Pushes OpenCode-tuned prompts** into the proxy's runtime config via `PUT /dashboard/api/system-prompts` — debounced to once per 12h, soft-skipped if no dashboard password is available.

### What the OpenCode-tuned prompts actually say

Two slots get written to the proxy's `runtime-config.json`, overriding Cascade's defaults at proto-level (via `SectionOverrideConfig` on `communication_section`):

- **`communicationWithTools`** — "You are running as the backing model for OpenCode. The OpenCode client executes tools locally. Call the function instead of describing what you would do; don't reference `/tmp/windsurf-workspace/`; match the user's language."
- **`communicationNoTools`** — "You are running as the backing model for OpenCode (no tools attached). No file/shell/web access; don't claim to have viewed anything; match the user's language."

**Deliberately omitted:**

- **Identity manipulation** ("don't call yourself Cascade") — Cascade's anti-prompt-injection layer rejects requests that contain such instructions. We do identity cleanup on the **outbound stream** instead (`postSanitize`).
- **Tool-call format reinforcement** — the proxy already inserts the correct markup per model (`openai_json_xml` / `glm47` / `kimi_k2` …) via `handlers/tool-emulation.js`. Pushing our own would duplicate or contradict it.

### Why route Claude through `/v1/messages`?

Per WindsurfAPI's own notes:

> Claude family `<tool_use>` protocol is the most reliably trained. GPT in cascade DEFAULT planner mode is unstable for tools because cascade doesn't transmit the OpenAI `tools[]` schema natively. GLM-5.1 has frequent empty-response regressions.

The Anthropic path keeps `tool_use` / `tool_result` blocks native end-to-end and noticeably improves tool-call fidelity. For non-Claude models, OpenAI `chat/completions` is what they were trained on, so we use that.

---

## Troubleshooting

### "Sign in with Windsurf (import desktop login)" finds nothing

The Windsurf desktop app isn't installed or you're signed out. The plugin checks these paths for `state.vscdb`:

- **macOS:** `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb`
- **Linux:** `~/.config/Windsurf/User/globalStorage/state.vscdb`
- **Windows:** `%APPDATA%\Windsurf\User\globalStorage\state.vscdb`

Fix: install Windsurf desktop and sign in once, or use "paste auth token".

### Sign-in succeeds, but every model says "недоступна в пуле" (`model_not_entitled`)

You're on the **Free** Windsurf plan. See the warning at the top — Free is effectively non-functional through any API surface. Upgrade to Pro.

### `WARN: could not apply OpenCode prompts: HTTP 401`

The proxy enforces a dashboard password and you haven't given it to the plugin. Either:

```bash
export WINDSURFAPI_DASHBOARD_PASSWORD=<your DASHBOARD_PASSWORD>
```

…or set it in the plugin options:

```jsonc
"windsurf": { "options": { "dashboardPassword": "..." } }
```

…or just ignore it — the plugin's own stream sanitiser still scrubs Cascade mentions client-side. The push is a "make it cleaner on the wire" optimisation, not a hard requirement.

### `WARN: ... HTTP 429 IP banned for Ns`

The proxy's per-IP bruteforce counter triggered because something hit the dashboard with the wrong password too many times (often: repeated OpenCode restarts before the dashboard password was set up). Restart the proxy to clear the in-memory ban table; the plugin will then back off for 12h and not retry. From v0.1+ the plugin won't even attempt the push without a password configured, so this becomes a one-time-only issue.

### Tool calls are flaky / model narrates "Let me check that..."

You're probably using a non-Claude model. Switch to `claude-sonnet-4.6` and the difference is night and day. If you must use a GPT or Gemini model, accept that tool-call reliability is lower at the API layer — it's a property of how Cascade transmits those tool specs upstream, not the plugin.

### Latency feels high on the first request after a long idle

The proxy keeps the Cascade Language Server warm but Cascade itself spins up a session per inactive period. First request after >5 min idle = ~1-2s overhead, subsequent requests are fast.

---

## FAQ

**Q: Does this expose my Windsurf credentials?**
No. The token never leaves your machine — sign-in posts it to `localhost:3003/auth/login`, which stores it in the proxy's own `data/accounts.json`. The plugin stores nothing in OpenCode's `auth.json` beyond what's needed to talk to the proxy (in open mode that's literally an empty string).

**Q: Can I add multiple Windsurf accounts to the same proxy?**
Yes — open `http://localhost:3003/dashboard` (password from `DASHBOARD_PASSWORD`) and add accounts there. The proxy load-balances between active accounts automatically. The plugin's sign-in flow only adds one account at a time though.

**Q: Is this legal / sanctioned by Windsurf?**
Same answer as the underlying WindsurfAPI project: **it's reverse-engineered, not officially supported**. Windsurf could theoretically close the loophole in any update. Use accordingly — fine for personal use, not recommended as a hard production dependency.

**Q: Why not embed the proxy directly in the plugin?**
Because then this plugin would dictate one specific deployment shape (localhost? Docker? VPS?). WindsurfAPI already owns its own lifecycle excellently (LS supervision, account pool, dashboard, self-update). The plugin is just the OpenCode-specific glue.

**Q: Will this work with `opencode run` (non-interactive mode)?**
Yes for most models. Avoid `glm-5.1` and deprecated `gpt-4o-mini` family in agent loops — they sometimes return empty responses that break the loop.

---

## Development

```bash
git clone https://github.com/mrnabiev/opencode-windsurf-auth.git
cd opencode-windsurf-auth
npm install
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/

# Smoke-test against a running proxy:
WINDSURF_API_URL=http://localhost:3003 node -e \
  "import('./dist/index.js').then(({locateProxy}) => locateProxy().then(console.log))"
```

Helpers (probe / login functions usable from your own scripts) are exposed via `opencode-windsurf-auth/helpers`:

```ts
import {
  locateProxy, verifyProxyApiKey, listAccounts,
  loginWithWindsurfToken, applyOpenCodePrompts,
} from "opencode-windsurf-auth/helpers";
```

`index.ts` exports **only** the plugin factory — OpenCode iterates every named export from a plugin module and tries to call it as a factory, so helpers must live behind the `/helpers` subpath to avoid loader crashes.

---

## Acknowledgements

This plugin would not exist without the work of the [**WindsurfAPI**](https://github.com/dwgx/WindsurfAPI) project by **[@dwgx](https://github.com/dwgx)** and contributors. WindsurfAPI does all the genuinely hard work — reverse-engineering the Windsurf Cascade gRPC protocol, supervising the local Language Server, normalising tool-call dialects across model families, managing the multi-account pool, exposing the dashboard, and sanitising Cascade fingerprints from upstream responses.

This plugin is purely the OpenCode-side adapter: it speaks HTTP to a WindsurfAPI proxy, picks the right endpoint per model, and threads OpenCode's auth flow through to the proxy's `/auth/login`. All credit for the heavy lifting belongs upstream — please star [`dwgx/WindsurfAPI`](https://github.com/dwgx/WindsurfAPI) if you find this useful.

It also stands on the shoulders of:

- **[OpenCode](https://opencode.ai/)** — the terminal coding agent and plugin host this targets.
- **[`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)** — the Vercel AI SDK provider whose `fetch` hook gives us a clean per-request interception point.
- **[`numman-ali/opencode-openai-codex-auth`](https://github.com/numman-ali/opencode-openai-codex-auth)** — reference implementation for OpenCode auth-plugin patterns (loader shape, request/response interception, OAuth flow handling).

## License

MIT — see [`LICENSE`](./LICENSE).

Depends on [WindsurfAPI](https://github.com/dwgx/WindsurfAPI) (MIT), which is **not bundled** and runs as a separate process.
