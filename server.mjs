#!/usr/bin/env node
// dsh-codex-bridge — an MCP server (stdio, newline-delimited JSON-RPC) that both
// DeepSeek Harness and Codex launch, each with their own identity, sharing one
// append-only mailbox on disk.
//
// Usage: node server.mjs --agent dsh|codex [--state <dir>]
// Env fallback: BRIDGE_AGENT, BRIDGE_STATE

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, AGENTS } from './lib/store.mjs';
import { TOOL_DEFINITIONS, INSTRUCTIONS, createHandlers } from './lib/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_INFO = { name: 'dsh-codex-bridge', version: '1.0.0' };

function parseArgs(argv) {
  const out = { agent: process.env.BRIDGE_AGENT, state: process.env.BRIDGE_STATE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent' || arg === '--as') out.agent = argv[++i];
    else if (arg === '--state') out.state = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stderr.write(
    'usage: node server.mjs --agent <dsh|codex> [--state <dir>]\n' +
      '  stdio MCP server; identities are dsh and codex, state defaults to ./state\n',
  );
  process.exit(0);
}
if (!AGENTS.includes(args.agent)) {
  process.stderr.write(
    `dsh-codex-bridge: --agent must be one of ${AGENTS.join(', ')} (got ${JSON.stringify(args.agent)})\n`,
  );
  process.exit(2);
}

const AGENT = args.agent;
const STATE_DIR = path.resolve(args.state ?? path.join(HERE, 'state'));
const store = new Store(STATE_DIR);
const handlers = createHandlers(store, AGENT);

// --------------------------------------------------------------------- plumbing
const send = (message) => {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch (err) {
    if (err?.code === 'EPIPE') process.exit(0);
    throw err;
  }
};

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

const toResult = (payload) => ({
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  isError: false,
});

const toError = (message) => ({
  content: [{ type: 'text', text: `bridge error: ${message}` }],
  isError: true,
});

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return undefined;

    case 'ping':
      return isRequest ? reply(id, {}) : undefined;

    case 'tools/list':
      return reply(id, { tools: TOOL_DEFINITIONS });

    case 'tools/call': {
      const name = params?.name;
      const toolArgs = params?.arguments ?? {};
      const handler = handlers[name];
      if (typeof handler !== 'function') return reply(id, toError(`unknown tool "${name}"`));
      try {
        store.heartbeat(AGENT, { lastTool: name, client: SERVER_INFO.name });
        const result = await handler(toolArgs);
        return reply(id, toResult(result));
      } catch (err) {
        return reply(id, toError(err?.message ?? String(err)));
      }
    }

    case 'resources/list':
      return isRequest ? reply(id, { resources: [] }) : undefined;

    case 'prompts/list':
      return isRequest ? reply(id, { prompts: [] }) : undefined;

    case 'logging/setLevel':
      return isRequest ? reply(id, {}) : undefined;

    default:
      if (isRequest) return fail(id, -32601, `method not found: ${method}`);
      return undefined;
  }
}

// ---------------------------------------------------------------------- main loop
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerate noise on stdin
    }
    handle(parsed).catch((err) => {
      if (parsed?.id !== undefined) fail(parsed.id, -32603, err?.message ?? 'internal error');
    });
  }
});
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));

store.heartbeat(AGENT, { event: 'startup', cwd: process.cwd() });
const heartbeat = setInterval(() => {
  try {
    store.heartbeat(AGENT, { event: 'heartbeat' });
  } catch {
    /* a busy lock must never kill the server */
  }
}, 20000);
heartbeat.unref?.();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

process.stderr.write(`dsh-codex-bridge: agent=${AGENT} state=${STATE_DIR}\n`);
