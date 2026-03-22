# Feature Landscape: v0.4.0 Observability

**Domain:** Sub-agent progress visibility and error passthrough for Claude CLI subprocess bridge
**Researched:** 2026-03-21
**Milestone context:** Adding observability to an existing working v0.3.1 codebase (7,991 LOC, 292+ tests)

## Table Stakes

Features users expect from an LLM subprocess wrapper that runs Claude Code internally. Missing = users confused about what's happening or unable to recover from errors.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Sub-agent activity indication | When Claude uses internal tools (Read, Bash, Grep, Agent, etc.), the user sees nothing but "Working..." for potentially minutes. Every modern CLI tool shows what it's doing. Users will think the process is hung | Medium | Claude CLI emits `stream_event` messages with `parent_tool_use_id` set for sub-agent work. Currently filtered out at provider.ts line 238-239. These events include `content_block_start` with `tool_use` type showing which tool is running, plus text deltas from the sub-agent's reasoning |
| Actionable CLI error passthrough | When the CLI encounters any actionable error — context limits, subscription usage caps (5-hour window maxed), rate limits, auth failures, billing errors — the current code either swallows them or shows opaque errors. Users need to know WHY to take corrective action. The CLI surfaces typed errors via `assistant.error` field (`"invalid_request"`, `"rate_limit"`, `"authentication_failed"`, `"billing_error"`, `"server_error"`) and `result` messages with `is_error: true`. All need clear, categorized user-facing messages | Low | Multiple error shapes: (1) pre-API rejection: `{"type":"assistant","error":"invalid_request"}` for context overflow, (2) subscription/rate limit: `{"type":"assistant","error":"rate_limit"}` for 5-hour window caps, (3) API-level errors in `result` messages with various subtypes. Each error type needs a specific, actionable message |
| API retry visibility | When the API rate-limits or has transient errors, Claude CLI emits `system/api_retry` events with attempt count, max retries, delay, and error category. Without surfacing these, users see unexplained pauses | Low | The CLI emits `{"type":"system","subtype":"api_retry","attempt":N,"max_retries":M,"retry_delay_ms":D,"error":"rate_limit",...}`. Currently these are parsed as `ClaudeSystemMessage` but not acted upon. Easy to surface as text status updates |
| README/install documentation | Users cannot discover or install the extension. npm package exists but no install instructions. Table stakes for any published package | Low | Issue #3. Straightforward documentation task. No code complexity |

## Differentiators

Features that go beyond "not broken" into genuinely useful observability. Not expected in a v0.4 point release, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Structured tool activity display | Instead of just "Working...", show "[Reading src/auth.ts]" or "[Running npm test]" -- extract the tool name and key argument from sub-agent `content_block_start` events | Medium | Requires parsing `content_block_start` events where `parent_tool_use_id` is set, extracting tool name and first argument. The tool name comes from `event.content_block.name` (e.g., "Read", "Bash", "Grep"). Key argument extraction varies by tool. High user value -- similar to Claude Code's own TUI which shows tool activity |
| Sub-agent text streaming | Show the sub-agent's text output (reasoning, summaries) to the user, not just tool indicators. When Claude spawns an Agent sub-agent, its text deltas contain useful progress information | High | Sub-agent `text_delta` events carry reasoning text. However, mixing this into pi's `AssistantMessageEventStream` is architecturally tricky -- pi expects a single linear stream of content blocks. Would need to either (a) inject as a separate text block that gets cleaned up, (b) use pi's status/progress mechanism if one exists, or (c) emit as `text_delta` events on a dedicated sub-agent channel. Needs pi API investigation |
| Context usage warnings | Proactively warn users when context usage approaches limits, before hitting the hard error. Show "Context: 75% used" style indicators | Medium | Claude CLI emits `usage` data in `message_start` and `message_delta` events. Could track cumulative input tokens across turns and warn at thresholds. However, the CLI's own auto-compaction means the context window management is partially handled upstream. Useful mainly for awareness, not for action |
| Compact boundary notification | When the CLI auto-compacts the conversation (summarizes old history to free context), inform the user. This affects conversation quality and explains potential "forgetfulness" | Low | Claude CLI emits `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":N}}`. Currently parsed as `ClaudeSystemMessage` but not surfaced. Simple to detect and emit a user-facing note |
| Task progress tracking | For background tasks (Bash commands, Agent sub-agents), show progress updates with duration and token consumption | Medium | Claude SDK defines `SDKTaskProgressMessage` with `task_id`, `description`, `usage`, `tool_use_id`, and `last_tool_name`. The CLI emits these periodically for running background tasks. Would need new message type handling in the NDJSON parser and a way to surface to the user |

