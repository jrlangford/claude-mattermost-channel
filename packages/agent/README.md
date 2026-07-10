# agent

"Something you can converse with" — the AI side of a bot, as the counterpart
of [`messaging-client`](../messaging-client/README.md) (the chat-network
side). A **bot** (see `apps/`) snaps one implementation of each together and
owns the bot logic; this package is the contract plus the small pieces of
genuinely shared code. **No messaging vocabulary here** — no channels,
threads, senders, or chat attachments; rendering messages into `AgentInput`
is the bot's job.

```
messaging-client impl        agent impl
(mattermost / matrix / …)    (codex / claude-code-sdk / claude-channels)
          └───────────┬──────────────┘
                      ▼
              bot (packages/bot + apps/)
     gate, dedup, catch-up, queues, receipts,
     renders messages → AgentInput, routes AgentReply
```

## The contract

```ts
interface Agent {
  mode: string;
  needsLocalFiles?: boolean; // turn modes: caller localizes files before send()
  start(): Promise<void>;
  send(conversationKey: string, input: AgentInput): Promise<AgentReply | null>;
  stop(): Promise<void>;
}

type AgentInput = {
  text: string;                  // untrusted remote input, always
  files?: AgentFile[];           // localized to disk; path or error per file
  meta?: Record<string, string>; // opaque caller context, rendered verbatim
};
```

- **Turn modes** (codex-agent, claude-code-sdk-agent): `send()` runs one turn
  on the conversation's thread/session and returns the final response. A
  turn that produced nothing returns its own notice text — consuming input
  with no visible reply would be a silent swallow.
- **Session mode** (claude-channels-agent): `send()` pushes the input into a
  live Claude Code session and returns `null`; replies flow out of band
  through the session's own tool surface.
- `send()` **throwing means unhandled** — the caller leaves the source
  unread and at-least-once catch-up redelivers. Modes must tolerate
  redelivery (callers dedup in-process, not across restarts).
- The caller **serializes send() per conversation key**; distinct
  conversations may run concurrently.

## Common code

- `renderPrompt(input, {agentName})` — the turn modes' prompt template
  (untrusted-input framing + verbatim meta block + local file listing),
  generalized from the codex bridge's prompt. Meta keys are never
  interpreted.
- `createIdleStore({file, maxIdleMs})` — persisted conversationKey → backend
  id map with idle expiry and atomic 0600 writes (Codex threads, Claude
  sessions). Long-idle entries expire so conversations restart fresh instead
  of resuming stale context. Tolerates the pre-package codex bridge's legacy
  bare-string entries.
- `defineAgent(config => agent)` — the factory plug point; config is where
  an impl takes its SDK options, MCP transport, or messaging client.
