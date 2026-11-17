import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolCallStream, toolifyMessages, toolInstructions, OPEN, CLOSE } from '../src/tools.js';
import { buildPrompt } from '../src/prompt.js';
import { createGateway, listen } from '../src/server.js';
import { registryFrom } from '../src/providers/index.js';
import { Store } from '../src/store.js';
import { getPaths } from '../src/paths.js';
import { loadConfig } from '../src/config.js';

const tools = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'run_in_terminal', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
];

test('ToolCallStream: text streams through, tool calls are pulled out even when split across chunks', () => {
  const p = new ToolCallStream(tools);
  const pieces = ['Let me look.\n<to', 'ol_call>{"name": "read_', 'file", "arguments": {"path": "a.js"}}</tool', '_call>\n', `${OPEN}{"name":"run_in_terminal","arguments":{"command":"ls"}}${CLOSE}`];
  let out = '';
  for (const piece of pieces) out += p.push(piece);
  const end = p.end();
  out += end.text;
  assert.equal(out.trim(), 'Let me look.');
  assert.equal(end.calls.length, 2);
  assert.equal(end.calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(end.calls[0].function.arguments), { path: 'a.js' });
  assert.equal(end.calls[1].function.name, 'run_in_terminal');
  assert.match(end.calls[0].id, /^call_[0-9a-f]+$/);
});

test('ToolCallStream: unknown tools and broken JSON stay as text; missing close tag still parses', () => {
  const p = new ToolCallStream(tools);
  let out = p.push(`${OPEN}{"name":"delete_everything","arguments":{}}${CLOSE} and ${OPEN}not json${CLOSE}`);
  out += p.end().text;
  assert.match(out, /delete_everything/);
  assert.match(out, /not json/);

  const q = new ToolCallStream(tools);
  q.push(`${OPEN}\`\`\`json\n{"name":"read_file","arguments":{"path":"x"},}\n\`\`\``);
  const end = q.end();
  assert.equal(end.calls.length, 1);
  assert.equal(end.text, '');
});

test('ToolCallStream: a lone "<" that never becomes a tag is not lost', () => {
  const p = new ToolCallStream(tools);
  const out = p.push('if (a <') + p.end().text;
  assert.equal(out, 'if (a <');
});

test('toolifyMessages: instructions first, tool calls and results written as text', () => {
  const msgs = toolifyMessages([
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'what is in a.js?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'console.log(1)' },
  ], { tools, toolChoice: 'auto' });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /## read_file/);
  assert.equal(msgs[3].content, `${OPEN}{"name":"read_file","arguments":{"path":"a.js"}}${CLOSE}`);
  assert.equal(msgs[4].role, 'user');
  assert.match(msgs[4].content, /\[Result of tool call read_file \(call_1\)\]\nconsole\.log\(1\)/);
  const prompt = buildPrompt(msgs);
  assert.match(prompt, /console\.log\(1\)/);
  assert.match(toolInstructions(tools, 'required'), /MUST call at least one tool/);
});

// A fake CLI that answers like a model following the tool protocol.
function fakeAgent() {
  return {
    id: 'agent', label: 'Agent', kind: 'cli',
    lastMessages: null,
    async status() { return { available: true, state: 'ready' }; },
    async models() { return ['default']; },
    async *chat({ messages }) {
      this.lastMessages = messages;
      const last = messages[messages.length - 1];
      if (String(last.content).includes('[Result of tool call')) {
        yield { type: 'text', text: 'The file logs 1.' };
        return;
      }
      for (const piece of ['I will read it.\n', '<tool_', 'call>{"name":"read_file",', '"arguments":{"path":"a.js"}}</tool_call>']) {
        yield { type: 'text', text: piece };
      }
    },
  };
}

async function gateway(provider) {
  const paths = getPaths(fs.mkdtempSync(path.join(os.tmpdir(), 'jay-tools-')));
  const { config } = loadConfig(paths);
  const store = new Store(paths.state);
  const gw = createGateway({ config, store, registry: registryFrom([provider]), paths, version: 'test' });
  const { server, port } = await listen(gw.handler, { port: 0, tryNext: false });
  const call = (body) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { server, call };
}

test('gateway turns text tool calls into OpenAI tool_calls (non-streaming + streaming + follow-up)', async () => {
  const agent = fakeAgent();
  const g = await gateway(agent);
  try {
    const base = { model: 'agent', tools, messages: [{ role: 'user', content: 'what is in a.js?' }] };
    const j = await (await g.call(base)).json();
    assert.equal(j.choices[0].finish_reason, 'tool_calls');
    assert.equal(j.choices[0].message.content, 'I will read it.\n');
    assert.equal(j.choices[0].message.tool_calls[0].function.name, 'read_file');
    assert.match(agent.lastMessages[0].content, /# Tools/);

    const text = await (await g.call({ ...base, stream: true })).text();
    const chunks = text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
    const content = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
    assert.equal(content, 'I will read it.\n');
    assert.doesNotMatch(content, /tool_call/);
    const tc = chunks.find((c) => c.choices[0]?.delta?.tool_calls);
    assert.equal(tc.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(tc.choices[0].delta.tool_calls[0].function.name, 'read_file');
    assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');

    // Next turn: the client sends the tool result back.
    const follow = await (await g.call({
      ...base,
      messages: [
        ...base.messages,
        { role: 'assistant', content: null, tool_calls: j.choices[0].message.tool_calls },
        { role: 'tool', tool_call_id: j.choices[0].message.tool_calls[0].id, content: 'console.log(1)' },
      ],
    })).json();
    assert.equal(follow.choices[0].finish_reason, 'stop');
    assert.equal(follow.choices[0].message.content, 'The file logs 1.');
    assert.equal(follow.choices[0].message.tool_calls, undefined);

    // tool_choice "none": no tool instructions, no parsing.
    await g.call({ ...base, tool_choice: 'none' });
    assert.doesNotMatch(String(agent.lastMessages[0].content), /# Tools/);
  } finally { g.server.close(); }
});
