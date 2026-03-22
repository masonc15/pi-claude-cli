# Pitfalls Research

**Domain:** Adding observability (sub-agent progress, error passthrough) to existing Claude CLI subprocess bridge
**Researched:** 2026-03-21
**Confidence:** HIGH (based on codebase analysis, Claude CLI docs, known Node.js behaviors, and upstream bug reports)

## Critical Pitfalls

### Pitfall 1: Sub-Agent Events Break the Break-Early Guard

**What goes wrong:**
When forwarding sub-agent events (those with `parent_tool_use_id` set), the progress handler accidentally triggers the break-early mechanism. Sub-agent `message_stop` events or sub-agent `content_block_start` with `type: "tool_use"` get treated as top-level events, causing the subprocess to be killed mid-operation. The user sees a partial response and the sub-agent work is lost.

**Why it happens:**
The current code in `provider.ts` filters sub-agent events using `!(msg as any).parent_tool_use_id` on the raw NDJSON message. When adding progress forwarding, the developer needs to both forward the event AND maintain the existing filter on break-early logic. It is easy to restructure the `if (isTopLevel)` block to forward sub-agent events and accidentally move the `sawBuiltInOrCustomTool = true` or `message_stop` handling outside the top-level guard.

**How to avoid:**
- Keep the break-early decision logic (`sawBuiltInOrCustomTool`, `message_stop` kill) strictly inside the existing `isTopLevel` guard. Never move it.
- Create a separate code path for sub-agent progress forwarding that runs AFTER the break-early check, not inside it.
- The pattern should be: `if (isTopLevel) { /* existing break-early logic */ } else if (parentToolUseId) { /* new progress forwarding */ }`.
- Write a regression test that sends a sub-agent `message_stop` event and verifies the subprocess is NOT killed.

**Warning signs:**
- Tests that use sub-agent tool_use blocks start killing the subprocess unexpectedly.
- The extension works for simple text responses but crashes/truncates when Claude uses Agent/Task/Skill internally.
- `broken` flag gets set during sub-agent execution, causing remaining lines to be silently dropped.

**Phase to address:**
Phase 1 (Sub-Agent Progress) -- this is the core risk of the entire feature.

---

### Pitfall 2: Readline Buffered Lines Fire After rl.close()

**What goes wrong:**
After the subprocess is killed (break-early) or `rl.close()` is called on the result message, buffered lines in Node.js readline's internal buffer continue to fire `'line'` events. If the progress handler pushes events to the pi stream after `stream.end()` has been called, it throws an "write after end" error or corrupts the stream state.

