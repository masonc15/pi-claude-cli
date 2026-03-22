# Requirements: pi-claude-cli v0.4.0 Observability

**Defined:** 2026-03-21
**Core Value:** Enable pi users to leverage their Claude Pro/Max subscription as the LLM backend — no API key, no separate billing, full Claude model access through the official CLI.

## v0.4.0 Requirements

Requirements for this milestone. Each maps to roadmap phases.

### Error Handling

- [ ] **ERR-01**: User sees a clear, actionable error message when the conversation exceeds the context window limit
- [ ] **ERR-02**: User sees a clear error message when the subscription usage cap (5-hour window) is reached
- [ ] **ERR-03**: User sees a clear error message when rate limited by the API
- [ ] **ERR-04**: User sees a clear error message when CLI authentication has expired or failed
- [ ] **ERR-05**: User sees a clear error message when a billing or subscription error occurs
- [ ] **ERR-06**: User sees a clear error message for any other CLI error (server errors, max turns, etc.)

### Progress

- [ ] **PROG-01**: User sees which tool a sub-agent is using during internal execution (e.g., "[Reading src/provider.ts]")
- [ ] **PROG-02**: User sees API retry attempts with delay information when transient errors occur
- [ ] **PROG-03**: User is notified when the CLI auto-compacts the conversation history

### Documentation

- [ ] **DOC-01**: README contains pi install instructions, prerequisites, and known limitations

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Observability

- **OBS-01**: User sees sub-agent text streaming (reasoning output) during internal execution
- **OBS-02**: User sees context usage percentage as conversations grow
- **OBS-03**: User sees task progress tracking for background sub-agent operations

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Full sub-agent message bridging | Breaks pi's linear content model; exponential complexity |
| Custom error recovery flows (auto-retry, auto-compact) | User decisions, not extension decisions |
| Persistent subprocess for cross-request observability | Breaks validated stateless break-early architecture |
| Interactive progress UI (spinners, progress bars) | pi extensions communicate via event stream, not stdout |
| Sub-agent tool result capture | Massive data volume; user sees Claude's final answer |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ERR-01 | — | Pending |
| ERR-02 | — | Pending |
| ERR-03 | — | Pending |
| ERR-04 | — | Pending |
| ERR-05 | — | Pending |
| ERR-06 | — | Pending |
| PROG-01 | — | Pending |
| PROG-02 | — | Pending |
| PROG-03 | — | Pending |
| DOC-01 | — | Pending |

**Coverage:**
- v0.4.0 requirements: 10 total
- Mapped to phases: 0
- Unmapped: 10 ⚠️

---
*Requirements defined: 2026-03-21*
*Last updated: 2026-03-21 after initial definition*
