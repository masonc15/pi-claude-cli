# Roadmap: pi-claude-cli

## Milestones

- **v1.0 MVP** -- Phases 1-6 (shipped 2026-03-21) -- [archive](milestones/v1.0-ROADMAP.md)
- **v0.4.0 Observability** -- Phases 7-10 (active)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-6) -- SHIPPED 2026-03-21</summary>

- [x] Phase 1: Core Subprocess Bridge (3/3 plans) -- completed 2026-03-14
- [x] Phase 2: Tool Handling (2/2 plans) -- completed 2026-03-14
- [x] Phase 3: Extended Thinking and Usage (2/2 plans) -- completed 2026-03-14
- [x] Phase 4: Custom Tool MCP Proxy (2/2 plans) -- completed 2026-03-15
- [x] Phase 5: Platform Hardening (2/2 plans) -- completed 2026-03-15
- [x] Phase 6: Testing and Release Pipeline (2/2 plans) -- completed 2026-03-15

</details>

### v0.4.0 Observability (Phases 7-10)

- [ ] **Phase 7: Type Foundation** - Update NDJSON type definitions to match actual CLI wire protocol (prerequisite for all code phases)
- [ ] **Phase 8: Error Passthrough** - Surface all actionable CLI errors to the user instead of silently swallowing them
- [ ] **Phase 9: Sub-Agent Progress** - Show real-time sub-agent tool activity during internal execution
- [ ] **Phase 10: Documentation** - README with install instructions, prerequisites, and known limitations

## Phase Details

### Phase 7: Type Foundation
**Goal**: NDJSON type definitions accurately represent every message shape the CLI emits, preventing type-cast hacks in subsequent phases
**Depends on**: Nothing (first phase of v0.4.0)
**Requirements**: None (infrastructure prerequisite -- enables ERR and PROG phases)
**Success Criteria** (what must be TRUE):
  1. `ClaudeAssistantMessage` type exists in the `NdjsonMessage` union and covers all error category fields (`error.type`, `error.message`)
  2. `ClaudeStreamEventMessage` includes `parent_tool_use_id` for distinguishing sub-agent events from top-level events
  3. `ClaudeResultMessage` subtypes include `error_during_execution`, `error_max_turns`, and `error_max_budget_usd` in addition to the existing `success` and `error`
  4. `ClaudeResultMessage` includes `is_error` and `errors` fields for the "success with error" edge case
  5. All new types compile cleanly with zero `as any` casts needed by consuming code

**Plans**: TBD

### Phase 8: Error Passthrough
**Goal**: Users see clear, actionable error messages for every CLI failure mode instead of opaque "stream ended" or silent hangs
**Depends on**: Phase 7
**Requirements**: ERR-01, ERR-02, ERR-03, ERR-04, ERR-05, ERR-06
**Success Criteria** (what must be TRUE):
  1. When a conversation exceeds the context window, the user sees an error message containing the overflow reason, and pi's `isContextOverflow()` can detect it for auto-compaction
  2. When the subscription usage cap (5-hour window) is reached, the user sees an error identifying the cap and when it resets
  3. When rate limited, the user sees an error with retry guidance rather than a silent failure
  4. When CLI authentication has expired, the user sees an error directing them to re-authenticate via `claude` CLI
  5. When any other CLI error occurs (server errors, max turns, billing), the user sees the error category and message rather than a generic failure

**Plans**: TBD

### Phase 9: Sub-Agent Progress
**Goal**: Users see which tool a sub-agent is actively using during internal execution instead of staring at "Working..." for minutes
**Depends on**: Phase 7
**Requirements**: PROG-01, PROG-02, PROG-03
**Success Criteria** (what must be TRUE):
  1. During internal tool execution, the user sees status text indicating which tool the sub-agent is using (e.g., "[Reading src/provider.ts]") instead of only "Working..."
  2. When the CLI retries an API call due to a transient error, the user sees the retry attempt number and delay information
  3. When the CLI auto-compacts the conversation history, the user sees a notification explaining the compaction occurred
  4. Sub-agent events never trigger the break-early kill mechanism (regression safety)

**Plans**: TBD

### Phase 10: Documentation
**Goal**: New users can discover, install, and configure the extension from the README alone
**Depends on**: Nothing (independent of all code phases)
**Requirements**: DOC-01
**Success Criteria** (what must be TRUE):
  1. README contains clear pi install instructions (npm install command and pi activation)
  2. README lists prerequisites (Claude CLI installed and authenticated, pi version compatibility)
  3. README documents known limitations (custom tool result replay, Windows find tool issue)

**Plans**: TBD

## Progress

**Execution Order:**
Phases 7 -> 8 -> 9 -> 10
Note: Phase 10 is independent and can execute in parallel with any phase.
Phase 8 and Phase 9 both depend on Phase 7 but are independent of each other.
Recommended serial order: 7 -> 8 -> 9 (error plumbing validates assistant message path before progress work).

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|---------------|--------|-----------|
| 1. Core Subprocess Bridge | v1.0 | 3/3 | Complete | 2026-03-14 |
| 2. Tool Handling | v1.0 | 2/2 | Complete | 2026-03-14 |
| 3. Extended Thinking and Usage | v1.0 | 2/2 | Complete | 2026-03-14 |
| 4. Custom Tool MCP Proxy | v1.0 | 2/2 | Complete | 2026-03-15 |
| 5. Platform Hardening | v1.0 | 2/2 | Complete | 2026-03-15 |
| 6. Testing and Release Pipeline | v1.0 | 2/2 | Complete | 2026-03-15 |
| 7. Type Foundation | v0.4.0 | 0/? | Not started | - |
| 8. Error Passthrough | v0.4.0 | 0/? | Not started | - |
| 9. Sub-Agent Progress | v0.4.0 | 0/? | Not started | - |
| 10. Documentation | v0.4.0 | 0/? | Not started | - |
