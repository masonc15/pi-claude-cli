---
phase: 07-type-foundation
plan: 01
subsystem: types
tags: [typescript, discriminated-union, ndjson, wire-protocol, type-safety]

# Dependency graph
requires: []
provides:
  - "ClaudeAssistantMessage type for assistant messages with error categories"
  - "Expanded ClaudeResultMessage with 5 subtypes, is_error, errors fields"
  - "ClaudeStreamEventMessage with parent_tool_use_id for sub-agent discrimination"
  - "Cast-free consuming code in provider.ts and event-bridge.ts"
affects: [08-error-passthrough, 09-sub-agent-progress]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional index on tracked blocks (delete without cast)"
    - "AssistantMessageError string literal union for error categories"

key-files:
  created: []
  modified:
    - "src/types.ts"
    - "src/provider.ts"
    - "src/event-bridge.ts"
    - "tests/stream-parser.test.ts"

key-decisions:
  - "Made TrackedToolBlock.index optional alongside TrackedContentBlock.index for uniform delete support"
  - "Used 'as Record<string, any>' instead of 'as any' for event-bridge.ts:336 finalArgs cast (documents pi runtime string handling)"
  - "as any count reduced to 2 (both pi-ai stream push boundary, out of scope) vs plan's expected 3"

patterns-established:
  - "ClaudeAssistantMessage follows existing discriminated union pattern with type: 'assistant' literal"
  - "Wire protocol optional fields use ?: syntax consistently"

requirements-completed: []

# Metrics
duration: 7min
completed: 2026-03-22
---

# Phase 7 Plan 1: Type Foundation Summary

**NDJSON type definitions expanded with ClaudeAssistantMessage, 5 result subtypes, parent_tool_use_id, and 4 as-any casts replaced with proper type narrowing**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-22T03:14:07Z
- **Completed:** 2026-03-22T03:21:39Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Added ClaudeAssistantMessage interface with AssistantMessageError type alias (6 error categories) to NdjsonMessage union
- Expanded ClaudeResultMessage.subtype to 5 string literals and added is_error, errors, total_cost_usd, usage, duration_ms, duration_api_ms, num_turns fields
- Expanded ClaudeStreamEventMessage with parent_tool_use_id, uuid, session_id fields
- Made TrackedContentBlock.index and TrackedToolBlock.index optional for cast-free delete
- Replaced 4 as-any casts in provider.ts and event-bridge.ts with proper type narrowing
- Added 6 new test cases for new message types (302 total tests passing)

## Task Commits

Each task was committed atomically:

1. **Task 1: Define new and updated NDJSON types + add test cases**
   - `c2e10af` (test: add failing tests for new NDJSON message types - RED)
   - `163fd78` (feat: add ClaudeAssistantMessage and expand NDJSON type definitions - GREEN)
2. **Task 2: Replace as-any casts in consuming code** - `3670df5` (refactor)

_Note: Task 1 used TDD flow (RED commit then GREEN commit). A lint-staged fix (`a7575d3`) was also committed as deviation._

## Files Created/Modified
- `src/types.ts` - Added ClaudeAssistantMessage, AssistantMessageError, expanded ClaudeStreamEventMessage, ClaudeResultMessage, made TrackedContentBlock.index optional, updated NdjsonMessage union
- `src/provider.ts` - Removed `(msg as any).parent_tool_use_id` cast (line 238)
- `src/event-bridge.ts` - Replaced 3 as-any casts with proper type narrowing, made TrackedToolBlock.index optional
- `tests/stream-parser.test.ts` - Added 6 test cases for assistant message, expanded result subtypes, parent_tool_use_id
- `.husky/pre-commit` - Added --no-stash flag for git 2.17 compatibility (deviation)

## Decisions Made
- Made TrackedToolBlock.index optional (not just TrackedContentBlock) so that `delete block.index` works without cast for all block types in handleContentBlockStop
- Used `finalArgs as Record<string, any>` instead of `as any` on event-bridge.ts line 336 -- more precise cast that documents the pi runtime string-arguments behavior
- Discovered that stream-parser.ts:36 uses `as NdjsonMessage` (not `as any`), so actual remaining as-any count is 2 (both pi-ai boundary), not 3 as plan estimated

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added --no-stash to lint-staged pre-commit hook**
- **Found during:** Task 1 (TDD RED commit)
- **Issue:** lint-staged v16 stash backup requires git >= 2.35, but environment has git 2.17.1 causing "Needed a single revision" error on every commit
- **Fix:** Changed `.husky/pre-commit` from `npx lint-staged` to `npx lint-staged --no-stash`
- **Files modified:** .husky/pre-commit
- **Verification:** All subsequent commits succeeded with lint and format checks still running
- **Committed in:** a7575d3

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Essential for committing any code. No scope creep. Lint and format checks still run.

## Issues Encountered
- Plan's as-any inventory listed stream-parser.ts:36 as `as any` but it is actually `as NdjsonMessage` -- this means the final as-any count is 2 (both pi-ai stream push) rather than the expected 3. This is a positive deviation (fewer casts than expected).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Type foundation is complete: all NDJSON message shapes accurately defined
- Phase 8 (Error Passthrough) can now access ClaudeAssistantMessage.error, ClaudeResultMessage.is_error, and ClaudeResultMessage.errors without any type casts
- Phase 9 (Sub-Agent Progress) can now use ClaudeStreamEventMessage.parent_tool_use_id to discriminate sub-agent events

## Self-Check: PASSED

- All 5 key files verified on disk
- All 4 task commits verified in git history (c2e10af, a7575d3, 163fd78, 3670df5)

---
*Phase: 07-type-foundation*
*Completed: 2026-03-22*
