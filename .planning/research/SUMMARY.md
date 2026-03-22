# Project Research Summary

**Project:** pi-claude-cli v0.4.0 Observability
**Domain:** NDJSON stream event handling — sub-agent progress visibility and error passthrough for Claude CLI subprocess bridge
**Researched:** 2026-03-21
**Confidence:** HIGH

## Executive Summary

The v0.4.0 milestone adds observability to an already-working subprocess bridge (v0.3.1, 7,991 LOC, 292+ tests). The work scope is deliberately narrow: surface information that the Claude CLI already emits but that `provider.ts` currently discards. No new dependencies are needed. Both core features (#12 sub-agent progress, #2 actionable CLI error passthrough) are achievable by adding handler branches to the existing `rl.on("line")` callback in `provider.ts`, updating type definitions in `types.ts`, and creating one new file (`subagent-tracker.ts`). Every other file in the codebase stays unchanged.

The recommended approach for sub-agent progress (#12) is to inject synthetic progress text into pi's `AssistantMessageEventStream` as a pre-response text block: open a text block when the first sub-agent event arrives, emit tool-name status lines as deltas, and close the block before the first top-level `content_block_start` arrives. This works within pi's existing event contract with no pi-side changes. Actionable CLI error passthrough (#2) requires widening the existing `result` error check from `subtype === "error"` to `subtype !== "success"`, adding an `assistant` message handler for all error categories (`invalid_request`, `rate_limit`, `authentication_failed`, `billing_error`, `server_error` — covering context limits, subscription caps, auth failures, etc.), and ensuring errors are emitted in a form that enables pi's built-in `isContextOverflow()` detection.

The primary risks are architectural rather than algorithmic. Sub-agent events must never reach the break-early mechanism — that guard must stay exclusively in the `isTopLevel` branch. Progress text injected into pi's stream must not pollute `AssistantMessage.content`, which would corrupt conversation history on subsequent turns. Both risks have clear prevention strategies and can be verified with the existing test infrastructure.

## Key Findings

### Recommended Stack

The existing stack is complete and validated. Zero new dependencies are required for v0.4.0. All needed capabilities — sub-agent event parsing, pi event stream APIs, overflow detection — are already present in `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, and Node.js built-ins. The peer dependency versions (`^0.52.0`) have been verified to export `isContextOverflow()` and the full `AssistantMessageEvent` union type. No version bumps are needed.

**Core technologies (unchanged from v0.3.1):**
- `cross-spawn ^7.0.6`: Cross-platform subprocess spawn — shipped and working
- `node:readline` (built-in): NDJSON line splitting — shipped and working
- `@mariozechner/pi-ai ^0.52.0`: Provider API, event stream types, `isContextOverflow()` — peer dep, working
- `@mariozechner/pi-coding-agent ^0.52.0`: Agent loop, auto-compaction — peer dep, working
- TypeScript `^5.7` / Vitest `^3.0`: Type checking and tests — dev deps, working

### Expected Features

The milestone targets three issues from the backlog. FEATURES.md establishes the following priority ordering based on complexity and user-facing impact.

**Must have (table stakes for v0.4.0):**
- Sub-agent activity indication (#12) — users see "Working..." for 30-180 seconds with no signal; every modern CLI tool shows what it's doing
- Actionable CLI error passthrough (#2) — long conversations produce opaque failures; users need to know WHY to take corrective action
- README/install documentation (#3) — package is published but undiscoverable; table stakes for any npm package

**Should have (differentiators, target v0.4.x):**
- API retry visibility — surface `system/api_retry` events with attempt count and delay; low complexity, same display mechanism as #12
- Compact boundary notification — surface `system/compact_boundary` events to explain apparent "forgetfulness"

**Defer to v0.5.0+:**
- Full sub-agent text streaming — architecturally complex; mixes sub-agent reasoning into a single linear stream that pi does not expect to be nested
- Context usage percentage display — CLI auto-compaction partially handles this; not actionable enough to warrant the effort now
- Task progress tracking (`SDKTaskProgressMessage`) — rare in the break-early architecture; over-engineering for v0.4

### Architecture Approach

Both features integrate into the existing stream processing pipeline as additive changes. The `rl.on("line")` handler in `provider.ts` is the single integration point. For sub-agent progress, a new `else` branch handles events where `parent_tool_use_id` is truthy, delegating to a new `subagent-tracker.ts` component that emits synthetic text blocks to the pi stream. For error passthrough, two changes are needed: a new `else if (msg.type === "assistant")` branch to catch `invalid_request` errors, and a widened `result` handler that catches all non-success subtypes. `event-bridge.ts`, `stream-parser.ts`, and `process-manager.ts` are untouched.

**Major components and their v0.4.0 changes:**
1. `provider.ts` — orchestrates subprocess and routes NDJSON; receives two new handler branches
2. `types.ts` — type definitions; gets `ClaudeAssistantMessage`, updated `ClaudeResultMessage` subtypes, `parent_tool_use_id` on `ClaudeStreamEventMessage`
3. `subagent-tracker.ts` (new) — tracks active sub-agent tools, debounces progress, emits synthetic text blocks to pi stream
4. `event-bridge.ts` — unchanged; progress bypasses the bridge entirely
5. `README.md` — documentation update for issue #3

### Critical Pitfalls

1. **Sub-agent events triggering break-early kill** — The break-early mechanism (`sawBuiltInOrCustomTool`, `message_stop` kill) must stay strictly inside the `isTopLevel` guard. The new sub-agent handler must be a separate `else` branch, never a peer of the break-early logic. Regression test: a sub-agent `message_stop` must not kill the subprocess.

2. **Progress text corrupting conversation history** — Injecting `text_delta` events for sub-agent status causes pi to accumulate them into `AssistantMessage.content`, which is saved to conversation history. Claude then sees its own fake status messages in the next turn. Before implementing, verify whether pi's `stream.push()` accepts custom event types that the UI renders but the content accumulator ignores. If not, a dedicated bracketed text block closed before the real response is the safest approach.

3. **Readline buffered lines firing after `rl.close()`** — A documented Node.js behavior (nodejs/node#22615). Every new code path in the `rl.on("line")` handler must check `if (broken) return` at the top. Any sub-agent handler extracted into a separate function needs explicit access to the guard.

4. **Actionable CLI errors swallowed by narrow subtype check** — The current check `msg.subtype === "error"` misses `"error_during_execution"`, `"error_max_turns"`, and the `subtype: "success" + is_error: true` pattern used for "Prompt is too long." Additionally, `assistant` messages with `error` field (covering subscription caps, rate limits, auth failures, billing errors) are completely ignored. Fix: change to `msg.subtype !== "success"`, add `is_error === true` check, and add `assistant` message handler for all error categories.

5. **Missing `result` event causing infinite hang** — A known upstream CLI bug (anthropics/claude-code#1920). The previous 180-second inactivity timeout was removed in favor of `parent_tool_use_id` checks to avoid break-early on sub-agents, so there is currently no timeout safety net. A wall-clock cap should be considered as a backstop.

## Implications for Roadmap

Based on combined research, three implementation phases are recommended. All three are additive to the codebase with no destructive changes.

### Phase 1: Type Foundation
**Rationale:** All subsequent work depends on accurate types. Updating `types.ts` is zero-risk and purely additive. Doing this first prevents type errors from masking logic bugs in later phases.
**Delivers:** Correctly typed NDJSON message union that matches the actual CLI wire protocol.
**Addresses:** Prerequisite for both #12 and #2.
**Avoids:** Type-cast proliferation (`msg as any`) that hides errors during development.

Specific changes:
- Add `ClaudeAssistantMessage` to the `NdjsonMessage` union
- Add `parent_tool_use_id` to `ClaudeStreamEventMessage`
- Expand `ClaudeResultMessage.subtype` to include `"error_during_execution"`, `"error_max_turns"`, `"error_max_budget_usd"`
- Add `is_error?: boolean` and `errors?: string[]` to `ClaudeResultMessage`

### Phase 2: Actionable CLI Error Passthrough (#2)
**Rationale:** Lowest implementation complexity, highest immediate user value, and fully independent of the progress work. Establishes the correct error plumbing and validates that `assistant` messages appear in the real CLI output before the more complex progress work begins.
**Delivers:** Actionable, categorized error messages for all CLI error types — context overflow, subscription usage caps (5-hour window), rate limits, auth failures, billing errors, server errors. Pi's `isContextOverflow()` can fire and trigger auto-compaction for context errors.
**Implements:** New `assistant` message handler branch with full error category mapping, fixed `result` error detection, `formatAssistantError()` utility.
**Avoids:** Pitfall 5 (actionable errors swallowed) and Pitfall 6 (hang on missing result) from PITFALLS.md.
**Estimated effort:** 0.5-1 day, low risk.

Key decision before coding: Verify whether emitting `{ type: "error", reason: "error", error: AssistantMessage }` (with `stopReason: "error"` and `errorMessage` set) causes pi's agent loop to crash. The existing codebase has a comment documenting a workaround using `done` instead of `error` events. If the crash is still present in `^0.52.0`, set `errorMessage` on the `AssistantMessage` in a `done` event — sufficient for `isContextOverflow()` to detect overflow.

### Phase 3: Sub-Agent Progress Display (#12)
**Rationale:** Most complex feature, but error plumbing from Phase 2 reduces risk by validating the `assistant` message path and cleanup flows first. Start with tool-name-only progress (synthetic text block) as the display mechanism.
**Delivers:** Real-time sub-agent tool activity visible to the user. "Working..." becomes "[Reading src/provider.ts...]" etc.
**Implements:** `subagent-tracker.ts` (new), integration in `provider.ts` `else` branch, synthetic text block lifecycle management.
**Avoids:** Pitfall 1 (break-early corruption), Pitfall 2 (readline buffer race), Pitfall 3 (sub-agent text in response content) from PITFALLS.md.
**Estimated effort:** 2-3 days, medium risk.

Critical investigation before implementation: Capture a real sub-agent NDJSON event stream. The CLI emits `user`, `assistant`, and `tool_result` message types during sub-agent execution, not just `stream_event`. The tracker design depends on the actual message types observed. Also test with `--effort max` to verify stream events are not suppressed under extended thinking.

### Phase 4: README Update (#3)
**Rationale:** Independent of all code changes, can be done in parallel with any phase.
**Delivers:** Discoverable, installable npm package. Description, prerequisites, install command, known limitations.
**Estimated effort:** 0.5 day, no risk.

### Bonus Observability Items (v0.4.x, after milestone)
- **API retry visibility:** Detect `system/api_retry` messages and surface via same display mechanism as Phase 3. 0.5 day effort.
- **Compact boundary notification:** Detect `system/compact_boundary` and emit a user note. 0.5 day. Same pattern.

### Phase Ordering Rationale

- Phase 1 before everything: type accuracy prevents silent `as any` bugs in both subsequent phases
- Phase 2 before Phase 3: validates the `assistant` message path in production; establishes error plumbing that Phase 3 must not break; lower risk means faster feedback
- Phase 3 last: most complexity; benefits from Phase 2 confirming the `broken` guard and cleanup paths work correctly end-to-end
- Phase 4 independent: no code deps, can be reviewed and merged separately at any time

### Research Flags

Phases needing investigation before or during implementation:
- **Phase 2:** Verify whether pi `^0.52.0` handles `{ type: "error", reason: "error", error: AssistantMessage }` without crashing the agent loop. The existing codebase has a workaround implying it was broken at some prior version. Must test before switching to `error` event type.
- **Phase 3:** Capture a real sub-agent NDJSON event trace before writing the tracker (all message types, not just `stream_event`). Also test with `--effort max` to verify stream events are not suppressed under extended thinking. Test `stream.push()` with a custom event type against pi's actual implementation before committing to the display mechanism.

Phases with standard patterns (no research needed):
- **Phase 1:** Type definition updates are mechanical — match actual CLI output against current `types.ts` definitions.
- **Phase 4:** Documentation writing.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new deps confirmed. Integration points verified in `node_modules` and codebase directly. Version compatibility table verified. |
| Features | HIGH | Wire protocol for all three error shapes documented from GitHub issues with exact JSON. Sub-agent event format verified from Agent SDK TypeScript types. |
| Architecture | HIGH | All changes verified in current `provider.ts` source. Line numbers cited. Integration points explicit. Anti-patterns explained with root cause. |
| Pitfalls | HIGH | Critical pitfalls backed by upstream bug reports (anthropics/claude-code#1920, nodejs/node#22615). Recovery strategies provided for all 8 pitfalls. |

**Overall confidence:** HIGH

### Gaps to Address

Two items require validation during implementation before the implementation approach is locked:

- **Pi `error` event handling (Phase 2):** The codebase comment says pi's agent loop crashes on `error` events because it calls `.content.filter()` on the event payload. The type definition now shows `error: AssistantMessage` (not `string`), suggesting this may have been fixed in `^0.52.0`. Must test with actual pi before switching from the `done`-event workaround. If still broken, set `errorMessage` on the `AssistantMessage` in the `done` event — sufficient for `isContextOverflow()`.

- **Sub-agent NDJSON message types in production (Phase 3):** PITFALLS.md warns that the CLI emits `user`, `assistant`, and `tool_result` types during sub-agent execution, not just `stream_event`. The tracker design must account for this. Capture a real event trace with a task that invokes the Agent tool before writing `subagent-tracker.ts`.

## Sources

### Primary (HIGH confidence)
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) — CLI flags, `--stream-json` format
- [Agent SDK Streaming Output](https://platform.claude.com/docs/en/agent-sdk/streaming-output) — `StreamEvent` type, `parent_tool_use_id`, message flow, thinking limitation
- [Agent SDK Agent Loop](https://platform.claude.com/docs/en/agent-sdk/agent-loop) — `ResultMessage` subtypes, error handling, compaction
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — Complete `SDKMessage` union type
- `@mariozechner/pi-ai/dist/types.d.ts` (local, node_modules) — `AssistantMessageEvent` union type, definitive event vocabulary
- `@mariozechner/pi-ai/dist/utils/overflow.js` (local, node_modules) — `isContextOverflow()` implementation, `OVERFLOW_PATTERNS` array
- Codebase: `src/provider.ts`, `src/event-bridge.ts`, `src/types.ts`, `src/stream-parser.ts` — direct inspection

### Secondary (MEDIUM confidence)
- [GitHub Issue #12312](https://github.com/anthropics/claude-code/issues/12312) — Exact JSON for "Prompt is too long" error
- [GitHub Issue #6559](https://github.com/anthropics/claude-code/issues/6559) — API-level context error format with token counts
- [GitHub Issue #27916](https://github.com/anthropics/claude-code/issues/27916) — Community confirmation of sub-agent visibility gap
- [NDJSON Wire Protocol community gist](https://gist.github.com/POWERFULMOVES/58bcadab9483bf5e633e865f131e6c25) — Result subtypes, assistant error field

### Tertiary (LOW confidence — needs production validation)
- [GitHub Issue #24594](https://github.com/anthropics/claude-code/issues/24594) — Gaps in official stream-json documentation; confirms some fields are undocumented

---
*Research completed: 2026-03-21*
*Ready for roadmap: yes*
