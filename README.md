# local-ai-jay

**One local, OpenAI-compatible API and console in front of your own AI tools:** Claude Code, Codex,
Gemini CLI, Ollama, LM Studio, and (optionally) your Groq, Cerebras, Google AI Studio, OpenRouter,
Mistral, DeepSeek and OpenAI keys.

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
| Ollama | `http://127.0.0.1:11434` (or `$OLLAMA_HOST`) | `ollama/<model>`, e.g. `ollama/llama3.2` |
| LM Studio | `http://127.0.0.1:1234` (or `$LMSTUDIO_BASE_URL`) | `lmstudio/<model>` |
| Groq, Cerebras, Google AI Studio, OpenRouter, Mistral, DeepSeek, OpenAI | your API key | `groq/llama-3.3-70b-versatile`, `openrouter/<vendor>/<model>`, … |

`GET /v1/models` lists everything that's ready right now.

## The console

`http://127.0.0.1:3000` has four pages:

- **Playground:** chat with any model, with streaming, a system prompt, the model's thinking, timing and token counts.
- **Providers:** what's installed and ready; **Test** (sends one tiny chat), **Pause/Resume**, and
  **API keys** for cloud providers (checked with the provider before saving, shown only masked, can be switched off or removed).
- **Usage:** requests, errors, tokens and time per provider and per day, plus a live list of recent requests.
- **Connect:** base URL, key, and ready-to-copy snippets for curl, Python, Node and env vars.

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
  mode, Codex in its `read-only` sandbox, Gemini CLI in `default` approval mode). `--allow <dir>`
  adds folders; `--allow-edits` lets them change files there. A request can choose its working
  folder with a `workdir` field (or `X-Workdir` header), which must be inside an allowed folder.
- **Usage counts against your own plans.** Nothing runs by itself; the Test button sends one tiny
  chat only when you press it.
- **Chat history goes to CLIs as one prompt.** CLIs take a single prompt, so earlier turns and system
  messages are folded into it. Images are dropped for CLIs; use an API provider for vision.
- **No website automation.** local-ai-jay doesn't drive ChatGPT/Grok/etc. in a browser: that breaks
  those sites' terms and gets accounts banned. It only uses official CLIs and APIs.

## Security

- Listens on `127.0.0.1` only. No other computer can reach it.
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
`NAME=value` lines (like `GROQ_API_KEY=…`) in `~/.local-ai-jay/env`. To remove everything, delete the folder.

Custom CLI locations: `LOCAL_AI_JAY_CLAUDE_BIN`, `LOCAL_AI_JAY_CODEX_BIN`, `LOCAL_AI_JAY_GEMINI_BIN`.

## Troubleshooting

- **A CLI shows "Not installed":** it isn't on your `PATH` in this terminal. Open a new terminal
  after installing it, or set `LOCAL_AI_JAY_<NAME>_BIN`.
- **A CLI is "Ready" but Test fails:** the error shown is the CLI's own, usually that it needs signing
  in. Run the CLI once in your terminal, sign in, and press Test again.
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
