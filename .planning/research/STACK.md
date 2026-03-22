# Stack Research: v0.4.0 Observability

**Domain:** Sub-agent progress visibility and context limit error passthrough for CLI subprocess bridge
**Researched:** 2026-03-21
**Confidence:** HIGH

## Executive Summary

The v0.4.0 observability milestone requires **zero new dependencies**. Everything needed is already present in the existing stack. The work is entirely about leveraging NDJSON event types that the CLI already emits but that `provider.ts` currently discards, and mapping them to pi's existing `AssistantMessageEvent` types.

## What Exists (DO NOT change)

The current stack from v1.0 MVP is complete and validated:

| Technology | Version | Purpose | Status |
|------------|---------|---------|--------|
| `cross-spawn` | ^7.0.6 | Cross-platform subprocess spawn | Shipped, working |
| `node:readline` | Built-in | NDJSON line splitting | Shipped, working |
| `node:child_process` | Built-in | Subprocess lifecycle | Shipped, working |
| `@mariozechner/pi-ai` | ^0.52.0 | Provider API, event stream types | Peer dep, working |
| `@mariozechner/pi-coding-agent` | ^0.52.0 | Agent loop, `isContextOverflow()` | Peer dep, working |
| TypeScript | ^5.7 | Type checking | Dev dep, working |
| Vitest | ^3.0 | Testing | Dev dep, working |

## Stack Additions for v0.4.0

### Answer: None. Zero new dependencies.

