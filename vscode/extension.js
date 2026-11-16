// local-ai-jay for VS Code: a chat sidebar in front of the local-ai-jay gateway.
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const { Gateway } = require('./lib/gateway');

const CHATS_KEY = 'localAiJay.chats';
const CURRENT_KEY = 'localAiJay.current';
const MODEL_KEY = 'localAiJay.model';
const MAX_CONTEXT_CHARS = 60000;

const config = () => vscode.workspace.getConfiguration('localAiJay');

class ChatViewProvider {
  constructor(context, gateway) {
    this.context = context;
    this.gateway = gateway;
    this.view = null;
    this.ready = false;
    this.queue = [];
    this.running = new Map(); // reply id -> AbortController
    this.lastEditor = vscode.window.activeTextEditor || null;
    this.warnedWorkdir = false;

    const track = (ed) => { if (ed && ed.document.uri.scheme !== 'output') { this.lastEditor = ed; this.postContext(); } };
    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(track),
      vscode.window.onDidChangeTextEditorSelection((e) => track(e.textEditor)),
      vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('localAiJay')) this.refresh(); }),
    );
  }

  resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidDispose(() => { this.view = null; this.ready = false; });
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${uri('chat.css')}">
  <title>local-ai-jay</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
  }

  post(msg) {
    if (this.view && this.ready) this.view.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  async reveal() {
    await vscode.commands.executeCommand('localAiJay.chat.focus');
  }

  editorContext() {
    const ed = this.lastEditor;
    if (!ed || ed.document.isClosed) return null;
    const doc = ed.document;
    const sel = ed.selection;
    const name = vscode.workspace.asRelativePath(doc.uri, false);
    const short = name.split(/[\\/]/).pop();
    if (sel && !sel.isEmpty) {
      const a = sel.start.line + 1;
      const b = sel.end.line + (sel.end.character === 0 && sel.end.line > sel.start.line ? 0 : 1);
      return { file: name, short, lines: a === b ? `${a}` : `${a}-${b}`, hasSelection: true };
    }
    return { file: name, short, lines: null, hasSelection: false };
  }

  postContext() {
    if (!this.view) return;
    clearTimeout(this.ctxTimer);
    this.ctxTimer = setTimeout(() => this.post({ type: 'context', context: this.editorContext() }), 120);
  }

  /** Builds the text that goes to the model for the current selection (or whole file). */
  contextBlock() {
    const ed = this.lastEditor;
    if (!ed || ed.document.isClosed) return null;
    const doc = ed.document;
    const info = this.editorContext();
    let text = info.hasSelection ? doc.getText(ed.selection) : doc.getText();
    let note = '';
    if (text.length > MAX_CONTEXT_CHARS) { text = text.slice(0, MAX_CONTEXT_CHARS); note = '\n(Truncated: the file is longer than this.)'; }
    const where = info.hasSelection ? `${info.file}, lines ${info.lines}` : info.file;
    const fence = text.includes('```') ? '~~~~' : '```';
    return { label: info.hasSelection ? `${info.short}:${info.lines}` : info.short, text: `From \`${where}\`:\n\n${fence}${doc.languageId}\n${text}\n${fence}${note}\n\n` };
  }

  async refresh() {
    const status = await this.gateway.connect();
    let models = [];
    if (status.ok) {
      try { models = await this.gateway.models(); } catch (err) { status.modelsError = err.message; }
    }
    this.post({ type: 'status', status, models: models.map((m) => ({ id: m.id, owner: m.owned_by })) });
    return status;
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': {
        this.ready = true;
        const state = this.context.globalState;
        this.view.webview.postMessage({
          type: 'init',
          chats: state.get(CHATS_KEY, []),
          currentId: state.get(CURRENT_KEY, null),
          model: state.get(MODEL_KEY, 'auto'),
          context: this.editorContext(),
        });
        for (const q of this.queue.splice(0)) this.view.webview.postMessage(q);
        await this.refresh();
        break;
      }
      case 'refresh': await this.refresh(); break;
      case 'send': await this.send(m); break;
      case 'stop': this.running.get(m.id)?.abort(); break;
      case 'saveChats':
        await this.context.globalState.update(CHATS_KEY, m.chats);
        await this.context.globalState.update(CURRENT_KEY, m.currentId);
        break;
      case 'setModel': await this.context.globalState.update(MODEL_KEY, m.model); break;
      case 'copy': await vscode.env.clipboard.writeText(m.text); vscode.window.setStatusBarMessage('$(check) Copied', 1500); break;
      case 'insert': await this.insert(m.code); break;
      case 'startGateway': await vscode.commands.executeCommand('localAiJay.startGateway'); break;
      case 'openConsole': await vscode.commands.executeCommand('localAiJay.openConsole', m.tab); break;
      case 'openSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'localAiJay'); break;
      default: break;
    }
  }

  async insert(code) {
    const ed = this.lastEditor;
    if (ed && !ed.document.isClosed) {
      await vscode.window.showTextDocument(ed.document, ed.viewColumn);
      await ed.edit((b) => { for (const s of ed.selections) b.replace(s, code); });
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: code });
    await vscode.window.showTextDocument(doc);
  }

  async send({ id, model, messages, attach }) {
    // The last message is the new question; prepend the editor context to it if asked.
    const last = messages[messages.length - 1];
    let attachment = null;
    if (attach && last?.role === 'user') {
      const ctx = this.contextBlock();
      if (ctx) {
        last.content = ctx.text + last.content;
        attachment = ctx.label;
        this.post({ type: 'userContent', id, content: last.content, attachment });
      }
    }
    const system = (config().get('systemPrompt') || '').trim();
    const payload = system ? [{ role: 'system', content: system }, ...messages] : messages;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let workdir = config().get('useWorkspaceFolder') && folder ? folder : undefined;

    if (!this.gateway.base) {
      const st = await this.refresh();
      if (!st.ok) { this.post({ type: 'error', id, message: st.message, reason: st.reason }); return; }
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          for await (const piece of this.gateway.chat({ model, messages: payload, workdir, signal: controller.signal })) {
            this.post({ type: 'delta', id, ...piece });
          }
          break;
        } catch (err) {
          if (err.code === 'workdir_not_allowed' && workdir) {
            workdir = undefined;
            if (!this.warnedWorkdir) {
              this.warnedWorkdir = true;
              this.post({ type: 'notice', text: `Your tools can't read this project yet, so they answer from the chat only. To let them, restart local-ai-jay with: npx local-ai-jay --allow "${folder}"` });
            }
            continue;
          }
          throw err;
        }
      }
      this.post({ type: 'done', id });
    } catch (err) {
      if (err.name === 'AbortError') this.post({ type: 'done', id, stopped: true });
      else {
        if (err.cause?.code === 'ECONNREFUSED' || err.message === 'fetch failed') { this.gateway.base = null; this.refresh(); }
        this.post({ type: 'error', id, message: err.message === 'fetch failed' ? 'Lost the connection to local-ai-jay.' : err.message });
      }
    } finally {
      this.running.delete(id);
    }
  }
}

