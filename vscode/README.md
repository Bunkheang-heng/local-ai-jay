# local-ai-jay for VS Code

Chat with your own AI tools from the VS Code sidebar: **Claude Code, Codex, Gemini CLI, Antigravity,
Ollama, LM Studio** and your cloud API keys, all through [local-ai-jay](https://github.com/Bunkheang-heng/local-ai-jay).

## Features

- **Chat in the sidebar.** Click the ◆ icon in the Activity Bar (or press `Cmd+Alt+J` / `Ctrl+Alt+J`).
  Replies stream in with Markdown, code blocks and the model's thinking.
- **Ask about your code.** Select code and the chip above the message box (`cart.js:12-18`) sends it
  with your question. Click the chip to include or leave out the file. Right-click a selection for
  **local-ai-jay → Ask / Explain / Find Problems**, or press `Cmd+Alt+K` / `Ctrl+Alt+K`.
- **Code straight into the editor.** Every code block has **Insert** (replaces your selection or
  inserts at the cursor) and **Copy**.
- **Any model you have.** Pick `auto` (the first ready tool, with fallback) or a specific model from
  the picker in the message box.
- **Chat history.** Your chats are kept in VS Code; open them from the history button.
- **Works with your project.** CLI tools like Claude Code run inside your workspace folder so they
  can read your files, once you allow it (see below).

## Getting started

1. Install [Node 20+](https://nodejs.org) and at least one tool (for example Claude Code, signed in).
2. Open the local-ai-jay sidebar. If the gateway isn't running, click **Start local-ai-jay**. It runs
   `npx -y local-ai-jay` in a terminal and connects as soon as it's up.

There's nothing to configure: the extension reads the key from `~/.local-ai-jay/config.json` and
finds the port by itself.

### Let tools read your project

By default the gateway only lets CLI tools work in its own folder. To let them read the project
you have open, start it once with that folder allowed (it's remembered):

```bash
npx local-ai-jay --allow /path/to/your/project
```

Until then, chats still work; the tools just answer from what's in the chat.

## Settings

| Setting | What it does |
|---|---|
| `localAiJay.url` | Gateway address. Empty: find it on this computer. |
| `localAiJay.apiKey` | Gateway key. Empty: read it from `~/.local-ai-jay/config.json`. |
| `localAiJay.home` | The local-ai-jay data folder, if you moved it. |
| `localAiJay.useWorkspaceFolder` | Run CLI tools inside the open workspace folder (default on). |
| `localAiJay.systemPrompt` | Instructions sent at the start of every chat. |
| `localAiJay.startCommand` | What **Start local-ai-jay** runs (default `npx -y local-ai-jay`). |

## Privacy

The extension talks only to your local-ai-jay gateway. Your key stays in the extension; the chat panel
never sees it. Chats are stored in VS Code's own storage on this computer.

## Develop

Open the repository in VS Code and press **F5** ("Run VS Code extension"). To build a `.vsix`:

```bash
cd vscode
npm run package          # runs npx @vscode/vsce package
code --install-extension local-ai-jay-0.1.0.vsix
```

`media/markdown.js` is a copy of `public/markdown.js` (`npm run sync` updates it; a test checks they match).
