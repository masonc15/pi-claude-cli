---
phase: 7
slug: type-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-21
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run && npx tsc --noEmit` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run`
- **After every plan wave:** Run `npx vitest run && npx tsc --noEmit`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 7-01-01 | 01 | 1 | SC-1 (ClaudeAssistantMessage) | typecheck | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 7-01-02 | 01 | 1 | SC-2 (parent_tool_use_id) | typecheck | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 7-01-03 | 01 | 1 | SC-3 (ResultMessage subtypes) | typecheck | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 7-01-04 | 01 | 1 | SC-4 (is_error/errors fields) | typecheck | `npx tsc --noEmit` | ✅ | ⬜ pending |
| 7-01-05 | 01 | 1 | SC-5 (zero as-any casts) | typecheck+grep | `npx tsc --noEmit && grep -rn "as any" src/` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Wire format matches real CLI output | SC-1 through SC-4 | Requires live Claude CLI session | Verify in Phase 8 execution with real error triggers |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
