import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getPaths } from './paths.js';
import { loadConfig, saveConfig, addAllowedDir, removeAllowedDir, loadEnvFile, newApiKey } from './config.js';
import { Store } from './store.js';
import { createRegistry, parseModel } from './providers/index.js';
import { createGateway, listen, listenExtra } from './server.js';
import net from 'node:net';
import { pickParams } from './providers/openai-compat.js';
import { Browser } from './web/browser.js';
import { WEB_SITES } from './web/provider.js';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c('1'), dim = c('2'), green = c('32'), yellow = c('33'), red = c('31'), cyan = c('36');

const HELP = `
${bold('local-ai-jay')} ${dim(`v${pkg.version}`)}
One local, OpenAI-compatible API + console in front of your own AI tools.

${bold('Usage')}
  npx local-ai-jay [command] [options]

${bold('Commands')}
  start                 Start the gateway and open the console (default)
  key                   Show the console link and API key
  rotate-key            Make a new API key (the old one stops working)
  doctor                Check which providers are ready
  models                List the models you can use right now
  ask "<prompt>"        Ask once from the terminal, no server needed (reads stdin if no prompt)
  web-signin            Open the website providers' browser window to sign in (stop the gateway first)

${bold('Options')}
  -p, --port <n>        Port to listen on (default 3000; next free one if taken)
      --allow <dir>     Let the CLIs work in <dir> too (remembered; repeatable)
      --disallow <dir>  Forget an allowed folder
      --allow-edits     Let the CLIs edit files in allowed folders (remembered)
      --read-only       Back to read-only (the default; remembered)
      --host <ip>       Also listen on <ip>, e.g. your Tailscale address (remembered; repeatable)
      --allow-host <n>  Also accept requests addressed to name <n>, e.g. a MagicDNS name (remembered)
      --local-only      Forget --host/--allow-host: this computer only again
      --cors            Allow browser apps on other origins to call /v1 (remembered)
      --no-cors         Turn that off again
      --no-open         Don't open the browser
      --web             Turn on website providers (Gemini website in a real browser; remembered)
      --no-web          Turn them off again
      --web-headless    Run that browser without a window (remembered); --web-window to show it
  -m, --model <name>    Model for \`ask\` (default: auto)
  -h, --help            Show this help
  -v, --version         Show the version

${bold('Examples')}
  npx local-ai-jay
  npx local-ai-jay --allow ~/code --allow-edits
  npx local-ai-jay ask -m claude-code/sonnet "Explain this error" < error.log
`;

function openBrowser(url) {
  if (process.env.CI || process.env.LOCAL_AI_JAY_NO_OPEN) return;
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  let cmd;
  let args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', `"${url}"`]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch { /* no browser; the link is printed */ }
}

function setup() {
  const paths = getPaths();
  const { config, firstRun } = loadConfig(paths);
  loadEnvFile(paths.env);
  const store = new Store(paths.state);
  let browser = null;
  const getBrowser = () => (browser ||= new Browser({ profileDir: path.join(paths.home, 'browser-profile'), headless: !!config.web.headless }));
  const registry = createRegistry({ store, config, getBrowser });
  return { paths, config, firstRun, store, registry, getBrowser, hasBrowser: () => !!browser };
}

const STATE_LABEL = {
  ready: green('ready'),
  not_installed: dim('not installed'),
  no_key: dim('no key'),
  offline: dim('not running'),
  no_models: yellow('no models'),
  paused: yellow('paused'),
  off: dim('off'),
  error: red('error'),
};

async function printProviders(registry, store) {
  const rows = await Promise.all(registry.list().map(async (p) => {
    let st;
    try { st = await p.status(); } catch (err) { st = { available: false, state: 'error', detail: err.message }; }
    return { p, st, paused: store.isPaused(p.id) };
  }));
  for (const { p, st, paused } of rows) {
    const label = paused ? STATE_LABEL.paused : STATE_LABEL[st.state] || st.state;
    console.log(`  ${p.label.padEnd(17)} ${label.padEnd(tty ? 24 : 15)} ${dim(st.detail || '')}`);
  }
  return rows;
}