Both features (#12 sub-agent progress, #2 context limit errors) are implementable entirely with:

1. **Existing NDJSON event fields** already emitted by the CLI
2. **Existing pi event types** already defined in `@mariozechner/pi-ai`
3. **Existing utility functions** already exported by `@mariozechner/pi-ai`

## Feature #12: Sub-Agent Progress Visibility

### The Problem

When Claude uses internal tools (Agent, Task, etc.), the CLI emits sub-agent `stream_event` messages with `parent_tool_use_id` set to a non-null string. Currently, `provider.ts` line 238-239 discards ALL sub-agent events:

```typescript
const isTopLevel = !(msg as any).parent_tool_use_id;
if (isTopLevel) {
  bridge.handleEvent(msg.event);
}
```

This means during long sub-agent work (which can take 30-180 seconds), pi shows "Working..." with no activity.

### What the CLI Emits for Sub-Agents

**Confidence: HIGH** -- Verified via official Agent SDK docs and existing test fixtures in `provider.test.ts`.

The NDJSON wire format for sub-agent events is identical to top-level events, with one addition:

```jsonl
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": { "type": "tool_use", "id": "toolu_sub_1", "name": "Read" }
  },
  "parent_tool_use_id": "toolu_agent_1"
}
```

Key fields:
- `parent_tool_use_id: string | null` -- Non-null means this is a sub-agent event
- `event` -- Standard Claude API streaming event (same shape as top-level)
- Sub-agents emit the full event lifecycle: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`

Sub-agent events use all the same event types as top-level: `text` content blocks (sub-agent thinking out loud), `tool_use` content blocks (sub-agent calling Read, Bash, etc.), `thinking` content blocks.

### How to Surface Progress Without New Dependencies

Pi's `AssistantMessageEventStream` supports these event types (from `@mariozechner/pi-ai/dist/types.d.ts`):

```typescript
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage }
```

**There is no dedicated "progress" or "status" event type in pi.** Progress must be conveyed through existing text events.

**Recommended approach:** Emit sub-agent tool activity as `text_delta` events to the stream. When a sub-agent starts a tool call (e.g., Read on `src/provider.ts`), emit a brief status line like `[Agent: Read src/provider.ts]\n`. This renders inline in pi's chat UI as visible text, giving the user real-time progress.

This is the same pattern used by the official Agent SDK's "Build a streaming UI" example (see Sources), which shows `[Using Read...]` during tool execution.

**No new event types needed. No pi-side changes needed.**

### Specific Integration Points

Changes go in `provider.ts` (the readline `line` event handler):

1. When a sub-agent `content_block_start` with `type: "tool_use"` arrives, extract `name` and partial tool input
2. Emit a `text_delta` with a formatted progress line
3. Track sub-agent tool state minimally (just enough to format the status line)
4. When a sub-agent `content_block_stop` arrives for a tool_use, optionally emit "done" indicator

The event bridge (`event-bridge.ts`) does NOT need changes. Progress lines bypass the bridge and go directly to the stream as synthetic text events.

### What NOT to Build

- Do NOT create a new event type (pi's EventStream only accepts the union above)
- Do NOT attempt to forward sub-agent events through the event bridge (it tracks content block indices that would conflict with top-level blocks)
- Do NOT install any progress/spinner libraries (text_delta events are sufficient)
- Do NOT accumulate full sub-agent content (only tool names/paths matter for progress)

## Feature #2: Context Limit Error Passthrough

### The Problem

When conversation history exceeds context limits, the Claude CLI can fail in multiple ways. Currently these surface as generic subprocess errors or get swallowed entirely.

### Where Context Limit Errors Appear in the Wire Protocol

**Confidence: HIGH** -- Verified from multiple sources (Claude API docs, pi-ai overflow.js source code, Agent SDK spec).

Context limit errors surface in **three distinct places** in the NDJSON stream:

#### 1. Result Message with Error Subtype

```jsonl
{
  "type": "result",
  "subtype": "error_during_execution",
  "is_error": true,
  "result": "prompt is too long: 213462 tokens > 200000 maximum",
  "errors": ["prompt is too long: 213462 tokens > 200000 maximum"],
  "session_id": "..."
}
```

The existing handler in `provider.ts` already catches `result` with `subtype === "error"`, but it only checks `msg.subtype === "error"`. The CLI also emits `"error_during_execution"`, `"error_max_turns"`, and `"error_max_budget_usd"` as error subtypes.

**Fix needed:** Broaden the error check from `msg.subtype === "error"` to `msg.subtype?.startsWith("error") || msg.is_error === true`.

#### 2. Subprocess Exit with Non-Zero Code + Stderr

The CLI may crash with exit code 1 and stderr containing the error message. The existing `proc.on("close", ...)` handler already surfaces these as errors. **No change needed here**, but the error message should be checked for context overflow patterns.

#### 3. API Error in Stream Events

For overloaded/rate-limit scenarios (not context overflow, but related), errors appear as:

```jsonl
{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
```

These are less common in `--stream-json` mode (CLI handles retries internally), but worth handling.

### Pi's Existing Overflow Detection

**Confidence: HIGH** -- Read directly from `@mariozechner/pi-ai/dist/utils/overflow.js`.

Pi already exports `isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean` from `@mariozechner/pi-ai`. This function checks:

1. `message.stopReason === "error"` AND `message.errorMessage` matches known patterns
2. Silent overflow via `usage.input > contextWindow`

Known patterns include (from `overflow.js` OVERFLOW_PATTERNS array):
- `/prompt is too long/i` (Anthropic)
- `/context_length_exceeded/i` (generic)
- `/too many tokens/i` (generic)
- `/token limit exceeded/i` (generic)

**For pi/GSD to detect our overflow errors, we must set:**
- `stopReason: "error"` on the `AssistantMessage`
- `errorMessage: string` with the actual error text from the CLI

The current `endStreamWithError()` in `provider.ts` pushes a `done` event, NOT an `error` event, and puts the error text in a `TextContent` block rather than in `errorMessage`. This means `isContextOverflow()` will never detect it.

**Fix needed:** When the error text matches context overflow patterns, emit the error in a format pi can detect:
- Set `output.stopReason = "error"`
- Set `output.errorMessage = errorText`
- Push via `{ type: "error", reason: "error", error: output }` event

### Key Decision: "done" vs "error" Event for Errors

The current code uses `done` instead of `error` because of a pi bug where `extractResult()` returns the raw error string instead of an `AssistantMessage` object, causing downstream crashes. The comment in `provider.ts` explains this:

```typescript
// Why "done" not "error": AssistantMessageEventStream.extractResult()
// returns event.error (a string) for error events, but agent-loop.js
// then calls message.content.filter() on the result, crashing because
// a string has no .content property.
```

**This needs re-verification.** The current `AssistantMessageEvent` type definition shows:

```typescript
{ type: "error"; reason: "aborted" | "error"; error: AssistantMessage }
```

The `error` field IS typed as `AssistantMessage`, not string. If pi's agent-session now correctly handles `error` events with `AssistantMessage` payloads (as suggested by the type definition), we should switch to using `error` events for genuine errors. This enables `isContextOverflow()` detection.

**Recommendation:** Test whether pi's current agent loop handles `{ type: "error", reason: "error", error: AssistantMessage }` correctly. If yes, use `error` events for context overflow and other genuine errors. If not, continue using `done` but set `errorMessage` on the `AssistantMessage` so `isContextOverflow()` still works.

### What the Types Tell Us

The `NdjsonMessage` type in `types.ts` needs updating. Currently it defines:

```typescript
export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error";
  result?: string;
  error?: string;
  session_id?: string;
}
```

The actual CLI emits additional `subtype` values and fields:

```typescript
export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd";
  is_error?: boolean;
  result?: string;
  error?: string;
  errors?: string[];
  session_id?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
}
```

## Feature #3: README Updates

No stack implications. Documentation only.

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Progress display | Synthetic `text_delta` events | Custom event type | Pi's EventStream only accepts the defined union. Cannot add new types without pi-side changes. |
| Progress display | Inline `[Agent: Read ...]` text | Separate progress stream/callback | Pi providers have exactly one communication channel: the `AssistantMessageEventStream`. No sideband. |
| Progress display | Brief tool name + first arg | Full sub-agent content forwarding | Sub-agent content would create a confusing interleaved stream. Users need "what's happening" not "every detail." |
| Error detection | Use pi's `isContextOverflow()` | Custom regex matching | Pi already maintains a comprehensive pattern list across all providers. Use it. |
| Error surfacing | `error` event with `errorMessage` | `done` event with error text in content | `error` event enables pi's built-in overflow detection and auto-compaction. `done` with text is a workaround, not a solution. |
| Error subtypes | Check `is_error` boolean | Check `subtype === "error"` only | CLI emits `error_during_execution` etc. -- checking only `"error"` misses these. |

## What NOT to Add

| Technology | Why Not |
|------------|---------|
| Progress bar libraries (ora, cli-progress, etc.) | We emit events to pi's stream, not to a terminal. Pi renders. |
| WebSocket/SSE for sideband progress | Over-engineering. Sub-agent events are already in the NDJSON stream. |
| `@anthropic-ai/claude-agent-sdk` | Still out of scope. We parse the same wire protocol directly. |
| Custom MCP tools for progress reporting | MCP is for tool exposure, not for internal progress signaling. |
| Any new npm dependencies | Both features are achievable with existing code and pi APIs. |

## Version Compatibility

| Component | Min Version | Verified | Notes |
|-----------|-------------|----------|-------|
| Claude CLI | 1.0.0+ | YES | `parent_tool_use_id` field present since sub-agent support was added |
| `@mariozechner/pi-ai` | ^0.52.0 | YES | `isContextOverflow()` exported, `errorMessage` field on `AssistantMessage` |
| `@mariozechner/pi-coding-agent` | ^0.52.0 | YES | Auto-compaction on overflow, `AgentSessionEvent` types |
| Node.js | 22+ | YES | No new Node.js APIs needed |

## Integration Points Summary

### Files That Need Changes

| File | Change Type | What |
|------|-------------|------|
| `src/provider.ts` | Modify | Sub-agent progress extraction, error subtype broadening |
| `src/types.ts` | Modify | Expand `ClaudeResultMessage.subtype` union, add `is_error`/`errors` fields |
| `src/event-bridge.ts` | No change | Progress bypasses the bridge; error handling stays in provider |
| `src/stream-parser.ts` | No change | Already parses all NDJSON lines correctly |
| `src/process-manager.ts` | No change | Subprocess lifecycle unchanged |
| `src/control-handler.ts` | No change | Control protocol unchanged |
| `README.md` | Modify | Add pi install instructions (#3) |

### New Files (Likely)

| File | Purpose |
|------|---------|
| `src/progress-tracker.ts` | Extract sub-agent tool activity into progress text lines |

## Sources

### Official Documentation (HIGH confidence)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) -- All CLI flags, confirmed `--verbose` and `--include-partial-messages`
- [Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- `StreamEvent` type with `parent_tool_use_id`, event lifecycle, "Build a streaming UI" pattern
- [Claude Agent SDK Spec (Gist)](https://gist.github.com/SamSaffron/603648958a8c18ceae34939a8951d417) -- NDJSON message types, result message format with `is_error`, `errors`, `subtype` values
- [Claude API Errors](https://platform.claude.com/docs/en/api/errors) -- Error types including `overloaded_error`, `invalid_request_error`
- [Claude API Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) -- Event types in raw API stream

### Pi Ecosystem (HIGH confidence)
- `@mariozechner/pi-ai/dist/types.d.ts` (local) -- `AssistantMessageEvent` union type (definitive list of event types)
- `@mariozechner/pi-ai/dist/utils/overflow.js` (local) -- `isContextOverflow()` implementation with OVERFLOW_PATTERNS regex array
- `@mariozechner/pi-ai/dist/utils/event-stream.d.ts` (local) -- `EventStream.push()` method, `AssistantMessageEventStream` class
- [pi-mono Streaming API (DeepWiki)](https://deepwiki.com/badlogic/pi-mono/2.2-streaming-api-and-provider-implementations) -- How agent loop consumes events, error surfacing, `isContextOverflow()` usage
- [pi-mono custom-provider docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md) -- Provider registration, test suites including `context-overflow.test.ts`
- [pi-mono extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) -- Context overflow handling in extensions

### Existing Codebase (HIGH confidence)
- `src/provider.ts` line 238 -- Current sub-agent event filtering (`parent_tool_use_id` check)
- `src/provider.ts` line 141 -- Current `endStreamWithError()` using `done` instead of `error`
- `src/types.ts` line 12 -- Current `ClaudeResultMessage.subtype` limited to `"success" | "error"`
- `tests/provider.test.ts` line 884 -- Existing test: "does NOT break-early for sub-agents"

---
*Stack research for: pi-claude-cli v0.4.0 Observability*
*Researched: 2026-03-21*
