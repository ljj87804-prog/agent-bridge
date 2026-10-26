#!/usr/bin/env node
// Command-line face of the bridge, for humans, shell scripts, and agents that
// would rather shell out than call the MCP tools.
//
//   node cli.mjs --agent dsh send --to codex --body "please review a.mjs" --kind request --expect-reply
//   node cli.mjs --agent codex inbox
//   node cli.mjs --agent dsh history --limit 20
//
// Every command prints JSON on stdout and exits 1 on failure.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store, AGENTS } from './lib/store.mjs';
import { createHandlers } from './lib/tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = { _: [], agent: process.env.BRIDGE_AGENT ?? 'dsh', state: process.env.BRIDGE_STATE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--agent' || arg === '--as') flags.agent = argv[++i];
    else if (arg === '--state') flags.state = argv[++i];
    else if (arg === '--to') flags.to = argv[++i];
    else if (arg === '--body' || arg === '--message') flags.body = argv[++i];
    else if (arg === '--body-file') flags.bodyFile = argv[++i];
    else if (arg === '--subject') flags.subject = argv[++i];
    else if (arg === '--kind') flags.kind = argv[++i];
    else if (arg === '--in-reply-to') flags.inReplyTo = argv[++i];
    else if (arg === '--expect-reply') flags.expectReply = true;
    else if (arg === '--limit') flags.limit = Number(argv[++i]);
    else if (arg === '--peer') flags.peer = argv[++i];
    else if (arg === '--after-seq') flags.afterSeq = Number(argv[++i]);
    else if (arg === '--timeout') flags.timeout = Number(argv[++i]);
    else if (arg === '--peek') flags.peek = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else flags._.push(arg);
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const command = flags._[0];

if (flags.help || !command) {
  process.stdout.write(
    [
      'dsh-codex-bridge cli',
      '',
      '  node cli.mjs [--agent dsh|codex] [--state <dir>] <command> [options]',
      '',
      'commands:',
      '  whoami                              identity, peer, mailbox path',
      '  send --to <dsh|codex|all> (--body <text> | --body-file <path>) [--subject s] [--kind request|review|report|note|message]',
      '       [--expect-reply] [--in-reply-to <id>]',
      '  inbox [--limit n] [--peek]          consume (or peek at) unread messages',
      '  wait [--timeout ms] [--limit n]     long-poll for the next message',
      '  history [--limit n] [--peer <name>] [--after-seq n]',
      '  presence                            liveness + unread counts',
      '  ack <id> [<id>...]                  mark messages read',
      '',
      'env: BRIDGE_AGENT, BRIDGE_STATE',
    ].join('\n') + '\n',
  );
  process.exit(command || flags.help ? 0 : 1);
}

if (!AGENTS.includes(flags.agent)) {
  process.stderr.write(`--agent must be one of ${AGENTS.join(', ')}\n`);
  process.exit(2);
}

const store = new Store(flags.state ?? path.join(HERE, 'state'));
const handlers = createHandlers(store, flags.agent);

try {
  let result;
  switch (command) {
    case 'whoami':
      result = handlers.whoami();
      break;
    case 'send': {
      // --body-file keeps multi-line markdown and quotes intact on any shell.
      const body = flags.bodyFile ? fs.readFileSync(flags.bodyFile, 'utf8').trim() : (flags.body ?? flags._.slice(1).join(' '));
      result = handlers.send({
        to: flags.to,
        body,
        subject: flags.subject,
        kind: flags.kind,
        expects_reply: flags.expectReply,
        in_reply_to: flags.inReplyTo,
      });
      break;
    }
    case 'inbox':
      result = handlers.inbox({ limit: flags.limit, mark_read: !flags.peek });
      break;
    case 'wait':
      result = await handlers.wait({ timeout_ms: flags.timeout, limit: flags.limit });
      break;
    case 'history':
      result = handlers.history({ limit: flags.limit, peer: flags.peer, after_seq: flags.afterSeq });
      break;
    case 'presence':
      result = handlers.presence();
      break;
    case 'ack':
      result = handlers.ack({ ids: flags._.slice(1) });
      break;
    default:
      process.stderr.write(`unknown command "${command}" (try --help)\n`);
      process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`bridge error: ${err?.message ?? err}\n`);
  process.exit(1);
}
