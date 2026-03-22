# Phase 8: Error Passthrough - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Surface all actionable CLI errors to the user instead of silently swallowing them. Users see clear, actionable error messages for every CLI failure mode: context overflow, subscription caps, rate limits, auth failures, billing errors, server errors. Pi's `isContextOverflow()` can detect context errors for auto-compaction. No recovery flows — pass through errors and let pi/user decide what to do.

</domain>

<decisions>
## Implementation Decisions

### Error message content
- **D-01:** Pass through the CLI's own error message text — do not rewrite or editorialize
- **D-02:** If the CLI provides retry timing or reset info, include it; do not invent guidance the CLI didn't provide
- **D-03:** Match Claude Code's tone — system-level error reporting, not conversational

### Research required before locking message format
- **D-R1:** Researcher MUST investigate how Claude Code's TUI renders each error category to users (context overflow, rate limit, subscription cap, auth failure, billing, server error)
- **D-R2:** Researcher MUST determine whether rate limit / subscription cap messages include reset timing or retry delay info in the message content
- **D-R3:** Researcher MUST capture the exact text content in `assistant.message.content` for each error type to know what we're passing through

### Partial response + error
- **D-04:** Preserve partial streamed content when an error occurs mid-stream — append the error, do not discard what the user already saw

### Error format structure
- Claude's discretion: machine-readable prefixes, error category preservation, `isContextOverflow()` compatibility approach, downstream consumer considerations

### Claude's Discretion
- Error format structure (prefixes, structured categories, pattern matching)
- How to ensure `isContextOverflow()` compatibility
- Whether tool calls proposed before an error remain executable
- Visual distinction between partial content and appended error
- Edge case handling for mid-stream errors

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Error handling (primary target)
- `src/provider.ts` -- Current error handling in `rl.on("line")` handler; `endStreamWithError()` function; `result` message branch at line ~273
- `src/types.ts` -- `ClaudeAssistantMessage`, `AssistantMessageError` type, expanded `ClaudeResultMessage` with `is_error` and error subtypes

### Milestone research (error specifications)
- `.planning/research/SUMMARY.md` -- Error passthrough architecture, research flags, gaps to address
- `.planning/research/FEATURES.md` -- Gap analysis (Gap 1: "Prompt is too long", Gap 2: subscription/rate limits, Gap 3: all other errors), wire protocol reference with exact JSON shapes
- `.planning/research/PITFALLS.md` -- Pitfall 5 (errors swallowed by narrow subtype check), Pitfall 6 (missing result event hang)
- `.planning/research/ARCHITECTURE.md` -- Integration points, `rl.on("line")` handler structure

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
- "done" event for errors (not "error" event): pi's agent-loop crashes on string error events -- this workaround is load-bearing
- `broken` and `streamEnded` guards: All new code paths must check these before pushing to stream
- Single `rl.on("line")` listener with dispatch: Do not add separate listeners

### Integration Points
- `provider.ts` line ~273: `msg.type === "result"` branch -- currently only checks `subtype === "error"`, misses `is_error: true` and non-success subtypes
- `provider.ts` `rl.on("line")`: Needs new `else if (msg.type === "assistant")` branch for pre-API errors
- `isContextOverflow()`: Pattern-matches on error text strings -- error messages must contain detectable patterns

</code_context>

<specifics>
## Specific Ideas

No specific requirements beyond "do what Claude Code does" -- researcher must investigate Claude Code's actual error rendering before implementation decisions are finalized.

</specifics>

<deferred>
## Deferred Ideas

- **PROG-02 (API retry visibility):** `system/api_retry` events belong to Phase 9, not Phase 8. Phase 8 handles terminal errors only.
- **PROG-03 (Compact boundary notification):** `system/compact_boundary` events belong to Phase 9.
- **Wall-clock safety timeout for missing result event:** Pitfall 6 identified this risk. May be addressed in Phase 8 or Phase 9 -- planner decides based on research findings.

</deferred>

---

*Phase: 08-error-passthrough*
*Context gathered: 2026-03-21*
