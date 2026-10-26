import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from './lib/store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lock-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('bridge-lock-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return new Store(root);
}
const send = (store, body) => store.append({ from: 'dsh', to: 'codex', body });

test('stale crash lock is reclaimed without losing messages', t => {
  const s = fixture(t);
  const first = send(s, 'before crash');
  fs.writeFileSync(s.lockPath, 'crashed-process');
  const old = new Date(Date.now() - 35000);
  fs.utimesSync(s.lockPath, old, old);
  const second = send(s, 'after recovery');
  assert.deepEqual(new Store(s.root).messages().map(m => m.id), [first.id, second.id]);
  assert.equal(fs.existsSync(s.lockPath), false);
});

test('fresh lock held by another process causes explicit busy error', async t => {
  const s = fixture(t);
  const first = send(s, 'existing');
  const code = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(s.lockPath)}, String(process.pid), {flag:'wx'}); process.send('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('lock holder exited before ready'); })]);
    assert.throws(() => send(s, 'must not be written'), /bridge lock busy/);
    assert.deepEqual(s.messages().map(m => m.id), [first.id]);
    assert.equal(fs.readFileSync(s.lockPath, 'utf8'), String(child.pid));
  } finally {
    child.kill();
    await exited;
  }
});

test('presence expires after 50 seconds while fresh peer remains alive', t => {
  const s = fixture(t);
  s.heartbeat('dsh');
  s.heartbeat('codex');
  const presence = s.presence();
  presence.dsh.lastSeen = new Date(Date.now() - 50000).toISOString();
  fs.writeFileSync(s.presencePath, JSON.stringify(presence));
  const summary = s.summary('codex');
  assert.equal(summary.agents.dsh.alive, false);
  assert.equal(summary.agents.codex.alive, true);
});