function activate(context) {
  const gateway = new Gateway(() => ({ url: config().get('url'), apiKey: config().get('apiKey'), home: config().get('home') }));
  const provider = new ChatViewProvider(context, gateway);
  let terminal = null;

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('localAiJay.chat', provider, {
    webviewOptions: { retainContextWhenHidden: true },
  }));

  cmd('localAiJay.focus', () => provider.reveal());
  cmd('localAiJay.newChat', async () => { await provider.reveal(); provider.post({ type: 'newChat' }); });
  cmd('localAiJay.askSelection', async () => { await provider.reveal(); provider.post({ type: 'prefill', text: '', attach: true }); });
  cmd('localAiJay.explainSelection', async () => {
    await provider.reveal();
    provider.post({ type: 'prefill', text: 'Explain what this code does, step by step.', attach: true, send: true });
  });
  cmd('localAiJay.fixSelection', async () => {
    await provider.reveal();
    provider.post({ type: 'prefill', text: 'Find bugs or problems in this code and show a fixed version.', attach: true, send: true });
  });
  cmd('localAiJay.openConsole', async (tab) => {
    if (!gateway.base) await provider.refresh();
    const url = gateway.consoleUrl(typeof tab === 'string' ? tab : undefined);
    if (!url) { vscode.window.showWarningMessage('local-ai-jay isn\'t running.', 'Start it').then((a) => a && vscode.commands.executeCommand('localAiJay.startGateway')); return; }
    vscode.env.openExternal(vscode.Uri.parse(url));
  });
  cmd('localAiJay.startGateway', async () => {
    if (!terminal || terminal.exitStatus) {
      terminal = vscode.window.createTerminal({ name: 'local-ai-jay', env: { LOCAL_AI_JAY_NO_OPEN: '1' }, iconPath: new vscode.ThemeIcon('sparkle') });
    }
    terminal.show(true);
    terminal.sendText(config().get('startCommand') || 'npx -y local-ai-jay');
    provider.post({ type: 'starting' });
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await gateway.connect();
      if (st.ok) { await provider.refresh(); return; }
    }
    await provider.refresh();
  });
  context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => { if (t === terminal) terminal = null; }));
}

function deactivate() {}

module.exports = { activate, deactivate };