function consoleUrl(port, key) {
  return `http://127.0.0.1:${port}/#key=${key}`;
}

async function cmdStart(values) {
  const { paths, config, firstRun, store, registry, getBrowser, hasBrowser } = setup();
  let changed = false;
  for (const d of values.allow || []) { const real = addAllowedDir(config, d); console.log(`${green('✓')} Allowed ${real}`); changed = true; }
  for (const d of values.disallow || []) { if (removeAllowedDir(config, d)) { console.log(`${green('✓')} Removed ${d}`); changed = true; } }
  if (values['allow-edits']) { config.cliAccess = 'edit'; changed = true; }
  if (values['read-only']) { config.cliAccess = 'read-only'; changed = true; }
  if (values.cors) { config.cors = true; changed = true; }
  if (values['no-cors']) { config.cors = false; changed = true; }
  for (const h of values.host || []) {
    const ip = h.replace(/^\[|\]$/g, '');
    if (!net.isIP(ip)) throw new Error(`--host needs an IP address, got "${h}"`);
    if (['0.0.0.0', '::'].includes(ip)) {
      throw new Error('--host 0.0.0.0 would open the gateway to every network this computer is on. Use your Tailscale address (tailscale ip -4) instead.');
    }
    if (!config.hosts.includes(ip)) config.hosts.push(ip);
    changed = true;
  }
  for (const n of values['allow-host'] || []) {
    const name = n.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(name)) throw new Error(`--allow-host needs a host name, got "${n}"`);
    if (!config.allowedHosts.includes(name)) config.allowedHosts.push(name);
    changed = true;
  }
  if (values['local-only']) { config.hosts = []; config.allowedHosts = []; changed = true; }
  if (values.web && !config.web.enabled) { printWebWarning(); config.web.enabled = true; changed = true; }
  if (values['no-web']) { config.web.enabled = false; changed = true; }
  if (values['web-headless']) { config.web.headless = true; changed = true; }
  if (values['web-window']) { config.web.headless = false; changed = true; }
  const explicitPort = values.port !== undefined;
  if (explicitPort) {
    const n = Number(values.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port: ${values.port}`);
    config.port = n;
    changed = true;
  }
  if (changed) saveConfig(paths, config);

  const logFile = path.join(paths.logs, 'requests.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  const log = (e) => {
    logStream.write(`${JSON.stringify(e)}\n`);
    const time = new Date(e.at).toLocaleTimeString();
    const status = e.ok ? green(e.status) : red(e.status);
    const tokens = e.ok ? dim(`${e.inputTokens || 0} in / ${e.outputTokens || 0} out`) : red(String(e.error || '').slice(0, 120));
    console.log(`  ${dim(time)}  ${status}  ${e.model.padEnd(32)} ${(e.ms / 1000).toFixed(1).padStart(6)}s  ${tokens}${e.test ? dim('  (test)') : ''}`);
  };

  const gateway = createGateway({ config, store, registry, paths, version: pkg.version, log });
  // When other devices connect (--host), the port must stay put: never drift to the next free one.
  const { server, port } = await listen(gateway.handler, { port: config.port, tryNext: !explicitPort && !config.hosts.length })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') throw new Error(`Port ${config.port} is already in use by another program. Pick another with --port <n>.`);
      throw err;
    });
  const url = consoleUrl(port, config.apiKey);
  const extra = listenExtra(gateway.handler, {
    port,
    hosts: config.hosts,
    log: (host, err) => console.log(err
      ? `  ${yellow(`Can't listen on ${host}:${port} yet (${err.code || err.message}); retrying every 10s.`)}`
      : `  ${green('✓')} Also listening on ${cyan(`http://${host.includes(':') ? `[${host}]` : host}:${port}`)}`),
  });

  console.log('');
  console.log(`  ${bold('local-ai-jay')} ${dim(`v${pkg.version}`)}${firstRun ? dim('  (first run: made your API key)') : ''}`);
  console.log('');
  console.log(`  Console   ${cyan(url)}`);
  console.log(`  API       ${cyan(`http://127.0.0.1:${port}/v1`)}  ${dim('(OpenAI-compatible)')}`);
  for (const h of config.hosts) {
    const shown = h.includes(':') ? `[${h}]` : h;
    console.log(`  Remote    ${cyan(`http://${shown}:${port}/#key=${config.apiKey}`)}  ${dim('(other devices on that network)')}`);
  }
  if (config.hosts.length) {
    console.log(`  ${yellow('Reachable from other devices on')} ${config.hosts.join(', ')}. ${dim('Use a private network like Tailscale only.')}`);
  }
  console.log(`  API key   ${config.apiKey}`);
  console.log(`  CLIs      ${config.cliAccess === 'edit' ? yellow('can edit files') : 'read-only'} in ${[paths.workspace, ...config.allowedDirs].join(', ')}`);
  if (port !== config.port) console.log(`  ${yellow(`Port ${config.port} was busy, using ${port}.`)}`);
  console.log('');
  await printProviders(registry, store);
  console.log('');
  console.log(dim('  Requests show up below. Press Ctrl+C to stop.'));
  console.log('');

  if (!values['no-open']) openBrowser(url);

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(dim('\n  Stopping…'));
    store.saveNow();
    logStream.end();
    if (hasBrowser()) getBrowser().close().catch(() => {});
    for (const s of extra) s.close();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function printWebWarning() {
  console.log(`
  ${yellow(bold('Website providers'))}
  local-ai-jay will type your prompts into websites (Gemini) in its own browser window and read the
  answers back. Those sites' terms don't allow automated use, so ${bold('your account could be limited')}
  ${bold('or banned')}. Use an account you can afford to lose, and keep it to personal use. It never solves
  CAPTCHAs or sign-in checks for you: if a site asks, run \`npx local-ai-jay web-signin\`.
  Turn it off any time with --no-web.
`);
}

