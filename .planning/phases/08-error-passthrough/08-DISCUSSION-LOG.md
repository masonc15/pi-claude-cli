# Phase 8: Error Passthrough - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md -- this log preserves the alternatives considered.

**Date:** 2026-03-22
**Phase:** 08-error-passthrough
**Areas discussed:** Error message content, Partial response + error, Error delivery mechanism, Safety timeout

---

## Error Message Content

| Option | Description | Selected |
|--------|-------------|----------|
| Verbatim passthrough | Pass through CLI's own error text unchanged. Use error category field for machine-readable classification. | ✓ |
| Category prefix + raw text | Prepend machine-readable prefix like [rate_limit] to raw error text | |
| Rewritten messages | Replace CLI text with our own actionable messages per error category | |

**User's choice:** Verbatim passthrough
**Notes:** Recommended because isContextOverflow() relies on pattern-matching the text, so altering it risks breaking auto-compaction.

### Follow-up: Assistant-type error text source

| Option | Description | Selected |
|--------|-------------|----------|
| Content text first, category fallback | Use message.content[].text when available; fall back to error category name if no text content | ✓ |
| Always use category name | Ignore message.content text, always pass the error category string | |
| Concatenate both | Show both: "invalid_request: Prompt is too long" | |

**User's choice:** Content text first, category fallback
**Notes:** None

---

## Partial Response + Error

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve partial + append error | Keep content user already saw, append the error. endStreamWithError() already does this. | ✓ |
| Discard partial, show error only | Replace everything with just the error message | |
| Separate blocks | Close partial content block, open new text block for error | |

**User's choice:** Preserve partial + append error
**Notes:** Matches existing endStreamWithError() behavior and user expectations.

---

## Error Delivery Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Keep "done" event workaround | Proven safe delivery via "done" event with error content. Switching to "error" events can be a separate future task. | ✓ |
| Investigate "error" events in Phase 8 | Test pi ^0.52.0 handling of "error" events first, switch if safe. Adds investigation scope. | |
| You decide | Claude picks based on what's simplest and safest during implementation | |

**User's choice:** Keep "done" event workaround
**Notes:** None

---

## Safety Timeout

**Extended discussion.** User challenged two assumptions from the research docs:

1. **The 180s inactivity timeout was NOT removed** -- PITFALLS.md and SUMMARY.md both incorrectly claim it was. The dynamic timeout approach from the debug session (issue #8) was reverted, but the base 180s timer remained in code.

2. **Missing result event (#1920)** -- User questioned whether this is a real issue. Research found it IS real (#8126: 39.6% failure rate), but the related process-hang issues (#21099, #25629) are separate and already handled by cleanupProcess(). The inactivity timeout covers the missing-result-event scenario since no output = timer fires.

**Session log recovered** from session 774bbb14 (2026-03-21, branch fix/internal-tool-timeout):
- Claude proposed 10-min dynamic timeout for internal tools
- User pushed back: "this is just kicking the can down the road, not actually solving it? like, even just this debugger took longer than 10m"
- Claude agreed and pivoted to parent_tool_use_id approach
- User asked "is the timeout stuff fully removed?" -- Claude said dynamic changes were reverted but 180s stayed
- The 180s timer was inadvertently left in the codebase

| Option | Description | Selected |
|--------|-------------|----------|
| Remove inactivity timeout | No timeout value is correct for arbitrarily long operations. Process lifecycle handlers are sufficient. | ✓ |
| Rely on inactivity timeout | Existing 180s covers most cases | |
| Add wall-clock timeout | Add max-request-duration cap as backstop | |

**User's choice:** Remove inactivity timeout
**Notes:** User's position from the original debugging session: no timeout value is correct because operations can run for 30+ minutes. Existing process handlers (close, error, abort signal) are sufficient.

---

## Claude's Discretion

- Error detection implementation across three message paths
- isContextOverflow() compatibility
- PITFALLS.md correction

## Deferred Ideas

- Switching from "done" to "error" events (future task)
- API retry visibility (Phase 9)
- Compact boundary notification (Phase 9)