## Anti-Features

Features to explicitly NOT build in v0.4.0. Tempting but wrong scope or wrong approach.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Full sub-agent message bridging to pi | Trying to bridge every sub-agent event into pi's `AssistantMessageEventStream` as first-class content blocks breaks the linear content model. Sub-agents can have their own tool calls, thinking blocks, and text -- nesting these creates an exponentially complex event bridge | Surface sub-agent activity as lightweight status text (tool names, progress indicators). Keep the event bridge focused on top-level events only. Sub-agent detail goes to status display, not content blocks |
| Custom error recovery flows | Auto-retrying on context limit, auto-compacting, or restarting with a fresh session. These are user decisions, not extension decisions | Pass through clear, actionable error messages. "Context limit exceeded (185K/200K tokens). Start a new conversation or reduce context." Let the user decide |
| Persistent subprocess for observability | Keeping the subprocess alive between requests to monitor ongoing activity. Breaks the stateless break-early architecture that v1.0 validated | Work within the current stateless model. Each request observes its own subprocess's events. Cross-request observability is not needed at this stage |
| Interactive progress UI (spinners, progress bars) | pi extensions don't have direct terminal access. The extension communicates through `AssistantMessageEventStream` events, not stdout | Use pi's event model: text events for status messages, or investigate if pi has a status/notification channel. Keep progress information within the existing event contract |
| Sub-agent tool result capture | Capturing the results of tools that sub-agents execute (file contents, command output) and surfacing them. This is a massive amount of data and the user didn't ask for it | Only surface the tool NAME and key arguments (what's happening), not tool RESULTS (what came back). The sub-agent processes results internally; the user sees Claude's final answer |

## Feature Dependencies

```
Actionable CLI Error Passthrough (#2)
  |-> Detect `result` message with `is_error: true` or non-success subtype
  |-> Detect `assistant` message with `error` field (invalid_request, rate_limit, billing_error, auth, etc.)
  |-> Detect `system/api_retry` events for early warning
  |-> Map each error category to clear, actionable user-facing message
  |-> Covers: context limits, subscription caps (5-hr window), rate limits, auth failures, billing errors
  |-> Emit via endStreamWithError (existing mechanism)
  (No dependencies on other new features)

Sub-Agent Progress Display (#12)
  |-> Parse sub-agent events (parent_tool_use_id !== null)
  |     |-> Already parsed by stream-parser.ts (parseLine returns any NDJSON object)
  |     |-> Currently filtered out at provider.ts line 238-239
  |-> Extract tool activity from sub-agent content_block_start events
  |-> Surface activity to user
  |     |-> OPTION A: Inject synthetic text_delta events (least pi changes)
  |     |-> OPTION B: Use existing text block with status prefix (medium)
  |     |-> OPTION C: Find/create pi status channel (most correct, most work)
  |-> Depends on: understanding pi's event contract for non-content status

README Update (#3)
  (No code dependencies -- documentation only)

API Retry Visibility (bonus)
  |-> Detect system/api_retry messages (already parsed as ClaudeSystemMessage)
  |-> Extract attempt, max_retries, retry_delay_ms, error category
  |-> Surface via same mechanism as sub-agent progress
  (Depends on: whichever display mechanism chosen for #12)
```