async function cmdWebSignin() {
  const { getBrowser } = setup();
  const browser = getBrowser();
  if (await browser.close()) console.log(dim('  Closed the gateway\'s browser window first.'));
  console.log(`\n  Opening ${WEB_SITES.map((s) => s.url).join(', ')}`);
  console.log('  Sign in normally in that window, then close it. local-ai-jay will stay signed in.\n');
  await browser.openForSignIn(WEB_SITES.map((s) => s.url));
  console.log(`  ${green('✓')} Done. Start the gateway with --web.\n`);
}

async function cmdKey() {
  const { config } = setup();
  console.log(`\n  Console   ${cyan(consoleUrl(config.port, config.apiKey))}`);
  console.log(`  API key   ${config.apiKey}`);
  console.log(dim(`  (If the gateway picked another port because ${config.port} was busy, use that port instead.)\n`));
}

async function cmdRotateKey() {
  const { paths, config } = setup();
  config.apiKey = newApiKey();
  saveConfig(paths, config);
  console.log(`\n  ${green('✓')} New API key: ${config.apiKey}`);
  console.log(dim('  Restart the gateway for it to take effect.\n'));
}

async function cmdDoctor() {
  const { paths, config, store, registry } = setup();
  const major = Number(process.versions.node.split('.')[0]);
  console.log(`\n  ${bold('local-ai-jay doctor')}\n`);
  console.log(`  Node      ${major >= 20 ? green(process.version) : red(`${process.version} (needs 20+)`)}`);
  console.log(`  Home      ${paths.home}`);
  console.log(`  CLIs      ${config.cliAccess} in ${[paths.workspace, ...config.allowedDirs].join(', ')}\n`);
  const rows = await printProviders(registry, store);
  const ready = rows.filter((r) => r.st.available && !r.paused).length;
  console.log(`\n  ${ready ? green(`${ready} provider${ready === 1 ? '' : 's'} ready.`) : yellow('No providers ready yet: install a CLI, start Ollama, or add an API key.')}\n`);
}

