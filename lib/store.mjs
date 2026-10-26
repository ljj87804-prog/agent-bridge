// Shared file-backed message store for the dsh <-> codex bridge.
// Both agents run their own MCP server process; all of them read and append to
// the same JSONL file under `state/`, which is what makes cross-process
// communication work without a daemon.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AGENTS = ['dsh', 'codex'];
const MAX_BODY = 20000;
const LOCK_TIMEOUT_MS = 4000;

const iso = () => new Date().toISOString();
const sleepSync = (ms) => {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
};

// A crash mid-write must never leave a half-updated JSON file behind, so every
// non-append write goes through a sibling temp file and an atomic rename.
function writeAtomicSync(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.messagesPath = path.join(this.root, 'messages.jsonl');
    this.cursorsPath = path.join(this.root, 'cursors.json');
    this.presencePath = path.join(this.root, 'presence.json');
    this.lockPath = path.join(this.root, 'write.lock');
    this._cache = { size: -1, messages: [] };
    fs.mkdirSync(this.root, { recursive: true });
    if (!fs.existsSync(this.messagesPath)) fs.writeFileSync(this.messagesPath, '');
  }

  // ---------------------------------------------------------------- locking
  _acquire() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Reclaim a lock left behind by a crashed process (>30s old).
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > 30000) {
            fs.rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`bridge lock busy: ${this.lockPath}`);
        }
        sleepSync(15);
      }
    }
  }

  _release() {
    try {
      fs.rmSync(this.lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  _withLock(fn) {
    this._acquire();
    try {
      return fn();
    } finally {
      this._release();
    }
  }

  // --------------------------------------------------------------- messages
  messages() {
    let stat;
    try {
      stat = fs.statSync(this.messagesPath);
    } catch {
      return [];
    }
    if (stat.size === this._cache.size) return this._cache.messages;
    const raw = fs.readFileSync(this.messagesPath, 'utf8');
    const messages = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.seq === 'number') messages.push(parsed);
      } catch {
        // A torn line from a crashed writer is skipped, never fatal.
      }
    }
    this._cache = { size: stat.size, messages };
    return messages;
  }

  lastSeq() {
    const all = this.messages();
    return all.length ? all[all.length - 1].seq : 0;
  }

  /**
   * Drop a torn trailing line left by a crashed writer. Called under the lock
   * immediately before appending, so a new message can never be glued onto the
   * remains of an old one (which would make both unreadable).
   */
  _sanitizeTail() {
    let size;
    try {
      size = fs.statSync(this.messagesPath).size;
    } catch {
      return;
    }
    if (size === 0) return;
    const raw = fs.readFileSync(this.messagesPath, 'utf8');
    if (raw.endsWith('\n')) return;
    const cut = raw.lastIndexOf('\n');
    // A complete record may have reached disk before its newline. Keep it, but
    // only when it really looks like a message; other valid JSON is debris.
    let complete = false;
    try {
      const tail = JSON.parse(raw.slice(cut + 1));
      complete = Boolean(tail && typeof tail.seq === 'number' && tail.id && tail.from && tail.to);
    } catch { /* Only an incomplete JSON tail is discarded. */ }
    if (complete) fs.appendFileSync(this.messagesPath, '\n');
    else fs.truncateSync(this.messagesPath, cut === -1 ? 0 : Buffer.byteLength(raw.slice(0, cut + 1)));
    this._cache.size = -1;
  }

  append({ from, to, body, subject, kind, expectsReply, inReplyTo }) {
    if (!AGENTS.includes(from)) throw new Error(`unknown sender "${from}"`);
    if (![...AGENTS, 'all'].includes(to)) throw new Error(`unknown recipient "${to}"`);
    const text = String(body ?? '').trim();
    if (!text) throw new Error('message body is empty');
    if (text.length > MAX_BODY) throw new Error(`message body exceeds ${MAX_BODY} characters`);

    return this._withLock(() => {
      this._sanitizeTail();
      const message = {
        id: newId(),
        seq: this.lastSeq() + 1,
        ts: iso(),
        from,
        to,
        kind: kind ?? 'message',
        subject: subject ? String(subject).slice(0, 200) : undefined,
        body: text,
        expectsReply: Boolean(expectsReply),
        inReplyTo: inReplyTo || undefined,
      };
      fs.appendFileSync(this.messagesPath, `${JSON.stringify(message)}\n`);
      this._cache.size = -1;
      return message;
    });
  }

  // ----------------------------------------------------------------- cursors
  cursors() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cursorsPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  cursorOf(agent) {
    const value = this.cursors()[agent];
    return typeof value === 'number' ? value : 0;
  }

  setCursor(agent, seq) {
    this._withLock(() => {
      const cursors = this.cursors();
      if (typeof cursors[agent] === 'number' && cursors[agent] >= seq) return;
      cursors[agent] = seq;
      writeAtomicSync(this.cursorsPath, JSON.stringify(cursors, null, 2));
    });
  }

  // ---------------------------------------------------------------- presence
  presence() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.presencePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  heartbeat(agent, extra = {}) {
    this._withLock(() => {
      const all = this.presence();
      const previous = all[agent] ?? {};
      all[agent] = {
        ...previous,
        ...extra,
        agent,
        pid: process.pid,
        lastSeen: iso(),
        startedAt: previous.startedAt ?? iso(),
        heartbeats: (previous.heartbeats ?? 0) + 1,
      };
      writeAtomicSync(this.presencePath, JSON.stringify(all, null, 2));
    });
  }

  // --------------------------------------------------------------- queries
  _unreadFor(agent) {
    const cursor = this.cursorOf(agent);
    return this.messages().filter(
      (m) => m.seq > cursor && m.from !== agent && (m.to === agent || m.to === 'all'),
    );
  }

  inbox(agent, { limit = 20, markRead = true } = {}) {
    const unread = this._unreadFor(agent);
    const picked = unread.slice(0, Math.max(1, Math.min(50, limit)));
    const payload = {
      agent,
      messages: picked.map(publicMessage),
      unreadCount: unread.length,
      returned: picked.length,
      truncated: unread.length > picked.length,
    };
    // Advance only past messages actually handed over. Using the file-wide last
    // seq here would silently consume the ones a truncated page left behind.
    if (markRead && picked.length) this.setCursor(agent, picked[picked.length - 1].seq);
    return payload;
  }

  peek(agent) {
    return this._unreadFor(agent);
  }

  history({ limit = 50, peer, afterSeq = 0 } = {}) {
    const all = this.messages().filter((m) => m.seq > afterSeq);
    const filtered = peer ? all.filter((m) => m.from === peer || m.to === peer) : all;
    return filtered.slice(-Math.max(1, Math.min(200, limit))).map(publicMessage);
  }

  ack(agent, ids) {
    // Acknowledging by id only ever advances the cursor past the newest
    // acknowledged message; per-id read state is intentionally not tracked.
    const all = this.messages();
    const wanted = new Set(ids);
    const matched = all.filter((m) => wanted.has(m.id));
    if (matched.length) {
      this.setCursor(agent, Math.max(...matched.map((m) => m.seq)));
    }
    return { agent, acknowledged: matched.map((m) => m.id), cursor: this.cursorOf(agent) };
  }

  summary(agent) {
    const all = this.messages();
    const presence = this.presence();
    const now = Date.now();
    const agents = {};
    for (const name of AGENTS) {
      const seen = presence[name]?.lastSeen;
      agents[name] = {
        alive: seen ? now - Date.parse(seen) < 45000 : false,
        lastSeen: seen ?? null,
        pid: presence[name]?.pid ?? null,
        unread: this._unreadFor(name).length,
      };
    }
    return {
      you: agent,
      statePath: this.root,
      totalMessages: all.length,
      lastSeq: this.lastSeq(),
      agents,
      lastMessage: all.length ? publicMessage(all[all.length - 1]) : null,
    };
  }
}

export function publicMessage(m) {
  return {
    id: m.id,
    seq: m.seq,
    ts: m.ts,
    from: m.from,
    to: m.to,
    kind: m.kind,
    subject: m.subject,
    body: m.body,
    expectsReply: m.expectsReply,
    inReplyTo: m.inReplyTo,
  };
}
