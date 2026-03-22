# Phase 8: Error Passthrough - Context

**Gathered:** 2026-03-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Surface all actionable CLI errors to the user instead of silently swallowing them. Users see clear, actionable error messages for every CLI failure mode: context overflow, subscription caps, rate limits, auth failures, billing errors, server errors. Pi's `isContextOverflow()` can detect context errors for auto-compaction. No recovery flows -- pass through errors and let pi/user decide what to do. Remove the inactivity timeout (no longer needed given `parent_tool_use_id` sub-agent event handling).

</domain>

<decisions>
## Implementation Decisions

### Error message content
- **D-01:** Pass through the CLI's own error message text verbatim -- do not rewrite, editorialize, or add category prefixes
- **D-02:** For `assistant`-type errors, use `message.content[].text` (e.g., "Prompt is too long") when available; fall back to the error category name (e.g., "invalid_request") only if no text content exists
- **D-03:** If the CLI provides retry timing or reset info, include it; do not invent guidance the CLI didn't provide

### Partial response + error
- **D-04:** Preserve partial streamed content when an error occurs mid-stream -- append the error, do not discard what the user already saw. `endStreamWithError()` already does this (checks `output.content?.length` and preserves existing content).

### Error delivery mechanism
- **D-05:** Keep the existing "done" event workaround for error delivery. The codebase comment documents why: pi's `agent-loop.js` calls `.content.filter()` on "error" events, crashing because a string has no `.content`. Switching to "error" events can be a separate future task independent of error detection.

### Inactivity timeout removal
- **D-06:** Remove the 180s inactivity timeout entirely. No timeout value is correct because CLI operations (Agent tool, sub-agents) can run for 30+ minutes. The `parent_tool_use_id` fix (commit ada9d3b) made the timeout effectively dormant during sub-agent work, but it should be removed rather than left as dead-but-armed code. Process lifecycle handlers (`proc.on("close")`, `proc.on("error")`, abort signal) are sufficient.
- **D-06a:** Background: User pushed back on the 10-min dynamic timeout approach during issue #8 debugging (session 774bbb14, 2026-03-21). The debug fix was reverted in favor of `parent_tool_use_id` scoping, but the base 180s timer was inadvertently left in place. PITFALLS.md incorrectly claims it was already removed -- correct this during implementation.

### Error format structure
- Claude's discretion: machine-readable prefixes, error category preservation, `isContextOverflow()` compatibility approach, downstream consumer considerations

### Claude's Discretion
- Error detection implementation across the three message paths (result `subtype !== "success"`, result `is_error: true`, assistant `error` field)
- How to ensure `isContextOverflow()` compatibility (error text must contain detectable patterns from pi's `OVERFLOW_PATTERNS`)
- Whether tool calls proposed before an error remain executable
- Visual distinction between partial content and appended error
- Edge case handling for mid-stream errors
- Correcting PITFALLS.md false claim about timeout removal

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Error handling (primary target)
- `src/provider.ts` -- Current error handling in `rl.on("line")` handler; `endStreamWithError()` function; `result` message branch at line ~273; inactivity timeout at lines 42, 161-171
- `src/types.ts` -- `ClaudeAssistantMessage`, `AssistantMessageError` type, expanded `ClaudeResultMessage` with `is_error` and error subtypes

### Milestone research (error specifications)
- `.planning/research/SUMMARY.md` -- Error passthrough architecture, research flags, gaps to address
- `.planning/research/FEATURES.md` -- Gap analysis (Gap 1: "Prompt is too long", Gap 2: subscription/rate limits, Gap 3: all other errors), wire protocol reference with exact JSON shapes
- `.planning/research/PITFALLS.md` -- Pitfall 5 (errors swallowed by narrow subtype check), Pitfall 6 (missing result event hang) -- NOTE: Pitfall 6 incorrectly claims the inactivity timeout was removed; it was not

### Debugging history (timeout removal context)
- `.planning/debug/internal-tool-timeout.md` -- Debug session for issue #8; documents the dynamic timeout approach that was reverted in favor of `parent_tool_use_id` scoping

### Pi integration (error delivery)
- `node_modules/@mariozechner/pi-ai/dist/utils/overflow.js` -- `isContextOverflow()` implementation, `OVERFLOW_PATTERNS` array (must ensure error text matches)
- `node_modules/@mariozechner/pi-ai/dist/types.d.ts` -- `AssistantMessageEvent` union type, event vocabulary

### Prior phase context
- `.planning/phases/07-type-foundation/07-CONTEXT.md` -- D-06: real-world wire protocol verification deferred to Phase 8

### Requirements
- `.planning/REQUIREMENTS.md` -- ERR-01 through ERR-06: specific error category requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `endStreamWithError()` in `provider.ts`: Existing error delivery mechanism using "done" event with text content block -- extend, don't replace
- `AssistantMessageError` type in `types.ts`: Error categories already defined (`invalid_request`, `rate_limit`, `authentication_failed`, `billing_error`, `server_error`, `unknown`)
- `ClaudeAssistantMessage` type in `types.ts`: Already in `NdjsonMessage` union with `error` field -- Phase 7 prerequisite satisfied
- `ClaudeResultMessage` in `types.ts`: Already includes `is_error`, `errors`, and expanded subtypes (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`)

### Established Patterns
- "done" event for errors (not "error" event): pi's agent-loop crashes on string error events -- this workaround is load-bearing (D-05)
- `broken` and `streamEnded` guards: All new code paths must check these before pushing to stream
- Single `rl.on("line")` listener with dispatch: Do not add separate listeners

### Integration Points
- `provider.ts` line ~273: `msg.type === "result"` branch -- currently only checks `subtype === "error"`, misses `is_error: true` and non-success subtypes
- `provider.ts` `rl.on("line")`: Needs new `else if (msg.type === "assistant")` branch for pre-API errors
- `isContextOverflow()`: Pattern-matches on error text strings -- error messages must contain detectable patterns

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond "pass through what the CLI gives us." Researcher must verify actual CLI error rendering for each category before implementation.

</specifics>

<deferred>
## Deferred Ideas

- **PROG-02 (API retry visibility):** `system/api_retry` events belong to Phase 9, not Phase 8. Phase 8 handles terminal errors only.
- **PROG-03 (Compact boundary notification):** `system/compact_boundary` events belong to Phase 9.
- **Switching to "error" events:** If pi ^0.52.0 now handles error events properly, the delivery mechanism could be updated. Independent of error detection -- separate future task.

</deferred>

---

*Phase: 08-error-passthrough*
*Context gathered: 2026-03-22*
