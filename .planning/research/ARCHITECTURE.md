# Architecture Research: Observability Integration (v0.4.0)

**Domain:** CLI subprocess NDJSON stream event handling for observability
**Researched:** 2026-03-21
**Confidence:** HIGH (codebase verified, official SDK docs verified, NDJSON protocol verified)

## Executive Summary

The v0.4.0 observability milestone adds two new data flows to the existing NDJSON stream parser:
1. **Sub-agent progress visibility** -- surfacing events currently dropped by the `isTopLevel` filter in `provider.ts`
2. **Context limit error passthrough** -- detecting and forwarding errors from `assistant` and `result` NDJSON messages

Both features integrate into the existing stream processing pipeline without modifying the event bridge or break-early logic. The changes are additive: new message type handlers in the `rl.on("line")` callback and new type definitions. No changes needed to `event-bridge.ts`, `stream-parser.ts`, or `process-manager.ts`.

## Current Architecture (What Exists)

### System Overview

```
pi Agent Loop
    |
    v
streamViaCli()          [provider.ts]
    |
    +-- spawnClaude()    [process-manager.ts]
    |       |
    |       v
    |   claude -p --stream-json subprocess
    |       |
    |       v (stdout NDJSON)
    +-- readline "line" event handler  [provider.ts:226]
            |
            +-- parseLine()           [stream-parser.ts]
            |
            +-- Route by msg.type:
            |   |
            |   +-- "stream_event"
            |   |       |
            |   |       +-- isTopLevel? --> bridge.handleEvent()  [event-bridge.ts]
            |   |       |                      |
            |   |       |                      v
            |   |       |               stream.push(pi events)
            |   |       |
            |   |       +-- !isTopLevel --> DROPPED (today)
            |   |       |
            |   |       +-- message_stop + sawTool --> break-early (kill proc)
            |   |
            |   +-- "control_request"  --> handleControlRequest()  [control-handler.ts]
            |   |
            |   +-- "result"           --> endStreamWithError() or cleanupProcess()
            |   |
            |   +-- "system"           --> IGNORED (today)
            |   +-- "assistant"        --> IGNORED (today)
            |   +-- "user"             --> IGNORED (today)
            |
            v
stream.push({ type: "done" })
```

### NDJSON Message Types from Claude CLI

The Claude CLI (`--output-format stream-json`) emits these NDJSON message types:

| Type | Currently Handled | Fields | Purpose |
|------|:-:|--------|---------|
| `stream_event` | YES | `event`, `parent_tool_use_id`, `uuid`, `session_id` | Raw Claude API streaming events (text/tool deltas) |
| `result` | PARTIAL | `subtype`, `is_error`, `error`, `result`, `session_id`, `usage` | Final message. Subtypes: `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution` |
| `system` | NO | `subtype`, `data`, `session_id` | Session lifecycle. Subtypes: `init`, `compact_boundary` |
| `assistant` | NO | `message.content[]`, `message.model`, `error`, `parent_tool_use_id` | Complete assistant turn (after streaming). Has `error` field for API errors |
| `user` | NO | `content`, `tool_use_result`, `parent_tool_use_id` | Tool results sent back to Claude |
| `control_request` | YES | `request_id`, `request.subtype`, `request.tool_name` | Permission prompts |

**Critical discovery:** `assistant` messages have an `error` field of type `AssistantMessageError`:
```typescript
type AssistantMessageError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"  // <-- context limit errors surface here
  | "server_error"
  | "unknown";
```

**Critical discovery:** `result` messages have more subtypes than currently handled:
- `success` -- task completed
- `error_max_turns` -- hit maxTurns limit
- `error_max_budget_usd` -- hit budget limit
- `error_during_execution` -- API failure or cancelled request
- Currently the code only checks `subtype === "error"` which may not match these

### Sub-Agent Event Flow (What Happens Today)

When Claude's internal Agent/Task tool runs, the CLI emits a nested sequence:

