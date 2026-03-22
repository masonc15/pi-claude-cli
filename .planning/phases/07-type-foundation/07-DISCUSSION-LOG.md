# Phase 7: Type Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md -- this log preserves the alternatives considered.

**Date:** 2026-03-21
**Phase:** 07-type-foundation
**Areas discussed:** `as any` cleanup scope, Unknown message type handling, Wire protocol verification

---

## `as any` Cleanup Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Types only | Define types, leave consuming code for Phase 8/9 | |
| Types + fix existing casts | Update provider.ts and event-bridge.ts now | |

**User's choice:** Create context as-is (accepted recommended: Types + fix existing casts)
**Notes:** Skip assessment identified this as pure infrastructure with specific success criteria. User opted to capture analysis without further discussion.

---

## Unknown Message Type Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Strict union | Only known types compile, maximum type safety | |
| Union + catch-all | Known types + generic fallback for unknown types | |

**User's choice:** Create context as-is (accepted recommended: Strict union + runtime resilience via parseLine)
**Notes:** Existing `parseLine()` null-return pattern provides runtime resilience without weakening the type union.

---

## Wire Protocol Verification

| Option | Description | Selected |
|--------|-------------|----------|
| Trust research + docs | Fast, HIGH confidence research available | |
| Capture real CLI output | Ground truth, catches undocumented fields | |

**User's choice:** Create context as-is (accepted recommended: Trust research, verify during Phase 8)
**Notes:** Phase 8 already has a research flag for verifying `assistant` message handling in production.

---

## Claude's Discretion

- Type guard implementation strategy
- Branded types vs plain interfaces
- Internal organization within types.ts

## Deferred Ideas

- Pi find tool fd/spawnSync issue -- reviewed, not folded (unrelated to type definitions)