async function cmdModels() {
  const { registry, store } = setup();
  for (const p of registry.list()) {
    if (store.isPaused(p.id)) continue;
    const st = await p.status().catch(() => ({ available: false }));
    if (!st.available) continue;
    for (const m of await p.models()) console.log(`${p.id}/${m}`);
  }
  console.log('auto');
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdAsk(values, rest) {
  const { paths, config, store, registry, getBrowser, hasBrowser } = setup();
  try {
    await askWith({ values, rest, paths, config, store, registry });
  } finally {
    if (hasBrowser()) await getBrowser().close().catch(() => {});
  }
}

async function askWith({ values, rest, paths, config, store, registry }) {
  const stdin = await readStdin();
  const prompt = [rest.join(' '), stdin].filter((s) => s.trim()).join('\n\n');
  if (!prompt.trim()) throw new Error('Nothing to ask. Usage: npx local-ai-jay ask "your question"');

  const target = parseModel(values.model);
  let candidates;
  if (target.auto) {
    candidates = [];
    for (const id of config.autoOrder) {
      const p = registry.get(id);
      if (!p || store.isPaused(id)) continue;
      const st = await p.status().catch(() => ({ available: false }));
      if (st.available) candidates.push({ p, model: null });
    }
    if (!candidates.length) throw new Error('No provider is ready. Run `npx local-ai-jay doctor`.');
  } else {
    const p = registry.get(target.providerId);
    if (!p) throw new Error(`Unknown provider "${target.providerId}". Run \`npx local-ai-jay models\`.`);
    candidates = [{ p, model: target.model }];
  }

  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  for (let i = 0; i < candidates.length; i++) {
    const { p, model } = candidates[i];
    let emitted = false;
    try {
      const events = p.chat({
        messages: [{ role: 'user', content: prompt }],
        model,
        signal: ac.signal,
        params: pickParams({}),
        settings: {
          workspace: paths.workspace,
          stateDir: paths.state,
          allowedDirs: config.allowedDirs,
          access: config.cliAccess,
          timeoutMs: (config.cliTimeoutSeconds || 600) * 1000,
          workdir: null,
        },
      });
      process.stderr.write(dim(`[${p.id}/${model || 'default'}]\n`));
      for await (const ev of events) {
        if (ev.type === 'text') { emitted = true; process.stdout.write(ev.text); }
      }
      process.stdout.write('\n');
      store.saveNow();
      return;
    } catch (err) {
      if (!emitted && i < candidates.length - 1) {
        process.stderr.write(yellow(`${p.label} failed (${err.message}); trying the next provider…\n`));
        continue;
      }
      throw err;
    }
  }
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: 'string', short: 'p' },
      allow: { type: 'string', multiple: true },
      disallow: { type: 'string', multiple: true },
      'allow-edits': { type: 'boolean' },
      'read-only': { type: 'boolean' },
      cors: { type: 'boolean' },
      host: { type: 'string', multiple: true },
      'allow-host': { type: 'string', multiple: true },
      'local-only': { type: 'boolean' },
      'no-cors': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      web: { type: 'boolean' },
      'no-web': { type: 'boolean' },
      'web-headless': { type: 'boolean' },
      'web-window': { type: 'boolean' },
      model: { type: 'string', short: 'm' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) { console.log(pkg.version); return; }
  const [command = 'start', ...rest] = positionals;
  if (values.help || command === 'help') { console.log(HELP); return; }

  switch (command) {
    case 'start': return cmdStart(values);
    case 'key': return cmdKey();
    case 'rotate-key': return cmdRotateKey();
    case 'doctor': return cmdDoctor();
    case 'models': return cmdModels();
    case 'ask': return cmdAsk(values, rest);
    case 'web-signin': return cmdWebSignin();
    default:
      throw new Error(`Unknown command "${command}". Run \`npx local-ai-jay --help\`.`);
  }
}