```
Top-level: stream_event { event: content_block_start, type: "tool_use", name: "Agent" } parent_tool_use_id: null
Top-level: stream_event { event: message_stop } parent_tool_use_id: null
  Sub-agent: system   { subtype: "init" }                         parent_tool_use_id: "toolu_abc"
  Sub-agent: stream_event { event: message_start }                parent_tool_use_id: "toolu_abc"
  Sub-agent: stream_event { event: content_block_start, tool_use: "Read" } parent_tool_use_id: "toolu_abc"
  Sub-agent: stream_event { event: content_block_delta }          parent_tool_use_id: "toolu_abc"
  Sub-agent: stream_event { event: content_block_stop }           parent_tool_use_id: "toolu_abc"
  Sub-agent: stream_event { event: message_stop }                 parent_tool_use_id: "toolu_abc"
  Sub-agent: assistant { message: { content: [...] } }            parent_tool_use_id: "toolu_abc"
  Sub-agent: user { tool_use_result: {...} }                      parent_tool_use_id: "toolu_abc"
  ... (more sub-agent turns) ...
Top-level: stream_event { event: message_start }                  parent_tool_use_id: null
Top-level: stream_event { event: content_block_start, text }      parent_tool_use_id: null
...
result { subtype: "success" }
```

Today, **all lines where `parent_tool_use_id` is truthy are silently dropped** (line 238 of `provider.ts`). This is correct for break-early scoping but means zero sub-agent visibility.

## New Architecture (What to Build)

### Feature 1: Sub-Agent Progress Visibility (#12)

#### Integration Strategy

Inject sub-agent progress as **text_delta events** into pi's stream. This is the path of least resistance because:
- pi's `AssistantMessageEventStream` has a fixed event type vocabulary (`start`, `text_*`, `thinking_*`, `toolcall_*`, `done`, `error`)
- There is no "annotation" or "progress" event type in pi's API
- Emitting sub-agent activity as formatted text deltas makes it visible to the user in any pi renderer without pi-side changes

#### Data Flow: Sub-Agent Progress

```
rl.on("line") callback
    |
    +-- msg.type === "stream_event" && parent_tool_use_id is truthy
    |       |
    |       +-- Extract progress info from sub-agent event
    |       |   - content_block_start + tool_use --> "Using {tool_name}..."
    |       |   - content_block_start + text --> (sub-agent is responding)
    |       |   - content_block_stop (for tool_use) --> "Done with {tool_name}"
    |       |
    |       +-- progressEmitter.emit(toolName, status)
    |               |
    |               v
    |           Debounce/throttle (avoid flooding pi stream)
    |               |
    |               v
    |           Inject into event bridge as text_delta
    |           OR: emit as a separate "status" line before the final text
    |
    +-- msg.type === "assistant" && parent_tool_use_id is truthy
            |
            +-- Extract completed turn summary
            +-- Optional: emit as progress text
```

#### Recommended Pattern: Synthetic Text Block

The cleanest approach is a dedicated progress handler that:

