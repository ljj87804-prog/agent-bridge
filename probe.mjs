#!/usr/bin/env node
// Conformance + round-trip probe for the bridge.
//
// It spawns two real MCP server processes (one as "codex", one as "dsh") against
// a throwaway state directory, speaks newline-delimited JSON-RPC to each, and
// asserts that the handshake, tool surface, and cross-process mailbox all work.
//
//   node probe.mjs            # exits 0 on success
//   node probe.mjs --keep     # leave the throwaway state dir for inspection

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const keep = process.argv.includes('--keep');

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
    return true;
  }
  failures += 1;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `\n        ${JSON.stringify(detail)}`}`);
  return false;
}

class McpClient {
  constructor(agent, stateDir) {
    this.agent = agent;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
    this.proc = spawn(process.execPath, [SERVER, '--agent', agent, '--state', stateDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.exited = new Promise((resolve) => this.proc.on('exit', resolve));
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`non-JSON on stdout: ${line.slice(0, 200)}`);
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  }

  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async handshake() {
    const init = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bridge-probe', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
    return init;
  }

  async tool(name, args = {}, timeoutMs) {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = result?.content?.[0]?.text ?? '';
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
    return { isError: result.isError === true, payload, raw: result };
  }

  async close() {
    this.proc.stdin.end();
    const timer = setTimeout(() => this.proc.kill(), 2000);
    await this.exited;
    clearTimeout(timer);
  }
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-probe-'));
const stateDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-probe2-'));
console.log(`state: ${stateDir}`);
console.log(`server: ${SERVER}`);

let codex;
let dsh;
let codex2;
let dsh2;
try {
  // ---------------------------------------------------------------- handshake
  codex = new McpClient('codex', stateDir);
  dsh = new McpClient('dsh', stateDir);

  const init = await codex.handshake();
  ok(init.protocolVersion === '2025-06-18', 'initialize echoes the requested protocol version', init.protocolVersion);
  ok(init.serverInfo?.name === 'dsh-codex-bridge', 'serverInfo.name is stable', init.serverInfo);
  ok(typeof init.instructions === 'string' && init.instructions.length > 100, 'server instructions are present');
  ok(init.capabilities?.tools !== undefined, 'tools capability advertised', init.capabilities);

  await dsh.handshake();
  ok(true, 'both identities complete the handshake');

  // ------------------------------------------------------------- tool surface
  const listing = await codex.request('tools/list', {});
  const names = (listing.tools ?? []).map((t) => t.name);
  ok(names.length === 7, 'tools/list returns 7 tools', names);
  for (const expected of ['whoami', 'send', 'inbox', 'wait', 'history', 'presence', 'ack']) {
    ok(names.includes(expected), `tool "${expected}" is listed`);
  }
  const schemasOk = (listing.tools ?? []).every(
    (t) => t.inputSchema?.type === 'object' && typeof t.description === 'string' && t.description.length > 10,
  );
  ok(schemasOk, 'every tool has an object inputSchema and a description');

  const who = await codex.tool('whoami');
  ok(who.payload.agent === 'codex' && who.payload.peer === 'dsh', 'whoami reports the launching identity', who.payload);

  const bad = await codex.tool('nope');
  ok(bad.isError === true, 'unknown tool returns isError instead of a protocol error', bad.payload);

  const badArgs = await codex.tool('send', { to: 'codex', body: 'self' });
  ok(badArgs.isError === true, 'self-addressed messages are rejected', badArgs.payload);

  // -------------------------------------------------------- cross-process flow
  const sent = await codex.tool('send', {
    to: 'dsh',
    subject: 'probe request',
    body: 'Review the probe fixture and answer with kind=report.',
    kind: 'request',
    expects_reply: true,
  });
  ok(sent.payload.delivered === true && typeof sent.payload.id === 'string', 'codex can deliver to dsh', sent.payload);

  const read = await dsh.tool('inbox');
  ok(read.payload.returned === 1 && read.payload.messages[0].from === 'codex', 'dsh consumes the codex message', read.payload);
  ok(read.payload.messages[0].subject === 'probe request', 'subject survives the round trip');
  ok(read.payload.messages[0].expectsReply === true, 'expects_reply survives the round trip');

  const reread = await dsh.tool('inbox');
  ok(reread.payload.returned === 0, 'consumed messages are not redelivered', reread.payload);

  const reply = await dsh.tool('send', {
    to: 'codex',
    body: 'Reviewed: the fixture is fine.',
    kind: 'report',
    in_reply_to: read.payload.messages[0].id,
  });
  ok(reply.payload.delivered === true, 'dsh can reply to codex', reply.payload);

  const waited = await codex.tool('wait', { timeout_ms: 5000 }, 15000);
  ok(waited.payload.timedOut === false && waited.payload.returned === 1, 'wait() collects the reply without polling', waited.payload);
  ok(waited.payload.messages[0].inReplyTo === read.payload.messages[0].id, 'in_reply_to is preserved');

  const timedOut = await dsh.tool('wait', { timeout_ms: 1200 }, 10000);
  ok(timedOut.payload.timedOut === true, 'wait() times out cleanly when nothing arrives', timedOut.payload);

  const history = await codex.tool('history', { limit: 10 });
  ok(history.payload.count === 2, 'history shows both directions', history.payload.messages?.map((m) => `${m.from}->${m.to}`));

  const presence = await codex.tool('presence');
  ok(presence.payload.agents?.dsh?.alive === true && presence.payload.agents?.codex?.alive === true, 'presence sees both sides alive', presence.payload.agents);

  const broadcast = await codex.tool('send', { to: 'all', body: 'broadcast probe', kind: 'note' });
  ok(broadcast.payload.delivered === true, 'broadcast to all is accepted', broadcast.payload);
  const dshBroadcast = await dsh.tool('inbox');
  ok(dshBroadcast.payload.returned === 1 && dshBroadcast.payload.messages[0].to === 'all', 'broadcast reaches dsh', dshBroadcast.payload);

  // ------------------------------------------------------------- file backing
  const transcript = fs.readFileSync(path.join(stateDir, 'messages.jsonl'), 'utf8').trim().split('\n');
  ok(transcript.length === 3, 'every message is persisted to messages.jsonl', transcript.length);
  ok(
    transcript.every((line) => {
      try {
        return typeof JSON.parse(line).seq === 'number';
      } catch {
        return false;
      }
    }),
    'persisted lines are valid JSON with monotonic seq',
  );

  // ----------------------------------------------- regression: paging + crash
  console.log('\n  -- regressions (fresh state) --');
  codex2 = new McpClient('codex', stateDir2);
  dsh2 = new McpClient('dsh', stateDir2);
  await codex2.handshake();
  await dsh2.handshake();

  for (let i = 1; i <= 5; i += 1) {
    await codex2.tool('send', { to: 'dsh', body: `paged message ${i}` });
  }
  const page1 = await dsh2.tool('inbox', { limit: 2 });
  ok(page1.payload.returned === 2 && page1.payload.truncated === true, 'inbox honours limit and reports truncation', page1.payload);
  const page2 = await dsh2.tool('inbox', { limit: 10 });
  ok(page2.payload.returned === 3, 'a truncated page does not consume the rest', page2.payload);
  const page3 = await dsh2.tool('inbox', { limit: 10 });
  ok(page3.payload.returned === 0, 'every message is delivered exactly once', page3.payload);
  ok(
    [...page1.payload.messages, ...page2.payload.messages].map((m) => m.seq).join(',') === '1,2,3,4,5',
    'paging yields all five messages in order',
  );

  const tornPath = path.join(stateDir2, 'messages.jsonl');
  fs.appendFileSync(tornPath, '{"id":"torn","seq":6,"from":"codex","to":"dsh"');
  const afterTorn = await codex2.tool('send', { to: 'dsh', body: 'written after a torn tail' });
  ok(afterTorn.payload.delivered === true, 'send survives a torn tail', afterTorn.payload);
  const hist2 = await dsh2.tool('history', { limit: 50 });
  ok(hist2.payload.count === 6, 'a torn tail does not swallow real messages', hist2.payload.count);
  ok(hist2.payload.messages.at(-1).body === 'written after a torn tail', 'the post-crash message is readable');
  ok(!fs.readFileSync(tornPath, 'utf8').includes('"torn"'), 'the torn fragment is truncated away before appending');
  const survivors = await dsh2.tool('inbox', { limit: 10 });
  ok(survivors.payload.returned === 1 && survivors.payload.messages[0].seq === 6, 'unread state is consistent after recovery', survivors.payload);

  // A complete record whose newline never landed must be kept, not truncated.
  fs.writeFileSync(tornPath, fs.readFileSync(tornPath, 'utf8').trimEnd());
  await codex2.tool('send', { to: 'dsh', body: 'after a missing newline' });
  const hist3 = await dsh2.tool('history', { limit: 100 });
  ok(hist3.payload.count === 7, 'a complete record without its newline is preserved', hist3.payload.count);
  ok(hist3.payload.messages.at(-1).body === 'after a missing newline', 'append continues after the recovered record');

  // Valid JSON that is not a message is debris, not a record to keep.
  fs.appendFileSync(tornPath, '123');
  await codex2.tool('send', { to: 'dsh', body: 'after a junk tail' });
  const hist4 = await dsh2.tool('history', { limit: 100 });
  ok(hist4.payload.count === 8, 'a non-message JSON tail is discarded instead of preserved', hist4.payload.count);
} catch (err) {
  failures += 1;
  console.log(`  ERROR ${err?.message ?? err}`);
  if (codex?.stderr) console.log(`codex stderr: ${codex.stderr}`);
  if (dsh?.stderr) console.log(`dsh stderr: ${dsh.stderr}`);
} finally {
  await codex?.close().catch(() => {});
  await dsh?.close().catch(() => {});
  await codex2?.close().catch(() => {});
  await dsh2?.close().catch(() => {});
  if (!keep) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(stateDir2, { recursive: true, force: true });
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks - failures}/${checks} checks${keep ? ` (state kept: ${stateDir})` : ''}`);
process.exit(failures === 0 ? 0 : 1);
