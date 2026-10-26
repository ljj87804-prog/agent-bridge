import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './lib/store.mjs';
import { createHandlers } from './lib/tools.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-regression-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('bridge-regression-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return new Store(root);
}
const send = (s, body = 'hello') => s.append({ from: 'dsh', to: 'codex', body });

test('pagination preserves every unread message and survives reopening', t => {
  const s = fixture(t);
  const ids = Array.from({ length: 25 }, (_, i) => send(s, String(i)).id);
  assert.equal(s.inbox('codex', { markRead: false }).returned, 20);
  const first = s.inbox('codex');
  assert.equal(first.truncated, true);
  const reopened = new Store(s.root);
  const second = reopened.inbox('codex');
  assert.equal(second.returned, 5);
  assert.deepEqual([...first.messages, ...second.messages].map(m => m.id), ids);
  assert.equal(reopened.inbox('codex').returned, 0);
});

test('messages arriving after the unread snapshot stay unread', t => {
  const s = fixture(t);
  send(s, 'before snapshot');
  const original = s._unreadFor.bind(s);
  s._unreadFor = agent => {
    const snapshot = original(agent);
    send(new Store(s.root), 'after snapshot');
    s._unreadFor = original;
    return snapshot;
  };
  assert.equal(s.inbox('codex').returned, 1);
  assert.equal(s.inbox('codex').messages[0]?.body, 'after snapshot');
});

test('empty snapshot does not consume a new arrival', t => {
  const s = fixture(t);
  const original = s._unreadFor.bind(s);
  s._unreadFor = agent => {
    const snapshot = original(agent);
    send(new Store(s.root), 'new arrival');
    s._unreadFor = original;
    return snapshot;
  };
  assert.equal(s.inbox('codex').returned, 0);
  assert.equal(s.inbox('codex').returned, 1);
});

test('wait pagination preserves remaining messages', async t => {
  const s = fixture(t);
  for (let i = 0; i < 25; i++) send(s, String(i));
  const h = createHandlers(s, 'codex');
  assert.equal((await h.wait({ limit: 20, timeout_ms: 1000 })).returned, 20);
  assert.equal((await h.wait({ limit: 20, timeout_ms: 1000 })).returned, 5);
});

test('append recovers a truncated trailing record', t => {
  const s = fixture(t);
  const first = send(s, 'before crash');
  fs.appendFileSync(s.messagesPath, '{"seq":2,"body":"partial');
  const next = send(new Store(s.root), 'after crash');
  assert.deepEqual(new Store(s.root).messages().map(m => m.id), [first.id, next.id]);
  assert.ok(next.seq > first.seq);
});

test('complete trailing JSON without newline is preserved', t => {
  const s = fixture(t);
  const first = send(s, 'complete record');
  const raw = fs.readFileSync(s.messagesPath, 'utf8');
  fs.writeFileSync(s.messagesPath, raw.trimEnd());
  const next = send(new Store(s.root), 'next record');
  assert.deepEqual(new Store(s.root).messages().map(m => m.id), [first.id, next.id]);
});

test('concurrent processes retain all messages with unique ordered sequences', async t => {
  const s = fixture(t);
  const moduleUrl = new URL('./lib/store.mjs', import.meta.url).href;
  const children = Array.from({ length: 4 }, (_, worker) => new Promise((resolve, reject) => {
    const code = `import {Store} from ${JSON.stringify(moduleUrl)}; const s = new Store(${JSON.stringify(s.root)}); for(let i=0;i<30;i++)s.append({from:'dsh',to:'codex',body:${JSON.stringify(String(worker))} + ':' + i});`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    p.stderr.on('data', chunk => { errors += chunk; });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(errors || `exit ${code}`)));
  }));
  const results = await Promise.allSettled(children);
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.message);
  const messages = new Store(s.root).messages();
  assert.equal(messages.length, 120);
  assert.equal(new Set(messages.map(m => m.body)).size, 120);
  assert.deepEqual(messages.map(m => m.seq), Array.from({ length: 120 }, (_, i) => i + 1));
});