**Why it happens:**
This is a documented Node.js behavior (nodejs/node#22615). Calling `rl.close()` does not synchronously stop `'line'` events from firing. Lines already buffered internally will still emit. The existing codebase has a `broken` guard flag for this exact reason, but adding new event handlers for sub-agent progress creates a second code path that may not check the guard.

**How to avoid:**
- Every new code path added to the `rl.on('line')` handler MUST check `if (broken) return;` at the top. The existing guard covers the main handler, but if you extract progress handling into a separate function, that function needs access to the guard.
- Also check `streamEnded` before pushing any event to the pi stream from progress handlers.
- Do NOT add separate `rl.on('line')` listeners. Keep a single listener and dispatch from there. Multiple listeners multiply the race window.

**Warning signs:**
- Intermittent "write after end" errors in test runs or production.
- Events appearing in the stream after the `done` event.
- Errors that only reproduce under load or with long sub-agent tool chains (more buffered lines).

**Phase to address:**
Phase 1 (Sub-Agent Progress) -- must be handled in the same PR that adds progress forwarding.

---

### Pitfall 3: Confusing Sub-Agent Text Content with Top-Level Response

**What goes wrong:**
Sub-agent events include `content_block_start` with `type: "text"` and `content_block_delta` with `type: "text_delta"` that look identical to top-level text blocks. If sub-agent text deltas are forwarded to pi's event bridge as regular text, they get appended to the assistant message content, corrupting the response. The user sees internal sub-agent reasoning mixed into the visible response.

**Why it happens:**
The `parent_tool_use_id` field is on the outer NDJSON wrapper (`ClaudeStreamEventMessage`), not on the inner `event` object. When extracting just `msg.event` and passing it to the event bridge, the parent context is lost. The event bridge has no way to distinguish sub-agent text from top-level text because it only receives `ClaudeApiEvent` objects.

**How to avoid:**
- NEVER forward sub-agent events through the existing `bridge.handleEvent()`. The event bridge accumulates content into `output.content`, which becomes the `AssistantMessage` returned to pi. Sub-agent content must not contaminate this.
- Create a separate progress rendering path that converts sub-agent events into status text (e.g., "Reading src/provider.ts...") and emits them through a different channel.
- If pi's stream API supports a status/progress event type, use that. If not, emit periodic `text_delta` events with status prefixes that are clearly distinguishable (but see Pitfall 4 for why this is risky).

**Warning signs:**
- Test assertions on `output.content` start failing because sub-agent text appears in the output.
- Users see "Let me read the file..." or internal Claude reasoning text in the response.
- The `content.length` of the returned message grows unexpectedly.

**Phase to address:**
Phase 1 (Sub-Agent Progress) -- architectural decision needed before any implementation.

---

### Pitfall 4: Injecting Progress Text into Pi's Stream Contract Violation

**What goes wrong:**
To show sub-agent progress, the developer emits `text_delta` events with status text (e.g., "[Agent: reading file...]") into pi's `AssistantMessageEventStream`. This violates pi's stream contract: `text_delta` events are expected to be parts of the actual assistant response. Pi accumulates them into the message content, displays them as the response, and saves them to conversation history. On the next turn, Claude sees its own fake status messages in the history and gets confused.

**Why it happens:**
Pi's `AssistantMessageEventStream` has a limited event vocabulary: `start`, `text_start`, `text_delta`, `text_end`, `thinking_start/delta/end`, `toolcall_start/delta/end`, `done`, `error`. There is no `progress` or `status` event type. The temptation is to abuse `text_delta` since it is the only way to send visible text to the user.

**How to avoid:**
- Check pi-ai's `AssistantMessageEventStream` source for any undocumented event types or metadata fields that could carry progress info without polluting the message content. Specifically check if `stream.push()` accepts arbitrary event objects that the UI can render.
- If pi supports custom event types that the UI ignores gracefully (pass-through), use a custom `{ type: "progress", text: "..." }` event. Verify this does not crash pi's event consumer.
- If no clean path exists, consider writing progress to `console.log` / `console.warn` rather than the stream. GSD and pi both render console output. This is the safest fallback.
- The absolute worst approach is injecting fake text_delta events. This will corrupt conversation history.

**Warning signs:**
- Sub-agent status text appears in conversation history on subsequent turns.
- Claude starts referencing "[Agent: reading file...]" in its responses.
- The `AssistantMessage.content` contains status text mixed with real response text.

**Phase to address:**
Phase 1 (Sub-Agent Progress) -- must investigate pi's stream API before choosing approach.

---

### Pitfall 5: Actionable CLI Errors Swallowed by Catch-All Error Handler

**What goes wrong:**
When the Claude CLI encounters any actionable error — context window limits, subscription usage caps (5-hour window maxed out), rate limits, auth failures, billing errors — the current `endStreamWithError()` wraps all errors into a generic `Error: <message>` text block. Pi has no way to distinguish error types and cannot take appropriate action (e.g., trigger history compaction for context overflow, suggest waiting for rate limits, or advise re-auth for auth failures).

**Why it happens:**
The current error handling is intentionally generic -- all errors become text content in a "done" event (not "error" events, because pi's agent-loop crashes on string error events). This was a pragmatic decision for v1.0 but means error categorization is lost.

**How to avoid:**
- Parse the `assistant.error` field and `result` message for known error categories. The CLI surfaces these as typed error strings:
  - `"invalid_request"` — context limit exceeded ("Prompt is too long"), or other API validation errors
  - `"rate_limit"` — API rate limit or subscription usage cap (5-hour window maxed out)
  - `"authentication_failed"` — CLI auth expired or invalid
  - `"billing_error"` — subscription lapsed or usage cap exceeded
  - `"server_error"` — transient API failures
- Surface each error category with a specific, actionable message so downstream consumers (pi/GSD) can pattern-match and handle appropriately.
- Do NOT try to implement recovery flows (compaction, retry, re-auth). The project constraint is to pass through clear, categorized error messages and let pi/user handle them.
- Also detect the `system` message with `subtype: "api_retry"` — these retry events precede final errors and provide early warning.

**Warning signs:**
- Users report "Unknown error from Claude CLI" when conversations get long or subscriptions max out.
- The same error handling fires for context limits, subscription caps, and auth failures, making debugging impossible.
- Pi's error handler receives generic text and cannot offer targeted advice.

**Phase to address:**
Phase 2 (Error Passthrough) -- separate from progress work.

---

### Pitfall 6: Missing Result Event Causes Infinite Hang

**What goes wrong:**
The Claude CLI intermittently fails to emit the final `{"type":"result",...}` event after tool execution in stream-json mode (documented in anthropics/claude-code#1920). The subprocess stays alive, stdout stays open, readline never closes, and the promise in `provider.ts` (`await new Promise<void>(resolve => rl.on('close', resolve))`) never resolves. The pi request hangs indefinitely.

**Why it happens:**
This is a known upstream bug. The CLI sometimes completes tool execution but does not emit the result event. The current code relies on the `result` message to trigger `cleanupProcess()` and `rl.close()`. Without it, there is no safety net since the previous 180-second inactivity timeout was removed in favor of using `parent_tool_use_id` checks to avoid break-early on sub-agent events.

**How to avoid:**
- Consider re-introducing a safety timeout: maximum wall-clock time per request (e.g., 10 minutes) that fires regardless of activity, as a backstop for this upstream bug.
- Ensure process cleanup paths handle this case gracefully — if the subprocess exits without a result event, the `proc.on("close")` handler should still clean up and end the stream.

**Warning signs:**
- Orphaned `claude` processes in task manager after pi operations.
- `rl.on('close')` promise never resolving in certain edge cases.
- Requests that hang indefinitely with no timeout.

**Phase to address:**
Phase 2 (Error Passthrough) -- consider adding a wall-clock safety timeout alongside error categorization.

---

### Pitfall 7: Sub-Agent Events Have Different NDJSON Wrapper Structure

**What goes wrong:**
The developer assumes sub-agent events have the same NDJSON wrapper structure as top-level events (`{ type: "stream_event", event: { ... } }`) and just differ by having `parent_tool_use_id` set. In reality, the CLI may emit additional message types during sub-agent execution: `{ type: "user" }` (tool results being fed back to sub-agent), `{ type: "assistant" }` (complete sub-agent messages), and `{ type: "tool_result" }` messages. These are not `stream_event` wrappers and won't be parsed by the existing `msg.type === "stream_event"` check.

**Why it happens:**
The official docs describe `parent_tool_use_id` on `stream_event` messages, but the CLI also emits non-streaming messages during sub-agent turns. Issue #12 notes the CLI emits "system, stream_event, direct, tool_result, and user message types during sub-agent execution." The existing parser silently ignores unknown types, so these just vanish.

**How to avoid:**
- Before implementing progress, add debug logging that prints ALL NDJSON message types received during a sub-agent operation. Run a real test where Claude uses Agent/Task internally and capture the complete event stream.
- Design the progress handler to extract useful information from multiple message types, not just `stream_event`. A `{ type: "assistant", message: { content: [...] } }` might contain tool_use blocks that are useful for progress display.
- Add the non-stream_event types to the `NdjsonMessage` union type in `types.ts`.

**Warning signs:**
- Progress handler only shows partial information (misses tool results, only shows text deltas).
- Debug logging reveals message types you are not handling.
- Sub-agent operations that involve many tool calls show less progress than expected.

**Phase to address:**
Phase 1 (Sub-Agent Progress) -- investigate actual wire format before implementation.

---

### Pitfall 8: Extended Thinking Suppresses StreamEvent Messages

**What goes wrong:**
When extended thinking is enabled (via `--effort` flag), the Agent SDK documentation states that `StreamEvent` messages may not be emitted. The user enables thinking (e.g., reasoning: "high"), and suddenly sub-agent progress stops working entirely because no `stream_event` messages arrive. The user sees the old "Working..." silence.

**Why it happens:**
The Agent SDK docs explicitly warn: "when you explicitly set max_thinking_tokens, StreamEvent messages are not emitted." The CLI uses `--effort` not `--max-thinking-tokens`, but the underlying behavior may be similar. The CLI's `--effort` flag maps to thinking configuration internally, and the streaming suppression may apply.

**How to avoid:**
- Test progress handling with ALL effort levels: omitted (default), low, medium, high, max.
- If StreamEvent messages are suppressed with extended thinking, the progress feature needs a fallback. Non-stream_event messages (type: "assistant", type: "user") may still be emitted and can be used as a degraded progress signal.
- Document the limitation clearly: "Progress visibility may be reduced when extended thinking is enabled."
- Do not silently fail -- at minimum, log a warning when thinking is enabled and no progress events are observed after a timeout.

**Warning signs:**
- Progress works in tests without thinking but fails in production where users enable reasoning.
- The event stream contains only `system` init + final `result` with no `stream_event` between them.
- All tests pass but users with Opus models (which commonly use high effort) report no progress.

**Phase to address:**
Phase 1 (Sub-Agent Progress) -- test matrix must include thinking-enabled scenarios.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Using `console.log` for progress instead of stream events | Works immediately, no pi API investigation needed | Progress not visible in GSD's structured output; output mixed with debug noise; cannot be themed/styled | As an interim step for Phase 1 if pi stream API investigation is inconclusive; must be replaced |
| Hardcoding error message patterns for context limit detection | Quick to implement, covers the known cases | New CLI versions may change error messages; regex patterns rot; false positives on similar text | Acceptable for v0.4.0 as the CLI error format is currently stable; add a fallback for unrecognized errors |
| Forwarding raw sub-agent tool names without mapping | Simpler code, avoids maintaining a second mapping layer | Users see internal Claude names (TodoRead, ToolSearch) instead of meaningful descriptions | Never -- always translate to user-friendly descriptions ("Searching...", "Reading file...") |
| Resetting inactivity timer on all NDJSON lines including sub-agent events | Simple, one-line change | A stuck CLI that is emitting sub-agent events but never completing will never timeout | N/A — inactivity timeout was removed; use wall-clock cap instead if re-introducing a safety timeout |

## Integration Gotchas

Common mistakes when connecting to the Claude CLI subprocess and pi's stream API.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Claude CLI stream-json | Assuming all events during sub-agent execution are `stream_event` type | The CLI emits `user`, `assistant`, `tool_result`, and `direct` messages during sub-agent turns. Handle or explicitly skip each type. |
| Claude CLI stream-json | Not handling `system` messages with `subtype: "api_retry"` | These indicate retryable errors (rate limit, server error) and precede the actual error. Surface them as progress ("Retrying in 5s...") or at minimum log them. |
| Pi AssistantMessageEventStream | Pushing events after `stream.end()` has been called | Causes "write after end" errors. Always check `streamEnded` and `broken` guards before pushing. |
| Pi AssistantMessageEventStream | Assuming pi ignores unknown event types | Pi may throw on unrecognized event types, or may pass them through silently. Must test with pi's actual implementation before relying on custom event types. |
| Process cleanup on error | Calling `endStreamWithError()` but forgetting to also `clearTimeout(inactivityTimer)` and `forceKillProcess(proc)` | Errors from sub-agent progress handling must follow the same cleanup path as the existing error handlers. Centralize cleanup. |
| Windows subprocess | Assuming SIGKILL works identically on Windows | Node.js translates SIGKILL to `TerminateProcess()` on Windows, which does work. But stderr may not flush before termination, losing error context. Add a brief grace period before kill. |

## Performance Traps

Patterns that work at small scale but fail with heavy sub-agent usage.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Accumulating all sub-agent events in memory | Memory grows linearly with sub-agent event count; long Agent/Task operations generate thousands of events | Only track the latest N events or latest state per sub-agent; discard old events | When Claude uses Agent tool for large codebase analysis (hundreds of file reads) |
| Emitting a pi stream event for every sub-agent NDJSON line | Pi's stream consumer processes each event synchronously; flooding it degrades UI responsiveness | Debounce/throttle progress updates (e.g., max 1 update per 500ms per sub-agent) | When sub-agent emits rapid-fire text_delta events during code generation |
| String concatenation for progress messages | Building status strings on every event | Only build status text when actually emitting (after debounce) | Thousands of sub-agent events per request |

## UX Pitfalls

Common user experience mistakes when surfacing sub-agent progress.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Showing raw internal tool names (ToolSearch, TodoRead, Agent) | Users don't understand Claude's internal tool vocabulary | Map to user-friendly descriptions: "Searching codebase...", "Reading file: path", "Delegating to sub-agent..." |
| Showing every single sub-agent tool call | Information overload; screen fills with progress spam | Show summarized progress: tool name + target file, not full arguments. Throttle updates. |
| Not indicating when sub-agent work starts and ends | User doesn't know if progress output is the response or intermediate | Clear visual bracketing: "[Working: reading 3 files...]" with a completion indicator |
| Showing sub-agent thinking/reasoning text | Confusing internal reasoning mixed with progress | Filter out thinking content blocks from sub-agent events entirely |
| No progress for long-running sub-agent operations that have no stream events | User sees nothing for 30+ seconds, thinks it's frozen | Emit a heartbeat message if no sub-agent events arrive within N seconds: "Still working..." |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Sub-agent progress:** Often missing handling for sub-agent `message_stop` -- verify it does NOT trigger break-early kill
- [ ] **Sub-agent progress:** Often missing handling for nested sub-agents (Agent calling Agent) -- `parent_tool_use_id` may chain. Verify progress works for depth > 1
- [ ] **Error passthrough:** Often missing the `system/api_retry` events that precede errors -- verify retry events are surfaced or at least logged
- [ ] **Error passthrough:** Often missing stderr parsing -- the CLI sometimes writes errors to stderr without a corresponding result event. Verify stderr is checked on non-zero exit
- [ ] **Error passthrough:** Often missing the "Prompt is too long" error case -- this is a CLI-level rejection (input_tokens: 0) distinct from API errors. Verify it is detected and surfaced.
- [ ] **Progress + break-early:** The `broken` guard prevents sub-agent events from being processed after break-early. Verify progress handler respects the guard.
- [ ] **Progress + inactivity timeout:** Sub-agent events should reset the inactivity timer. Verify the timer reset is in the right place (before the sub-agent filter, not inside it).
- [ ] **Thinking + progress:** Test progress with `--effort high` and `--effort max` to verify stream events are still emitted. Document any degradation.

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Sub-agent events trigger break-early | LOW | Revert the progress changes and re-add with the correct guard structure. No data loss -- the user just gets a truncated response. |
| Progress text corrupts AssistantMessage content | MEDIUM | Must clean up conversation history if corrupted messages were saved. Add a content filter to strip progress text patterns on the next turn. |
| Context limit error not detected | LOW | Users retry manually. Improve pattern matching for the specific error. No lasting damage. |
| Missing result event causes hang | LOW | Inactivity timeout eventually fires (180s). Reduce timeout if needed. Add wall-clock cap. |
| Extended thinking suppresses progress | LOW | Graceful degradation -- user sees "Working..." as before. Document the limitation. |
| Readline buffer race corrupts stream | MEDIUM | Hard to reproduce. Add defensive guards, audit all event push paths. Existing test suite may not catch it; need integration tests with real subprocess output. |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Sub-agent events break break-early | Phase 1 (Progress) | Regression test: sub-agent message_stop does NOT kill subprocess |
| Readline buffered lines after close | Phase 1 (Progress) | Test: send events after rl.close(), verify no "write after end" errors |
| Sub-agent text mixed into response | Phase 1 (Progress) | Test: output.content contains zero sub-agent text after a sub-agent operation |
| Progress text violates stream contract | Phase 1 (Progress) | Investigation: test pi's stream.push() with custom event types before implementing |
| Context limit errors swallowed | Phase 2 (Error Passthrough) | Test: simulate "Prompt is too long" result message, verify classified error output |
| Missing result event hang | Phase 2 (Error Passthrough) | Test: simulate no result event, verify inactivity timeout fires and is classified |
| Sub-agent NDJSON wrapper structure | Phase 1 (Progress) | Investigation: capture real sub-agent event stream, document all message types |
| Extended thinking suppresses events | Phase 1 (Progress) | Manual test: run with --effort max, verify progress events arrive (or document limitation) |

## Sources

- [Claude Code headless/CLI docs](https://code.claude.com/docs/en/headless) -- stream-json format, api_retry events, result message structure
- [Agent SDK streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) -- parent_tool_use_id, StreamEvent reference, thinking limitation
- [Missing result event bug (anthropics/claude-code#1920)](https://github.com/anthropics/claude-code/issues/1920) -- CLI fails to emit result event intermittently
- [Stream-json input hang (anthropics/claude-code#3187)](https://github.com/anthropics/claude-code/issues/3187) -- Windows-specific stdin hang after second turn
- [Prompt too long error (anthropics/claude-code#12312)](https://github.com/anthropics/claude-code/issues/12312) -- CLI rejects prompts below model context limit
- [Node.js readline line-after-close (nodejs/node#22615)](https://github.com/nodejs/node/issues/22615) -- buffered lines fire after rl.close()
- [Node.js stdout not flushed on exit (nodejs/node#2972)](https://github.com/nodejs/node/issues/2972) -- stderr may be truncated on process kill
- Project codebase: `src/provider.ts`, `src/event-bridge.ts`, `src/stream-parser.ts`, `src/types.ts`
- Project memory: `feedback_control_request_never_fires.md`, `project_phase4_status.md`, `feedback_jiti_for_await.md`

---
*Pitfalls research for: v0.4.0 Observability milestone (sub-agent progress + error passthrough)*
*Researched: 2026-03-21*
