# Agent Bridge — DSH ⇄ Codex

A local, file-backed MCP mailbox for DeepSeek Harness and Codex. Each client starts its own stdio server with an explicit identity; both processes share one state directory. No daemon, network port, or third-party Node dependencies are required.

## Requirements

- Node.js 20 or later
- Both clients on the same machine, with access to the same local directory
- An MCP client that supports newline-delimited JSON-RPC over stdio

## Quick start

```sh
node server.mjs --agent codex --state /absolute/path/to/shared-state
node server.mjs --agent dsh --state /absolute/path/to/shared-state
```

These are stdio MCP processes, intended to be launched separately by the respective clients. If `--state` is omitted, both use `state/` beside `server.mjs`. Environment fallbacks: `BRIDGE_AGENT`, `BRIDGE_STATE`.

### Codex configuration

Add this to your Codex configuration, replacing the example path:

```toml
[mcp_servers.bridge]
command = "node"
args = ["/absolute/path/to/agent-bridge/server.mjs", "--agent", "codex"]
startup_timeout_sec = 20
tool_timeout_sec = 150
```

On Windows, use TOML literal strings for paths, for example `'C:\projects\agent-bridge\server.mjs'`. Use an absolute Node executable path if the client cannot resolve `node`.

### DeepSeek Harness configuration

Adapt `examples/dsh-patch.yml` and insert the entry into the desktop profile's `cordis.patch.yml` under your DSH home. Both sides must resolve the same state directory. A local deployment observed the insert loading without an app restart; if tools do not appear, restart the client. Restart the corresponding MCP client after changing server code so it loads the new modules.

## Tools

| Tool | Purpose |
| --- | --- |
| `whoami` | Identity and mailbox location |
| `send` | Append a request, review, report, note, or message |
| `inbox` | Read unread messages; `mark_read:false` previews without consumption |
| `wait` | Wait for unread messages, up to 120 seconds |
| `history` | Inspect the transcript |
| `presence` | Recent server heartbeat and unread counts |
| `ack` | Advance the read cursor through a message ID |

Use `expects_reply:true` for requests and `in_reply_to` for responses. `ack` is cumulative: acknowledging a later message also skips earlier unread messages. Identities are `dsh` and `codex`; `all` broadcasts to the peer.

## CLI

```sh
node cli.mjs --agent codex send --to dsh --kind request --body "Please review the change" --expect-reply
node cli.mjs --agent dsh inbox --peek
node cli.mjs --agent dsh wait --timeout 30000
node cli.mjs --agent codex history --limit 20
```

For multiline text, use `--body-file message.md`. Pass `--state` when using a custom mailbox directory. Always specify `--agent` explicitly.

## Listening and wake-up limitations

**This bridge delivers messages; it does not start idle model turns.** `send` persists a message, and `inbox`/`wait` retrieve it during a running turn. `presence.alive` means the server recently wrote a heartbeat, not that the model is reading messages.

The tested operating approach is a roughly five-minute mailbox check configured separately in each host application. Scheduling is not installed by this repository. App shutdown, session closure, or sleep may prevent scheduled checks. Check intervals are not delivery deadlines.

An existing-session `codex queue` experiment woke an idle conversation once, but a second message in a consecutive pair had no observed response despite both queue commands returning success. The cause was not established. Do not use queue success as proof of delivery or task completion; retain the durable mailbox and periodic checks. No queue dispatcher or autonomous watcher is included.

Recommended agent instructions:

- Check the inbox at the start of related work.
- Announce file ownership before concurrent editing.
- Batch actionable requests into one response.
- Do not reply to informational `note` messages or send bare acknowledgements.
- Do not send messages for empty scheduled checks.
- Record what was verified, and distinguish peer reports from independent evidence.

## Validation

```sh
npm test
```

The suite includes 10 Node tests and 44 protocol checks: two-process exchange, pagination, arrivals during reads, wait pagination, restart persistence, trailing-record recovery, 120 concurrent writes, stale-lock recovery, live-lock errors, and presence expiration. Tests use isolated temporary state, not the working mailbox. Child-process execution is required.

These are bounded functional tests, not a long-duration availability guarantee. A separate local handler experiment received 20 delayed messages successfully; this does not establish idle-agent wake-up reliability.

## Operational boundaries

- Same-identity clients share one read cursor. Separate chats should use separate state directories if independent consumption is required.
- Messages are plaintext on local disk. All participants with filesystem access can read them; identity flags are not authentication.
- Lock recovery is based on age (30 seconds). This is intended for local filesystems, not distributed or network storage.
- The transcript grows without automatic retention or rotation.
- If a client requires approval for an MCP call, use its supported approval flow. Do not disable approvals or sandboxing as a normal setup step.
- Keep `state/`, logs, local configuration, and transcripts out of version control.
- Back up state before maintenance. Removing it removes conversation history and read cursors.

## Files

`server.mjs` implements MCP transport; `lib/store.mjs` handles storage; `lib/tools.mjs` defines tools; `cli.mjs` provides shell access. `probe.mjs`, `regression.test.mjs`, and `lock.test.mjs` contain validation.

## License

Licensed under the [MIT License](LICENSE).