**Critical path:** Actionable error passthrough (#2) is independent and should go first -- lowest complexity, highest user-facing impact, covers context limits AND subscription caps AND all other CLI error categories. Sub-agent progress (#12) is the meatiest feature and needs a display mechanism decision. README (#3) is independent of both.

## Implementation Analysis

### Actionable CLI Error Passthrough (#2)

**Where errors currently go:** The `rl.on("line")` handler in provider.ts processes three NDJSON message types:
1. `stream_event` -- forwarded to event bridge (or filtered if sub-agent)
2. `control_request` -- handled by control-handler.ts
3. `result` -- if `subtype === "error"`, calls `endStreamWithError(msg.error)`. If success, cleans up.

**Gap 1 -- "Prompt is too long" path:** The CLI emits TWO messages for this error:
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"Prompt is too long"}],"error":"invalid_request"}}
{"type":"result","subtype":"success","is_error":true,"result":"Prompt is too long"}
```
The `result` has `subtype: "success"` (not "error"), so the current code hits the success path and calls `cleanupProcess` without surfacing the error. The `is_error: true` field is never checked.

**Gap 2 -- Subscription/rate limit errors:** When the 5-hour subscription window is maxed out, the CLI surfaces this as `"rate_limit"` via the `assistant.error` field. Currently not handled at all since `assistant` messages are ignored.

**Gap 3 -- All other actionable errors:** Auth failures (`"authentication_failed"`), billing errors (`"billing_error"`), and server errors (`"server_error"`) all surface via the same `assistant.error` field. None are currently detected.

**Fix complexity:** Low. Add `is_error` check to the `result` handler. Add `assistant` message handler branch. Map each `error` category to a clear, actionable user-facing string.

**Confidence:** 90% -- The error format is documented in GitHub issues with exact JSON. The fix is a few conditionals in provider.ts.

### Sub-Agent Progress Display (#12)

**Current state:** Sub-agent events are already being parsed correctly by `parseLine()` -- they come through as `{"type":"stream_event","event":{...},"parent_tool_use_id":"toolu_xyz"}`. The filtering happens in provider.ts:
```typescript
const isTopLevel = !(msg as any).parent_tool_use_id;
if (isTopLevel) {
    bridge.handleEvent(msg.event);
}
```

**What sub-agent events look like in practice:**
- `content_block_start` with `content_block.type === "tool_use"` and `content_block.name === "Read"` (or Bash, Grep, etc.)
- `content_block_delta` with `delta.type === "text_delta"` containing the sub-agent's reasoning
- `content_block_delta` with `delta.type === "input_json_delta"` containing tool arguments
- `message_start`, `message_delta`, `message_stop` for the sub-agent's message lifecycle

**Display mechanism options:**

**Option A: Synthetic text events (recommended for v0.4)**
Inject status text into the existing stream as `text_delta` events. When a sub-agent tool starts, emit something like `\n[Reading src/auth.ts...]\n`. When it stops, optionally emit `[done]\n`.

Pros: Works within pi's existing event model. No pi changes needed. User sees activity in real-time.
Cons: Mixes status text with Claude's actual response. Could confuse downstream consumers that expect only LLM-generated text. Need to strip or mark these as synthetic somehow.

**Option B: Prefix in a dedicated text block**
Start a new `text_start` content block for status, emit status deltas, then `text_end` before the real content arrives.

Pros: Cleaner separation. Status is its own content block.
Cons: Adds content blocks that aren't part of Claude's actual response. May confuse pi's content tracking.

**Option C: Use pi's error/info mechanism via endStreamWithError-style approach**
Not viable -- error events end the stream.

**Recommended approach:** Option A with a status prefix pattern (e.g., `[Claude: Reading src/auth.ts]\n`). This is the minimum viable approach that works within pi's event contract. The status text becomes part of Claude's visible output, which is actually desirable -- users want to SEE what's happening.

**Key implementation details:**
- Only surface `content_block_start` events with `type === "tool_use"` from sub-agents (tool activity)
- Extract tool name and primary argument (e.g., file path for Read, command for Bash, pattern for Grep)
- Throttle: don't emit a status line for every single sub-agent event, just tool starts
- Ignore sub-agent `text_delta` events (too verbose, mixes reasoning with output)

**Confidence:** 80% -- The sub-agent event format is documented and confirmed by the TypeScript SDK types. The display mechanism choice needs validation against pi's actual rendering behavior. May need to test whether injected text deltas render correctly in pi's TUI.

### README Update (#3)

Straightforward documentation. Include:
- What the extension does (one paragraph)
- Prerequisites (Claude CLI installed, authenticated)
- Installation (`npm install -g pi-claude-cli` or pi's extension mechanism)
- Configuration options (if any)
- Known limitations

**Confidence:** 95%

## Complexity Assessment

| Feature | Estimated Effort | Risk Level | Notes |
|---------|-----------------|------------|-------|
| Context limit error passthrough (#2) | 0.5-1 day | Low | Add `is_error` check + assistant error detection in provider.ts. A few conditionals, clear error formatting. Low risk because the error paths are already partially handled |
| Sub-agent progress display (#12) | 2-3 days | Medium | Main risk is the display mechanism -- how to inject status into pi's stream without breaking downstream consumers. Needs investigation of pi's rendering behavior. The NDJSON parsing is already working |
| README update (#3) | 0.5 day | Low | Pure documentation. No code risk |
| API retry visibility (bonus) | 0.5 day | Low | Simple message type detection, same display mechanism as #12 |
| Compact boundary notification (bonus) | 0.5 day | Low | Same pattern as API retry -- detect system message subtype, surface to user |

**Total estimate:** 3.5-5 days for all three milestone features, plus 1 day for bonus observability items.

## Wire Protocol Reference

### NDJSON Message Types (relevant to observability)

**Top-level stream events** (currently handled):
```json
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}
```

**Sub-agent stream events** (currently filtered -- need for #12):
```json
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_xyz","name":"Read","input":{}}},"parent_tool_use_id":"toolu_parent123"}
```

**System messages** (currently parsed but not acted upon):
```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"retry_delay_ms":5000,"error_status":429,"error":"rate_limit","uuid":"...","session_id":"..."}
{"type":"system","subtype":"compact_boundary","uuid":"...","session_id":"...","compact_metadata":{"trigger":"auto","pre_tokens":150000}}
```

**Error: Prompt too long** (need for #2):
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"Prompt is too long"}],"error":"invalid_request"}}
{"type":"result","subtype":"success","is_error":true,"duration_ms":1024,"duration_api_ms":0,"num_turns":1,"result":"Prompt is too long"}
```

