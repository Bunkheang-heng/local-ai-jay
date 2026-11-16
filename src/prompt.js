import { GatewayError } from './util.js';

const ROLE_LABEL = { user: 'User', assistant: 'Assistant', tool: 'Tool result', function: 'Tool result' };

/** Flattens OpenAI message content (string or parts) into plain text. */
export function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' || part?.type === 'input_text') return part.text ?? '';
        if (part?.type === 'image_url' || part?.type === 'input_image') return '[image omitted: this provider only accepts text]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new GatewayError(400, '`messages` must be a non-empty array', 'invalid_request_error');
  }
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
      throw new GatewayError(400, `messages[${i}] needs a string \`role\``, 'invalid_request_error');
    }
  }
}

/**
 * Turns a chat history into one prompt for a headless CLI.
 * A lone user message is passed through untouched, so the CLI sees exactly what was typed.
 */
export function buildPrompt(messages) {
  validateMessages(messages);
  const isSystem = (m) => m.role === 'system' || m.role === 'developer';
  const system = messages.filter(isSystem).map((m) => textOf(m.content)).filter(Boolean);
  const convo = messages.filter((m) => !isSystem(m));
  if (convo.length === 0) {
    throw new GatewayError(400, '`messages` needs at least one user message', 'invalid_request_error');
  }
  if (system.length === 0 && convo.length === 1 && convo[0].role === 'user') {
    return textOf(convo[0].content);
  }

  const parts = [];
  if (system.length) parts.push(`<instructions>\n${system.join('\n\n')}\n</instructions>`);
  const history = convo.slice(0, -1);
  if (history.length) {
    const lines = history.map((m) => `${ROLE_LABEL[m.role] || m.role}: ${textOf(m.content)}`);
    parts.push(`<conversation_so_far>\n${lines.join('\n\n')}\n</conversation_so_far>`);
  }
  const last = convo[convo.length - 1];
  if (last.role === 'user') {
    parts.push(history.length ? `Reply to the user's latest message:\n${textOf(last.content)}` : textOf(last.content));
  } else {
    parts.push(`Continue the conversation after this ${ROLE_LABEL[last.role] || last.role} message:\n${textOf(last.content)}`);
  }
  return parts.join('\n\n');
}
