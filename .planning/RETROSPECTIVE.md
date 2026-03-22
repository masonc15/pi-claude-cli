# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — MVP

**Shipped:** 2026-03-21
**Phases:** 6 | **Plans:** 13 | **Timeline:** 9 days

### What Was Built
- Full subprocess bridge routing pi LLM calls through Claude CLI with NDJSON streaming
- Bidirectional tool name/argument mapping with break-early subprocess control
- Extended thinking support with configurable effort levels and Opus elevation
- Custom tool MCP proxy via schema-only stdio server
- Cross-platform process lifecycle management with error propagation
- CI/CD pipeline with 3-OS test matrix and automated npm publishing

### What Worked
- GSD phase-by-phase approach kept scope tight — 13 plans averaged 6 min each
- Break-early architecture (Phase 4) was a major simplification over the original deny/allow approach
- Squash-merge workflow kept main history clean (9 commits for 6 phases)
- Test-first approach caught integration issues early — 292+ tests by completion

### What Was Inefficient
- Phase 4 had a full implementation reverted and rewritten (MCP proxy -> break-early) — cost 33 min vs ~5 min average
- SUMMARY frontmatter never populated with requirements_completed — made audit cross-reference weaker
- ROADMAP checkboxes went stale during execution — Phase 1 and 6 both showed incomplete when done
- Post-milestone work (session resume, tool activation) happened before milestone was formally closed, creating audit confusion

### Patterns Established
- Break-early at `message_stop` + SIGKILL is the canonical tool interception pattern
- Schema-only MCP server (.cjs, ~36 lines, no SDK) for exposing tools without execution
- `streamEnded` + `broken` dual guard pattern for preventing double error/end events
- Lazy initialization pattern (`ensureMcpConfig`) for deferring pi API calls to first request

### Key Lessons
1. Architecture pivots (Phase 4 revert) are cheaper than fighting a flawed design — the 33 min rewrite saved days of debugging
2. Control protocol behavior depends heavily on CLI flags (`--permission-prompt-tool stdio` vs `--permission-mode dontAsk`) — always verify experimentally
3. `for await` in jiti-compiled code breaks silently — avoid in GSD extension context
4. Close milestones promptly — post-milestone features created audit noise

### Cost Observations
- Model mix: primarily opus for execution, sonnet for verification/integration checking
- Average plan execution: 6 min (range: 2-19 min)
- Phase 4 was the outlier at 33 min total (architecture pivot)
- Notable: entire MVP from init to ship in 9 days

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Timeline | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.0 | 9 days | 6 | Initial build — established all patterns |

### Cumulative Quality

| Milestone | Tests | Coverage | LOC |
|-----------|-------|----------|-----|
| v1.0 | 292+ | 92/88/92/92 | 7,991 |

### Top Lessons (Verified Across Milestones)

1. Break-early + SIGKILL is more reliable than selective deny/allow for tool interception
2. Verify CLI flag behavior experimentally — documentation doesn't always match reality