**Error: API context limit** (need for #2):
```json
{"type":"result","subtype":"error","error":"input length and `max_tokens` exceed context limit: 197202 + 21333 > 200000"}
```

**Result message with error** (need for #2 -- the `is_error` field):
```json
{"type":"result","subtype":"success","is_error":true,"result":"Error message here","duration_ms":N}
```

### Types That Need Updating

The current `NdjsonMessage` union in types.ts covers `stream_event`, `result`, `system`, and `control_request`. For observability features:

1. **`ClaudeResultMessage`** -- Add `is_error?: boolean` field (currently missing)
2. **`ClaudeSystemMessage`** -- Add specific subtypes: `"api_retry"`, `"compact_boundary"` (currently generic `subtype: string`)
3. **New type: `ClaudeAssistantMessage`** -- For the `{"type":"assistant",...}` messages with `error` field (not currently in the union)

## MVP Recommendation

Prioritize (in build order):

1. **Context limit error passthrough (#2)** -- Lowest complexity, highest immediate user value. Users currently get opaque failures on long conversations. Fix requires adding `is_error` detection to the result handler, plus a new `assistant` message type handler. Independent of other features.

2. **Sub-agent progress display (#12)** -- Highest complexity, highest long-term user value. Start with Option A (synthetic text events) as the display mechanism. Implement for tool starts only (not text deltas). Can be refined in future versions.

3. **README update (#3)** -- Can be done in parallel with either of the above. No code dependency.

Defer to v0.5.0 or later:
- **Full sub-agent text streaming**: Too complex for this milestone, needs pi API investigation for proper status channels
- **Context usage percentage display**: Nice-to-have, auto-compaction partially handles this
- **Task progress tracking**: Background tasks are rare in the break-early architecture

## Sources

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) - CLI flags, streaming flags, verbose output - HIGH confidence
- [Claude Code headless/SDK mode docs](https://code.claude.com/docs/en/headless) - stream-json format, api_retry event schema, system message types - HIGH confidence
- [Agent SDK streaming output docs](https://platform.claude.com/docs/en/agent-sdk/streaming-output) - StreamEvent reference, parent_tool_use_id, message flow, known limitations - HIGH confidence
- [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript) - Complete SDKMessage union type, all message type definitions including SDKTaskProgressMessage, SDKCompactBoundaryMessage - HIGH confidence
- [Agent SDK agent loop docs](https://platform.claude.com/docs/en/agent-sdk/agent-loop) - Context window management, auto-compaction, ResultMessage subtypes - HIGH confidence
- [GitHub Issue #12312: Prompt too long error format](https://github.com/anthropics/claude-code/issues/12312) - Exact JSON output for context limit errors - HIGH confidence
- [GitHub Issue #6559: Context limit exceeded](https://github.com/anthropics/claude-code/issues/6559) - API-level context error format with token counts - MEDIUM confidence
- [GitHub Issue #27916: Subagent count in status line](https://github.com/anthropics/claude-code/issues/27916) - Community confirmation that sub-agent visibility is a gap - MEDIUM confidence
- [GitHub Issue #24594: Undocumented stream-json format](https://github.com/anthropics/claude-code/issues/24594) - Confirms gaps in official documentation of NDJSON message types - MEDIUM confidence
- Existing codebase analysis: provider.ts, event-bridge.ts, types.ts, stream-parser.ts - Direct code inspection - HIGH confidence
