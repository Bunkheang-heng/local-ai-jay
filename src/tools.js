import crypto from 'node:crypto';
import { textOf } from './prompt.js';

/**
 * OpenAI-style tool calling for providers that only speak text (CLIs and websites).
 *
 * The tools are described in the prompt and the model answers with
 *   <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * blocks, which are turned back into real `tool_calls` for the client. Earlier tool calls and
 * their results in the history are written out as text the same way.
 */
export const OPEN = '<tool_call>';
export const CLOSE = '</tool_call>';

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');

export function functionTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t && (t.type === 'function' || !t.type) && t.function?.name)
    .map((t) => t.function);
}

export function toolInstructions(tools, toolChoice) {
  const fns = functionTools(tools);
  const list = fns.map((f) => {
    const params = JSON.stringify(f.parameters || { type: 'object', properties: {} });
    return `## ${f.name}\n${clip(String(f.description || '').trim(), 2000)}\nParameters (JSON Schema): ${params}`;
  });
  let must = '';
  if (toolChoice === 'required') must = '\nIn this reply you MUST call at least one tool.';
  else if (toolChoice?.type === 'function' && toolChoice.function?.name) must = `\nIn this reply you MUST call the tool "${toolChoice.function.name}".`;
  return `# How you use tools in this conversation

Native function calling is NOT available in this session. Any built-in or native tools you may see
(for example manage_task, view_file, run_command, write_to_file) are disabled and unrelated to the
user's request; do not use them, mention them, or conclude that you lack tools because of them.

You DO have the user's tools listed below. They run on the user's own computer (their files, editor
and terminal). You call them by WRITING the call as plain text in your reply, in exactly this format:

${OPEN}{"name": "TOOL_NAME", "arguments": {"param": "value"}}${CLOSE}

The user's app reads these text blocks, runs the tools, and sends you the results in the next message.
This text format is how you edit files, create files, read files and run commands for the user.

Rules:
- "arguments" must be valid JSON that matches the tool's parameters. Use the exact tool names below.
- Several independent calls may go in one reply, one block each.
- After your tool call block(s), stop. The results come back in the next message.
- Do not ask the user to apply changes by hand: make them yourself with the tools.
- When no tool is needed, answer normally without any block.${must}

# Available tools

${list.join('\n\n')}`;
}

function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Rewrites a chat history so a text-only model can follow it: tool instructions go first,
 * assistant tool calls become <tool_call> text, and tool results become user messages.
 */
export function toolifyMessages(messages, { tools, toolChoice } = {}) {
  const names = new Map();
  const out = [];
  const fns = functionTools(tools);
  if (fns.length && toolChoice !== 'none') out.push({ role: 'system', content: toolInstructions(tools, toolChoice) });
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c) => {
        if (c.id) names.set(c.id, c.function?.name);
        return `${OPEN}${JSON.stringify({ name: c.function?.name, arguments: parseArgs(c.function?.arguments) })}${CLOSE}`;
      });
      out.push({ role: 'assistant', content: [textOf(m.content), ...calls].filter(Boolean).join('\n') });
    } else if (m.role === 'tool' || m.role === 'function') {
      const name = m.name || names.get(m.tool_call_id) || 'tool';
      out.push({ role: 'user', content: `[Result of tool call ${name}${m.tool_call_id ? ` (${m.tool_call_id})` : ''}]\n${textOf(m.content)}` });
    } else {
      out.push(m);
    }
  }
  // Repeat the key rule at the very end, where models pay the most attention.
  if (fns.length && toolChoice !== 'none' && out.length) {
    const last = out[out.length - 1];
    const names = fns.map((f) => f.name).join(', ');
    const reminder = `\n\n(Reminder: you have these tools: ${clip(names, 600)}. Call them by writing ${OPEN}{"name": ..., "arguments": {...}}${CLOSE} as text in your reply, not as native function calls. Make the changes yourself with them.)`;
    out[out.length - 1] = { ...last, content: `${textOf(last.content)}${reminder}` };
  }
  return out;
}

export function hasToolHistory(messages) {
  return Array.isArray(messages) && messages.some((m) => m.role === 'tool' || m.role === 'function' || (m.role === 'assistant' && m.tool_calls?.length));
}

function parseCall(inner, allowed) {
  let s = inner.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let obj;
  try { obj = JSON.parse(s); } catch {
    // Tolerate a trailing comma or text after the object.
    const end = s.lastIndexOf('}');
    if (end < 0) return null;
    s = s.slice(0, end + 1).replace(/,\s*([}\]])/g, '$1');
    try { obj = JSON.parse(s); } catch { return null; }
  }
  const name = obj?.name || obj?.function?.name || obj?.tool;
  if (typeof name !== 'string' || (allowed.size && !allowed.has(name))) return null;
  let args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? obj.args ?? {};
  if (typeof args !== 'string') args = JSON.stringify(args);
  return {
    id: `call_${crypto.randomBytes(9).toString('hex')}`,
    type: 'function',
    function: { name, arguments: args },
  };
}

/**
 * Splits a streamed reply into plain text (safe to show as it arrives) and tool calls.
 * Text that might be the start of a <tool_call> block is held back until it's clear.
 */
export class ToolCallStream {
  constructor(tools) {
    this.allowed = new Set(functionTools(tools).map((f) => f.name));
    this.buf = '';
    this.inCall = false;
    this.calls = [];
  }

  push(chunk) {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (!this.inCall) {
        const i = this.buf.indexOf(OPEN);
        if (i >= 0) {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + OPEN.length);
          this.inCall = true;
          continue;
        }
        // Hold back a tail that could still grow into "<tool_call>".
        let keep = 0;
        for (let n = Math.min(OPEN.length - 1, this.buf.length); n > 0; n--) {
          if (OPEN.startsWith(this.buf.slice(-n))) { keep = n; break; }
        }
        out += this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      const j = this.buf.indexOf(CLOSE);
      if (j < 0) return out;
      const inner = this.buf.slice(0, j);
      this.buf = this.buf.slice(j + CLOSE.length);
      this.inCall = false;
      const call = parseCall(inner, this.allowed);
      if (call) this.calls.push(call); else out += `${OPEN}${inner}${CLOSE}`;
    }
  }

  /** Call when the reply is complete; returns leftover text and all tool calls. */
  end() {
    let text = '';
    if (this.inCall) {
      // The model forgot the closing tag.
      const call = parseCall(this.buf, this.allowed);
      if (call) this.calls.push(call); else text = `${OPEN}${this.buf}`;
    } else {
      text = this.buf;
    }
    this.buf = '';
    this.inCall = false;
    return { text, calls: this.calls };
  }
}
