# local-ai-jay

**One local, OpenAI-compatible API and console in front of your own AI tools:** Claude Code, Codex,
Gemini CLI, Antigravity, Ollama, LM Studio, and (optionally) your Groq, Cerebras, Google AI Studio, OpenRouter,
Mistral, DeepSeek, SEA-LION and OpenAI keys.

```bash
npx local-ai-jay
```

That's it. No Python, no setup step, no dependencies: it starts in about a second, opens the console
in your browser (already signed in), and gives you an API at `http://127.0.0.1:3000/v1` that any
OpenAI client can use. Press Ctrl+C to stop.

## Why

- **Use what you already pay for.** Your Claude Code or ChatGPT/Codex subscription, your local
  Ollama models, your free Groq key: one endpoint for all of them.
- **Drop-in OpenAI API.** Point the OpenAI SDK, LangChain, LiteLLM, Open WebUI, Cursor, Continue,
  `curl` and so on at it. Streaming, usage numbers and `reasoning_content` (the model's thinking) all work.
- **Full pass-through for API providers.** Requests to Ollama, LM Studio and cloud keys go straight
  through, so tools/function calling, JSON mode and images work exactly as the provider supports them.
- **`auto` model with fallback.** Ask for `auto` and it uses the first ready provider; if one fails
  before answering, it moves on to the next.
- **Pure Node, zero dependencies.** Node 20+ on macOS, Linux or Windows. Nothing else to install.

## What you need

- **Node 20+**
- The tools you want to use, installed and signed in the way their makers describe. local-ai-jay
  finds them on your `PATH` and never installs anything or logs you in. Run
  `npx local-ai-jay doctor` to see what it found.

| Provider | How it's used | Model names |
|---|---|---|
| Claude Code | `claude -p` headless, as you | `claude-code`, `claude-code/sonnet`, `/opus`, `/haiku`, or any full model id |
| Codex | `codex exec` headless, as you | `codex`, `codex/<model>` |
| Gemini CLI | `gemini -p` headless, as you | `gemini-cli`, `gemini-cli/pro`, `/flash` |
| Antigravity | `agy` headless (stream-json over stdin), as you | `antigravity`, `antigravity/<model>` (listed live from `agy models`, e.g. `antigravity/claude-sonnet-4-6`) |
| Ollama | `http://127.0.0.1:11434` (or `$OLLAMA_HOST`) | `ollama/<model>`, e.g. `ollama/llama3.2` |
| LM Studio | `http://127.0.0.1:1234` (or `$LMSTUDIO_BASE_URL`) | `lmstudio/<model>` |
| Groq, Cerebras, Google AI Studio, OpenRouter, Mistral, DeepSeek, SEA-LION, OpenAI | your API key(s) | `groq/llama-3.3-70b-versatile`, `openrouter/<vendor>/<model>`, … |
| Gemini website *(opt-in, see below)* | gemini.google.com in a real browser | `gemini-web` |

`GET /v1/models` lists everything that's ready right now.

## Website providers (opt-in)

With `--web`, local-ai-jay can also use **the Gemini website** in a real Chrome/Edge/Brave/Chromium
window: it opens a new chat, types your prompt, and reads the answer back as Markdown while it's
written. It works signed out (Gemini's free model) or signed in to your Google account.

```bash
npx local-ai-jay web-signin      # optional, once: sign in to Google in its own browser profile
npx local-ai-jay --web           # turn it on (remembered); --no-web turns it off
npx local-ai-jay --web-headless  # no window (for servers); --web-window shows it again
npx local-ai-jay ask -m gemini-web "Explain DNS like I'm five"
```

> **Read this first.** Websites aren't APIs, and their terms don't allow automated use, so **your
> account could be limited or banned**. Use an account you can afford to lose and keep it to
> personal use. local-ai-jay doesn't hide that it's automated and never solves CAPTCHAs or sign-in
> checks: if a site asks, run `web-signin` and do it yourself. Requests run one at a time, `auto`
> never picks a website unless you add it to `autoOrder` in `config.json`, and the browser uses its
> own profile in `~/.local-ai-jay/browser-profile`, separate from your everyday browser.
> Needs Node 22+.

## Tool calling (agents, VS Code Agent mode)

Send OpenAI `tools` and every model can call them, including the CLIs and websites, which have no
tool API of their own. API providers (SEA-LION, Groq, OpenAI, …) get the tools natively. For
Antigravity, Claude Code, Codex and the Gemini website, local-ai-jay describes the tools in the
prompt, the model answers with `<tool_call>{"name": …, "arguments": …}</tool_call>` blocks, and the
client receives standard `tool_calls` with `finish_reason: "tool_calls"`, streamed or not. Tool
results and earlier calls in the history are passed back the same way. While a client's tools are
in play, Antigravity runs as a dedicated agent (`~/.gemini/config/agents/local-ai-jay-tools.md`)
with its own file, command, MCP and web tools blocked, because those would act on the server
machine, not on the client's.

## The console

`http://127.0.0.1:3000` opens a chat app with a sidebar:

- **Chats:** chat with any model, with streaming, Markdown and code blocks, the model's thinking,
  timing and token counts, a per-chat system prompt, and copy, edit and retry. Your chats are kept
  in **Recents**, saved only in that browser.
- **Providers:** what's installed and ready; **Test** (sends one tiny chat), **Pause/Resume**, and
  **API keys** for cloud providers: paste one or several (one per line). Each is checked with the
  provider before saving and only ever shown masked. Several keys take turns, and a key that hits
  its rate limit rests while the next one answers. Each key can be switched off or removed.
- **Usage:** requests, errors, tokens and time per provider and per day, plus a live list of recent requests.
- **Connect:** base URL, key, and ready-to-copy snippets for curl, Python, Node and env vars.

## VS Code extension

The [`vscode/`](vscode/) folder has a VS Code extension with the same chat in the sidebar. It finds the
gateway on this computer by itself, can start it in a terminal, sends your selection or current file with a
question, and puts code from replies straight into the editor. See [vscode/README.md](vscode/README.md).

## Use it from your other devices (Tailscale)

Run it on an always-on computer and reach it from your phone or laptop over
[Tailscale](https://tailscale.com), a private network only your devices can join:

```bash
npx local-ai-jay --host 100.x.y.z    # that computer's Tailscale address (tailscale ip -4); remembered
```

It keeps listening on `127.0.0.1` and also listens on that address, so any device signed in to your
Tailscale can open `http://100.x.y.z:3000/#key=…` (the full link is printed at start) or use
`http://100.x.y.z:3000/v1` as an OpenAI base URL. Tailscale encrypts the traffic. If Tailscale
isn't up yet after a reboot, it keeps retrying. `--allow-host <name>` also accepts a MagicDNS
name, and `--local-only` goes back to this computer only. `--host 0.0.0.0` is refused on purpose:
never put the gateway on the open internet.

## Use it from code

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="jay-…")  # `npx local-ai-jay key`
reply = client.chat.completions.create(
    model="claude-code/sonnet",
    messages=[{"role": "user", "content": "Explain closures in one paragraph"}],
)
print(reply.choices[0].message.content)
```

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Hi"}]}'
```

Or skip the server and ask from the terminal:

```bash
npx local-ai-jay ask "What does this error mean?" < error.log
npx local-ai-jay ask -m codex "Write a haiku about TCP"
```

## Commands

```bash
npx local-ai-jay                     # start (default)
npx local-ai-jay --port 8080         # pick a port (default 3000; if taken, the next free one)
npx local-ai-jay --allow ~/code      # let the CLIs read ~/code too (remembered)
npx local-ai-jay --allow-edits       # let the CLIs edit files in allowed folders (remembered)
npx local-ai-jay --read-only         # back to read-only (the default)
npx local-ai-jay --cors              # let browser apps on other sites call /v1 (remembered)
npx local-ai-jay key                 # show the console link and API key
npx local-ai-jay rotate-key          # make a new API key
npx local-ai-jay doctor              # what's installed and ready
npx local-ai-jay models              # every model you can use right now
npx local-ai-jay ask "<prompt>"      # one answer in the terminal, no server
```

## Things to know

- **The CLIs only see the folders you allow.** By default that's an empty folder,
  `~/.local-ai-jay/workspace`, and they run **read-only** (Claude Code in its default permission
  mode, Codex in its `read-only` sandbox, Gemini CLI in `default` approval mode, Antigravity with
  session-only deny rules for writing files, running commands and MCP tools, which override an
  "always proceed" setting of your own). `--allow <dir>`
  adds folders; `--allow-edits` lets them change files there. A request can choose its working
  folder with a `workdir` field (or `X-Workdir` header), which must be inside an allowed folder.
- **Usage counts against your own plans.** Nothing runs by itself; the Test button sends one tiny
  chat only when you press it.
- **Chat history goes to CLIs as one prompt.** CLIs take a single prompt, so earlier turns and system
  messages are folded into it. Images are dropped for CLIs; use an API provider for vision.
- **Website automation is off by default.** Only `--web` turns it on, with the warning above.

## Security

- Listens on `127.0.0.1` only, unless you add a private address with `--host`.
- Every `/v1` and `/api` call needs the API key (`Authorization: Bearer …` or `x-api-key`), compared
  in constant time. The key is made on first run and stored with owner-only permissions.
- Requests whose `Host` isn't `localhost`/`127.0.0.1` are refused, which blocks DNS-rebinding attacks
  from web pages. CORS is off unless you pass `--cors`.
- CLIs are started without a shell, and prompts go over stdin, never as command-line arguments.
  Model names are checked so they can't inject flags.
- The console uses a strict Content-Security-Policy and never displays provider keys after saving.

## Where things are

Everything lives in `~/.local-ai-jay` (or `$LOCAL_AI_JAY_HOME`): `config.json` (your key and settings),
`state/state.json` (pauses, provider keys, usage), `logs/requests.log`, `workspace/`. You can also put
`NAME=value` lines (like `GROQ_API_KEY=…`, or several keys comma-separated) in `~/.local-ai-jay/env`. To remove everything, delete the folder.

Custom CLI locations: `LOCAL_AI_JAY_CLAUDE_BIN`, `LOCAL_AI_JAY_CODEX_BIN`, `LOCAL_AI_JAY_GEMINI_BIN`,
`LOCAL_AI_JAY_ANTIGRAVITY_BIN`.

## Troubleshooting

- **A CLI shows "Not installed":** it isn't on your `PATH` in this terminal. Open a new terminal
  after installing it, or set `LOCAL_AI_JAY_<NAME>_BIN`.
- **A CLI is "Ready" but Test fails:** the error shown is the CLI's own, usually that it needs signing
  in. Run the CLI once in your terminal, sign in, and press Test again.
- **Antigravity is slow to start:** `agy` itself takes roughly 15–35 seconds to start each run
  (loading its plugins and MCP servers) before it answers. Fewer plugins in Antigravity means faster replies.
- **Gemini website "didn't answer":** you may have hit its free limit, or it wants a sign-in. Run
  `npx local-ai-jay web-signin` (with the gateway stopped), sign in, close the window, start again.
  Custom browser: `LOCAL_AI_JAY_BROWSER=/path/to/chrome`.
- **Ollama / LM Studio "Not running":** start the app (and for LM Studio, start its local server).
- Logs: `~/.local-ai-jay/logs/requests.log`.

## Use it as a library

```js
import { createGateway, createRegistry, listen, loadConfig, getPaths, Store } from 'local-ai-jay';

const paths = getPaths();
const { config } = loadConfig(paths);
const store = new Store(paths.state);
const gateway = createGateway({ config, store, registry: createRegistry({ store }), paths });
const { port } = await listen(gateway.handler, { port: 3000 });
```

## License

MIT