1. Tracks sub-agent state (which agent, what tools it's using)
2. Emits progress as a synthetic text block prepended to the response
3. Replaces the text block content on each update (not appended, to avoid noise)

**However**, pi's streaming model is append-only -- there is no "replace" event. So progress must either:

- **Option A: Prepend a progress text block** that gets `text_end`'d before the real response starts. Pi renders it, then the real response follows. User sees: `"[Agent: reading src/provider.ts...]\n\nHere's what I found..."`. Clean, simple, no pi changes needed.
- **Option B: Emit progress as thinking deltas** inside a thinking block. Pi renders these in a collapsible thinking section. Less noisy but only works if the model supports thinking.
- **Option C: Log to console only** (`console.log`). Visible in terminal but not in pi's UI.

**Recommendation: Option A** -- synthetic text block for progress, closed before the real response text block starts.

#### Component: SubAgentTracker

New file: `src/subagent-tracker.ts`

```
Responsibilities:
- Track active sub-agent tool executions by parent_tool_use_id
- Extract tool names from sub-agent stream events
- Debounce/batch progress updates
- Provide formatted progress strings
- Interface with event bridge to emit synthetic text blocks

State:
- activeAgents: Map<string, { toolName: string, currentTool?: string, startTime: number }>
- progressBlock: { index: number, text: string } | null
```

#### Integration Point in provider.ts

The sub-agent tracking hooks into the existing `rl.on("line")` handler at the point where non-top-level events are currently dropped:

```typescript
// Current code (provider.ts:235-241):
if (msg.type === "stream_event") {
  const isTopLevel = !(msg as any).parent_tool_use_id;
  if (isTopLevel) {
    bridge.handleEvent(msg.event);
  }
  // ... break-early logic for top-level only
}

// New code adds an else branch:
if (msg.type === "stream_event") {
  const isTopLevel = !(msg as any).parent_tool_use_id;
  if (isTopLevel) {
    bridge.handleEvent(msg.event);
  } else {
    // NEW: Track sub-agent progress
    subAgentTracker.handleEvent(msg.event, (msg as any).parent_tool_use_id);
  }
  // ... break-early logic unchanged (still top-level only)
}
```

#### Critical Constraint: Timing of Progress Block

The progress text block MUST be closed (`text_end`) before the first top-level `content_block_start` event arrives. Otherwise the content indices will be wrong. This means:

1. Open progress text block when first sub-agent event arrives
2. Append tool progress as deltas
3. Close progress text block on first top-level `content_block_start` (or on result)
4. Event bridge then handles top-level content blocks normally

This timing works naturally because the CLI processes sub-agent turns first, then emits the final top-level response.

### Feature 2: Actionable CLI Error Passthrough (#2)

#### Error Sources

Actionable CLI errors can surface in three places in the NDJSON stream:

| Source | NDJSON Message | Field | Value | Examples |
|--------|---------------|-------|-------|----------|
| API error during streaming | `assistant` | `error` | `"invalid_request"`, `"rate_limit"`, `"authentication_failed"`, `"billing_error"`, `"server_error"` | Context overflow, 5-hr subscription cap, auth expired |
| Final result error | `result` | `subtype` | `"error_during_execution"`, `"error_max_turns"`, `"error_max_budget_usd"` | Max turns hit, budget exceeded |
| Subprocess stderr | stderr buffer | N/A | Contains error text | CLI crash, unhandled errors |

#### Data Flow: Error Detection and Passthrough

```
rl.on("line") callback
    |
    +-- msg.type === "assistant"
    |       |
    |       +-- msg.error is truthy?
    |       |       |
    |       |       +-- YES: endStreamWithError(formatAssistantError(msg))
    |       |       |   Maps: "invalid_request" --> "Context limit exceeded..."
    |       |       |   Maps: "rate_limit" --> "Rate limit or subscription cap reached..."
    |       |       |   Maps: "authentication_failed" --> "Authentication failed..."
    |       |       |   Maps: "billing_error" --> "Billing/subscription error..."
    |       |       |   Maps: "server_error" --> "Claude API server error..."
    |       |       |
    |       |       +-- NO: ignore (normal assistant turn, handled via stream_events)
    |       |
    |       +-- parent_tool_use_id? --> sub-agent error, handle differently
    |
    +-- msg.type === "result"
    |       |
    |       +-- msg.is_error === true OR msg.subtype !== "success"
    |       |       |
    |       |       +-- "error_during_execution" --> endStreamWithError(msg.result or msg.error)
    |       |       +-- "error_max_turns" --> endStreamWithError("Max turns exceeded")
    |       |       +-- Other error subtypes --> endStreamWithError(msg.error)
    |       |
    |       +-- Current check: msg.subtype === "error" (TOO NARROW)
    |           Need to widen to catch all error subtypes
    |
    +-- proc.on("close") handler (existing)
            |
            +-- Already handles stderr surface for non-zero exit codes
            +-- Context errors may appear here if CLI crashes
```

#### Integration Point in provider.ts

Two changes to the line handler:

**1. Add `assistant` message handling (new branch):**

```typescript
} else if (msg.type === "assistant") {
  const error = (msg as any).message?.error || (msg as any).error;
  if (error) {
    // Only handle top-level errors; sub-agent errors are internal
    const isTopLevel = !(msg as any).parent_tool_use_id;
    if (isTopLevel) {
      endStreamWithError(formatAssistantError(error));
    }
  }
}
```

**2. Fix `result` error detection (modify existing branch):**

```typescript
// Current (too narrow):
} else if (msg.type === "result") {
  if (msg.subtype === "error") {
    endStreamWithError(msg.error ?? "Unknown error from Claude CLI");
  }
  // ...
}

// Fixed (catches all error subtypes):
} else if (msg.type === "result") {
  if (msg.subtype !== "success") {
    const errorMsg = (msg as any).result
      ?? (msg as any).error
      ?? `Claude CLI error: ${msg.subtype}`;
    endStreamWithError(errorMsg);
  }
  // ...
}
```

#### Error Message Formatting

New utility function (can live in `provider.ts` or a new `error-formatter.ts`):

```typescript
function formatAssistantError(error: string): string {
  switch (error) {
    case "invalid_request":
      return "Context limit exceeded: conversation is too long. Start a new session or reduce context.";
    case "rate_limit":
      return "Rate limit or subscription usage cap reached. Wait for the current window to reset, or check your subscription tier.";
    case "authentication_failed":
      return "Authentication failed. Run 'claude auth login' to re-authenticate.";
    case "billing_error":
      return "Billing or subscription error. Check your Claude subscription status.";
    case "server_error":
      return "Claude API server error. Please retry.";
    default:
      return `Claude API error: ${error}`;
  }
}
```

### Feature 3: README Update (#3)

Documentation-only change. No architecture impact.

## Type Changes Required

### New Types in types.ts

```typescript
// Add to NdjsonMessage union:
export interface ClaudeAssistantMessage {
  type: "assistant";
  message?: {
    content?: unknown[];
    model?: string;
    stop_reason?: string;
    usage?: ClaudeUsage;
  };
  error?: string; // AssistantMessageError literal
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
}

export interface ClaudeUserMessage {
  type: "user";
  content?: unknown;
  tool_use_result?: unknown;
  parent_tool_use_id?: string | null;
}

// Update NdjsonMessage union:
export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeControlRequest
  | ClaudeAssistantMessage
  | ClaudeUserMessage;

// Update ClaudeResultMessage:
export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_max_budget_usd" | "error_during_execution" | string;
  result?: string;
  error?: string;
  is_error?: boolean;
  session_id?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
}

// Update ClaudeStreamEventMessage to include parent_tool_use_id:
export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
}
```

## Component Responsibilities (Updated)

| Component | Current Responsibility | New Responsibility |
|-----------|----------------------|-------------------|
| `provider.ts` | Orchestrate subprocess, route NDJSON by type, break-early | + Handle `assistant` errors, fix `result` error detection, integrate sub-agent tracker |
| `event-bridge.ts` | Map Claude API events to pi stream events | **NO CHANGES** -- progress block injection happens in provider |
| `stream-parser.ts` | Parse NDJSON lines | **NO CHANGES** -- already returns any valid JSON object |
| `types.ts` | Type definitions for NDJSON protocol | + Add `ClaudeAssistantMessage`, update `ClaudeResultMessage` subtypes, add `parent_tool_use_id` to `ClaudeStreamEventMessage` |
| `subagent-tracker.ts` | **NEW** | Track sub-agent state, emit progress text to pi stream |
| `control-handler.ts` | Handle permission control requests | **NO CHANGES** |
| `tool-mapping.ts` | Bidirectional tool name/arg mapping | **NO CHANGES** |
| `process-manager.ts` | Subprocess lifecycle | **NO CHANGES** |

## Build Order (Dependency-Aware)

### Phase 1: Type Foundation
1. Update `types.ts` with new/updated NDJSON message types
2. Add `parent_tool_use_id` to `ClaudeStreamEventMessage`
3. Update `ClaudeResultMessage` subtypes

**Rationale:** All subsequent work depends on accurate types. Zero risk, pure additive.

### Phase 2: Context Limit Error Passthrough (#2)
1. Add `assistant` message handling branch in `provider.ts` line handler
2. Add `formatAssistantError()` utility
3. Fix `result` error detection (widen from `subtype === "error"` to `subtype !== "success"`)
4. Add tests for each error type

**Rationale:** Simpler feature, no new files, low risk. Gets the error plumbing right before adding progress complexity. Also validates that the `assistant` message type appears in practice.

### Phase 3: Sub-Agent Progress (#12)
1. Create `subagent-tracker.ts` with state tracking and progress formatting
2. Wire tracker into provider's line handler (else branch for non-top-level events)
3. Implement synthetic progress text block injection
4. Handle progress block lifecycle (open on first sub-agent event, close before top-level content)
5. Add tests with realistic sub-agent event sequences

**Rationale:** Depends on Phase 1 types. More complex, benefits from the error handling plumbing already being solid.

### Phase 4: README Update (#3)
1. Update README with install instructions
2. Independent of other phases

## Anti-Patterns to Avoid

### Anti-Pattern 1: Modifying event-bridge.ts for Progress

**What people do:** Add progress event handling inside `createEventBridge()`.
**Why it's wrong:** The event bridge has a clean abstraction boundary -- it maps Claude API events 1:1 to pi events. Progress is synthetic (not from Claude API). Mixing synthetic and real events in the bridge makes it harder to reason about.
**Do this instead:** Handle progress in `provider.ts` by directly calling `stream.push()` for the synthetic text block, before the bridge handles real content blocks.

### Anti-Pattern 2: Forwarding All Sub-Agent Events to Pi

**What people do:** Remove the `isTopLevel` filter and forward everything.
**Why it's wrong:** Sub-agent events have their own `message_start`/`message_stop` lifecycle. Forwarding them to the event bridge would corrupt the bridge's block index tracking and interfere with break-early. The bridge assumes a single message lifecycle.
**Do this instead:** Extract only the progress information from sub-agent events (tool names, completion status) and inject it as synthetic progress text.

### Anti-Pattern 3: String-Matching Stderr for Error Detection

**What people do:** Parse stderr output with regex to detect "Prompt is too long" or "context limit".
**Why it's wrong:** Fragile, locale-dependent, and races with the structured NDJSON error messages that the CLI already provides.
**Do this instead:** Use the structured `assistant.error` and `result.subtype`/`result.is_error` fields. Stderr is a fallback already handled by the `proc.on("close")` handler for non-zero exit codes.

### Anti-Pattern 4: Holding Sub-Agent Events in a Buffer

**What people do:** Buffer all sub-agent events and replay them after the sub-agent finishes.
**Why it's wrong:** Defeats the purpose of real-time progress. Sub-agent execution can take minutes. The whole point is to show progress as it happens.
**Do this instead:** Emit progress text deltas as sub-agent events arrive, using a debounce to avoid flooding.

## Key Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `assistant` message type not actually emitted in `-p` mode with `--include-partial-messages` | LOW | Phase 2 error detection falls back to `result` + stderr | Test with real CLI. The `result` error path already exists as fallback. |
| Progress text block indices conflict with real content blocks | MEDIUM | Garbled output in pi | Close progress block before first top-level `content_block_start`. Integration test with realistic event sequences. |
| Sub-agent events arrive after top-level response starts (interleaved) | LOW | Progress appears mid-response text | The CLI processes sub-agents to completion before emitting the top-level response. Verify with real traces. |
| `result.subtype` values differ from documented SDK spec | LOW | Some errors not caught | Use `is_error` boolean as secondary check alongside `subtype !== "success"` |

## Sources

- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) -- CLI flags and output format options (HIGH confidence)
- [Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- StreamEvent reference, parent_tool_use_id, message flow (HIGH confidence)
- [Agent SDK Agent Loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop) -- Message types, ResultMessage subtypes, error handling, compaction (HIGH confidence)
- [Agent SDK Python Reference](https://platform.claude.com/docs/en/agent-sdk/python) -- AssistantMessageError type definition (HIGH confidence)
- [NDJSON Wire Protocol Spec (community gist)](https://gist.github.com/POWERFULMOVES/58bcadab9483bf5e633e865f131e6c25) -- Result subtypes, assistant error field (MEDIUM confidence)
- [pi Custom Provider Documentation](https://github.com/badlogic/pi-mono) -- AssistantMessageEventStream event types, stream pattern (HIGH confidence, verified in node_modules)
- Codebase verification of `provider.ts`, `event-bridge.ts`, `types.ts`, `stream-parser.ts` -- current architecture (HIGH confidence)

---
*Architecture research for: pi-claude-cli v0.4.0 observability integration*
*Researched: 2026-03-21*
