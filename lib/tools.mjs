// Tool surface of the bridge MCP server. The same definitions serve both
// agents; `whoami` reports which identity this process was started as.

export const TOOL_DEFINITIONS = [
  {
    name: 'whoami',
    description:
      'Show this bridge identity, the peer state, and the shared mailbox location. Call this first if you are unsure which side you are.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'send',
    description:
      'Send a message to the peer agent. Use kind="request" when you need an answer, "review" when you want an opinion on concrete work, "report" when you answer one, "note" for FYI. Broadcast with to="all".',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['codex', 'dsh', 'all'], description: 'Recipient identity.' },
        body: { type: 'string', description: 'Message text, markdown allowed (max 20000 chars).' },
        subject: { type: 'string', description: 'Short thread subject (max 200 chars).' },
        kind: {
          type: 'string',
          enum: ['message', 'request', 'review', 'report', 'note'],
          description: 'Message kind, defaults to "message".',
        },
        expects_reply: { type: 'boolean', description: 'True when you are waiting for an answer.' },
        in_reply_to: { type: 'string', description: 'id of the message you are answering.' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'inbox',
    description:
      'Read messages addressed to you that you have not consumed yet. Consumed messages are not shown again; use history for the full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max messages to return (default 20).' },
        mark_read: {
          type: 'boolean',
          description: 'Advance your read cursor (default true). Pass false to peek without consuming.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description:
      'Long-poll for the next message(s) from the peer, up to timeout_ms. Returns immediately when something arrives, otherwise timed_out=true. Use it when you are blocked on a reply.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: 'How long to wait, 1000-120000 ms (default 30000).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max messages to return (default 20).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'history',
    description:
      'Read the shared transcript in order, including your own messages and messages between the peer and "all".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many of the newest messages (default 50).' },
        peer: { type: 'string', enum: ['codex', 'dsh'], description: 'Only messages involving this agent.' },
        after_seq: { type: 'integer', minimum: 0, description: 'Only messages newer than this sequence number.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'presence',
    description:
      'Show whether each side is alive, when it was last seen, unread counts, and the newest message. Use it to decide whether waiting is worthwhile.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ack',
    description: 'Mark specific messages as read by id, advancing your cursor past them.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Message ids from inbox/history.' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
];

export const INSTRUCTIONS = `This server is the dsh<->codex bridge: a shared mailbox for the two local coding agents.
Identities: "dsh" (DeepSeek Harness) and "codex" (Codex CLI/desktop). Your own identity is fixed by the process arguments.
Workflow: send() to hand over findings, requests, reviews or reports; inbox() to consume what the peer sent you; wait() to block for a reply; history() to review the whole conversation; presence() to check liveness.
Messages are append-only and visible to both sides, so write for an auditor: state the workspace, the exact commands or files involved, and a clear ask or verdict. Mark requests with expects_reply=true and answer them with kind="report" plus in_reply_to.
Please check inbox() when you start a turn that may involve the peer, and after finishing a piece of work that the peer is waiting on.`;

// ---------------------------------------------------------------------------
// Handlers. Each returns a plain JSON-serialisable object.
// ---------------------------------------------------------------------------

export function createHandlers(store, agent) {
  return {
    whoami() {
      return {
        agent,
        peer: agent === 'dsh' ? 'codex' : 'dsh',
        bridge: 'dsh-codex-bridge/1.0.0',
        statePath: store.statePath ?? store.root,
        mailbox: store.messagesPath,
        transcriptTotal: store.messages().length,
      };
    },

    send(args = {}) {
      if (!args.to) throw new Error('send requires "to" (codex, dsh or all)');
      if (args.to === agent) throw new Error(`cannot send a message to yourself (${agent})`);
      const message = store.append({
        from: agent,
        to: args.to,
        body: args.body,
        subject: args.subject,
        kind: args.kind,
        expectsReply: args.expects_reply,
        inReplyTo: args.in_reply_to,
      });
      return {
        delivered: true,
        id: message.id,
        seq: message.seq,
        to: message.to,
        kind: message.kind,
        expectsReply: message.expectsReply,
        ts: message.ts,
      };
    },

    inbox(args = {}) {
      const payload = store.inbox(agent, {
        limit: args.limit ?? 20,
        markRead: args.mark_read !== false,
      });
      return payload;
    },

    async wait(args = {}) {
      const timeout = Math.max(1000, Math.min(120000, args.timeout_ms ?? 30000));
      const deadline = Date.now() + timeout;
      for (;;) {
        const pending = store.peek(agent);
        if (pending.length) {
          const payload = store.inbox(agent, { limit: args.limit ?? 20, markRead: true });
          return { ...payload, timedOut: false, waitedMs: timeout - Math.max(0, deadline - Date.now()) };
        }
        if (Date.now() >= deadline) {
          return { agent, messages: [], unreadCount: 0, returned: 0, timedOut: true, waitedMs: timeout };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
      }
    },

    history(args = {}) {
      const messages = store.history({
        limit: args.limit ?? 50,
        peer: args.peer,
        afterSeq: args.after_seq ?? 0,
      });
      return { agent, count: messages.length, messages };
    },

    presence() {
      return store.summary(agent);
    },

    ack(args = {}) {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      if (!ids.length) throw new Error('ack requires a non-empty "ids" array');
      return store.ack(agent, ids);
    },
  };
}
