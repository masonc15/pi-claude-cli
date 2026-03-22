# Phase 7: Type Foundation - Research

**Researched:** 2026-03-21
**Domain:** TypeScript type definitions for Claude CLI NDJSON wire protocol
**Confidence:** HIGH

## Summary

Phase 7 updates NDJSON type definitions in `src/types.ts` to accurately represent every message shape the Claude CLI emits via `--output-format stream-json`. This is a zero-risk, purely additive phase that enables Phases 8 (Error Passthrough) and 9 (Sub-Agent Progress) to use proper types instead of `as any` casts.

The work is narrowly scoped: define 1 new interface (`ClaudeAssistantMessage`), update 2 existing interfaces (`ClaudeStreamEventMessage` and `ClaudeResultMessage`), expand the `NdjsonMessage` union, and fix `as any` casts in consuming code where our type definitions were the root cause. The milestone research already provides exact JSON shapes from GitHub issues and Agent SDK TypeScript types, so there is no guesswork about the wire protocol format.

The primary risk is accidentally changing runtime behavior while fixing type casts. Decision D-02 explicitly constrains this phase: consuming code changes are limited to replacing `as any` casts with proper type narrowing -- no behavioral changes permitted.

**Primary recommendation:** Add types first, then systematically replace each `as any` cast with proper type narrowing, verifying `tsc --noEmit` and `vitest run` pass after each change.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Define new/updated types AND fix existing `as any` casts in consuming code (provider.ts, event-bridge.ts) -- validates types actually work, fully satisfies success criterion 5
- **D-02:** This phase touches consuming code only to replace `as any` casts with proper type narrowing -- no behavioral changes to consuming code
- **D-03:** `NdjsonMessage` union stays strict (discriminated on `type` field) -- maximum type safety with exhaustive switch coverage
- **D-04:** Runtime resilience comes from `parseLine()` returning `null` for unparseable/unknown messages (existing pattern) -- no catch-all type needed in the union
- **D-05:** Trust milestone research + upstream docs for type definitions -- research is HIGH confidence with exact JSON shapes from GitHub issues and Agent SDK TypeScript types
- **D-06:** Real-world verification deferred to Phase 8 execution (research flag already exists for `assistant` message handling)

### Claude's Discretion
- Exact type guard implementation strategy (type predicates vs inline narrowing)
- Whether to use branded types or plain interfaces
- Internal organization within `types.ts` (grouping, ordering, comments)

### Deferred Ideas (OUT OF SCOPE)
- Pi's find tool returns no results in standalone pi (fd/spawnSync issue) -- tooling issue unrelated to type definitions; belongs in a separate fix, not Phase 7 scope
</user_constraints>

## Standard Stack

### Core

No new dependencies. Phase 7 is entirely within the existing TypeScript type system.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | ^5.7.0 | Type definitions, discriminated unions, type guards | Already in devDependencies; `strict: true` in tsconfig.json |
| Vitest | ^3.0.0 | Test runner for type validation tests | Already in devDependencies; 296 passing tests |

**No packages to install. No version changes needed.**

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Plain interfaces | Branded types (`type Brand<T, B> = T & { __brand: B }`) | Branded types add runtime-invisible type safety but increase complexity; plain interfaces are established project pattern |
| Type predicates | Inline narrowing (`if (msg.type === "assistant")`) | Type predicates are reusable but add functions; inline narrowing is simpler for switch/if-else chains already in use |
| Zod runtime validation | TypeScript-only types | Zod would add runtime safety but is overkill for this project; `parseLine()` already handles invalid input gracefully |

## Architecture Patterns

### Existing Type Organization in types.ts

```
src/types.ts
  -- Wire protocol types for Claude CLI stream-json NDJSON communication
  |
  +-- ClaudeStreamEventMessage    (type: "stream_event")
  +-- ClaudeResultMessage         (type: "result")
  +-- ClaudeSystemMessage         (type: "system")
  +-- ClaudeControlRequest        (type: "control_request")
  +-- NdjsonMessage union         (discriminated on `type` field)
  |
  +-- ClaudeApiEvent              (inner event inside stream_event wrapper)
  +-- ClaudeUsage                 (token usage data)
  +-- TrackedContentBlock         (content block tracking during streaming)
```

### Pattern 1: Discriminated Union on `type` Field

**What:** All NDJSON message types share a `type` field with a string literal value. TypeScript narrows the union automatically in switch/if-else statements.

**When to use:** Always -- this is the established project pattern for `NdjsonMessage`.

**Example (current code, provider.ts:235-281):**
```typescript
if (msg.type === "stream_event") {
  // TypeScript knows: msg is ClaudeStreamEventMessage
  bridge.handleEvent(msg.event);
} else if (msg.type === "control_request") {
  // TypeScript knows: msg is ClaudeControlRequest
  handleControlRequest(msg, proc!.stdin!);
} else if (msg.type === "result") {
  // TypeScript knows: msg is ClaudeResultMessage
  if (msg.subtype === "error") { ... }
}
```

**New type follows the same pattern:**
```typescript
export interface ClaudeAssistantMessage {
  type: "assistant";
  // ... fields
}
```

### Pattern 2: Optional Fields for Wire Protocol Uncertainty

**What:** Fields that may or may not be present in the wire protocol use `?:` optional syntax, not `| undefined`.

**When to use:** Any field that the CLI may omit entirely depending on context (e.g., `parent_tool_use_id` is absent on top-level events, present on sub-agent events).

**Established examples:**
```typescript
// Current: ClaudeResultMessage
result?: string;
error?: string;
session_id?: string;

// Current: ClaudeApiEvent
index?: number;
message?: { ... };
```

### Pattern 3: String Literal Union for Subtypes

**What:** Fields with a known set of values use string literal unions, with `| string` fallback ONLY when the protocol is known to be extensible.

**Current example:**
```typescript
// ClaudeResultMessage.subtype -- CURRENTLY too narrow
subtype: "success" | "error";

// ClaudeApiEvent.type -- generic string because Claude adds new event types
type: string;
```

**Decision:** Per D-03, the `NdjsonMessage` union stays strict. For `ClaudeResultMessage.subtype`, list all known values as string literals. Do NOT add `| string` fallback -- unknown subtypes from `parseLine()` will still be parsed as `NdjsonMessage` (since `subtype` is not part of the discriminant), and consuming code will handle them via default/else branches.

### Anti-Patterns to Avoid

- **Adding `| string` to the `type` discriminant field:** This destroys exhaustive narrowing. The `type` field must be an exact string literal on every `NdjsonMessage` variant.
- **Making `parseLine()` validate against specific type values:** The parser is intentionally loose -- it returns `null` for unparseable input but does not validate field values. This is correct behavior per D-04.
- **Adding runtime type guards for message validation:** The project uses compile-time types only for NDJSON messages. Runtime validation is handled by the `parseLine() -> null` fallback.
- **Changing `stream-parser.ts` behavior:** The `return parsed as NdjsonMessage` cast is correct and intentional. Expanding the union does not require parser changes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Message type discrimination | Custom runtime type checkers | TypeScript discriminated union narrowing | Built into the language; the `type` field is already the discriminant |
| `as any` removal for content array access | Manual index-based type assertions | Type guard checks (`block.type === "tool_use"`) before property access | Compiler enforces correctness at build time |
| Exhaustive message type handling | Default case with `console.warn` | TypeScript `never` exhaustive check (optional, for future phases) | Catches missed cases at compile time |

## Common Pitfalls

### Pitfall 1: Breaking the Discriminated Union

**What goes wrong:** Adding a new type to the `NdjsonMessage` union with a `type` field that overlaps or is generic (e.g., `type: string`) breaks narrowing for all union members.

**Why it happens:** TypeScript's discriminated union narrowing requires each variant to have a unique literal value for the discriminant property. If one variant has `type: string`, the compiler can no longer narrow.

**How to avoid:** Every new interface added to the `NdjsonMessage` union MUST have `type` as a string literal (e.g., `type: "assistant"`, never `type: string`).

**Warning signs:** TypeScript errors saying "Property 'X' does not exist on type 'NdjsonMessage'" in places where narrowing previously worked.

### Pitfall 2: `subtype` Union Mismatch with Wire Protocol

**What goes wrong:** Defining `ClaudeResultMessage.subtype` as a closed union (e.g., `"success" | "error" | "error_during_execution"`) and then the CLI sends a new subtype value not in the union. At runtime, the parsed message has a subtype value that TypeScript says is impossible.

**Why it happens:** The Claude CLI is actively developed; new subtypes may be added.

**How to avoid:** List all KNOWN subtypes as string literals. The `parseLine()` function casts `parsed as NdjsonMessage` regardless, so unknown subtypes will still parse. Consuming code should handle the "not success" case via `msg.subtype !== "success"` (which catches unknown values) rather than listing every error subtype explicitly.

**Warning signs:** New CLI versions cause unexpected behavior because an unknown subtype falls through all checks.

### Pitfall 3: Accidentally Changing Runtime Behavior During Cast Cleanup

**What goes wrong:** While replacing `as any` with proper type narrowing, the developer changes the condition logic, variable scope, or control flow, introducing behavioral changes that break tests.

**Why it happens:** Cast cleanup often requires restructuring code (adding type guard checks, reordering conditions). It is easy to change behavior while doing so.

**How to avoid:** Per D-02, consuming code changes are strictly limited to type annotations and type narrowing. The logical behavior of every code path must remain identical. Run `vitest run` after each file change. Run `tsc --noEmit` to verify type correctness.

**Warning signs:** Test failures after cast removal. Git diff shows logic changes beyond type annotations.

### Pitfall 4: `TrackedContentBlock.index` Deletion Hack

**What goes wrong:** The `event-bridge.ts:308` line `delete (block as any).index` removes the `index` property from a `TrackedContentBlock` at runtime. If the type still has `index: number` as required, this creates a runtime object that violates its own type.

**Why it happens:** The `index` field is needed during streaming to match incoming deltas to blocks, but is not needed after `content_block_stop`. The current code deletes it as cleanup.

**How to avoid:** This is an internal type issue unrelated to NDJSON wire protocol types. The fix options are: (a) make `index` optional on `TrackedContentBlock` (simplest), (b) create a separate "completed" block type without `index`, or (c) leave this cast as-is since it is internal bookkeeping. Recommendation: option (a) -- making `index` optional is accurate because after deletion it genuinely is absent.

### Pitfall 5: Pi-Ai Stream Push Casts Are Not Phase 7 Scope

**What goes wrong:** The developer tries to fix `provider.ts:156` and `provider.ts:324` (`stream.push({...} as any)`) and discovers these are pi-ai type compatibility issues that require pi-ai type changes, not NDJSON type changes.

**Why it happens:** These casts exist because `AssistantMessageEventStream.push()` has a type signature that doesn't accept all the event shapes the code pushes. This is a pi-ai typing gap, not a pi-claude-cli typing gap.

**How to avoid:** Recognize that these two `as any` casts are out of scope. Phase 7 success criterion 5 says "zero `as any` casts needed by consuming code" referring to consuming code that uses the NEW types. The pi stream push casts are pre-existing and unrelated to NDJSON types.

## Code Examples

Verified patterns from the existing codebase and milestone research.

### New Type: ClaudeAssistantMessage

```typescript
// Source: .planning/research/ARCHITECTURE.md, FEATURES.md wire protocol reference
// Wire format: {"type":"assistant","message":{"content":[...],"error":"invalid_request"}, ...}
export interface ClaudeAssistantMessage {
  type: "assistant";
  message?: {
    content?: unknown[];
    model?: string;
    stop_reason?: string;
    usage?: ClaudeUsage;
  };
  error?: AssistantMessageError;
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
}

// Error category from the Claude CLI (Agent SDK TypeScript types)
// Source: .planning/research/ARCHITECTURE.md
export type AssistantMessageError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown";
```

### Updated Type: ClaudeStreamEventMessage

```typescript
// Source: Current types.ts + .planning/research/ARCHITECTURE.md
// Wire format: {"type":"stream_event","event":{...},"parent_tool_use_id":"toolu_abc"}
export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
  parent_tool_use_id?: string | null;  // NEW: null for top-level, string for sub-agent
  uuid?: string;                       // NEW: optional message UUID
  session_id?: string;                 // NEW: optional session tracking
}
```

### Updated Type: ClaudeResultMessage

```typescript
// Source: .planning/research/ARCHITECTURE.md, FEATURES.md wire protocol reference
// Wire format: {"type":"result","subtype":"error_during_execution","is_error":true,...}
export interface ClaudeResultMessage {
  type: "result";
  subtype: "success" | "error" | "error_during_execution" | "error_max_turns" | "error_max_budget_usd";
  result?: string;
  error?: string;
  is_error?: boolean;    // NEW: true when subtype is "success" but an error occurred
  errors?: string[];     // NEW: error messages for "success with error" edge case
  session_id?: string;
  total_cost_usd?: number;  // NEW: total cost tracking
  usage?: ClaudeUsage;      // NEW: token usage in result
  duration_ms?: number;     // NEW: execution duration
  duration_api_ms?: number; // NEW: API-only duration
  num_turns?: number;       // NEW: number of turns completed
}
```

### Updated NdjsonMessage Union

```typescript
export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeControlRequest
  | ClaudeAssistantMessage;  // NEW
```

### Cast Cleanup: provider.ts line 238

```typescript
// BEFORE (as any cast):
const isTopLevel = !(msg as any).parent_tool_use_id;

// AFTER (proper type access -- parent_tool_use_id now on ClaudeStreamEventMessage):
const isTopLevel = !msg.parent_tool_use_id;
```

### Cast Cleanup: event-bridge.ts line 273

```typescript
// BEFORE (as any cast):
(output.content[idx] as any).arguments = block.arguments;

// AFTER (proper type narrowing -- content[idx] is known to be ToolCall in this branch):
const toolContent = output.content[idx] as ToolCall;
toolContent.arguments = block.arguments;
// Note: ToolCall.arguments is Record<string, any>, so this is type-safe.
// The `as ToolCall` cast is needed because output.content is a union array.
```

### Cast Cleanup: event-bridge.ts line 308

```typescript
// BEFORE (as any to delete required property):
delete (block as any).index;

// AFTER (make index optional on TrackedContentBlock):
// In types.ts: index?: number;
// Then in event-bridge.ts:
delete block.index;  // No cast needed since index is now optional
```

## `as any` Cast Inventory

Complete inventory of `as any` casts in source files, with Phase 7 disposition.

| File | Line | Cast | Root Cause | Phase 7 Action |
|------|------|------|------------|----------------|
| `provider.ts` | 238 | `!(msg as any).parent_tool_use_id` | `parent_tool_use_id` missing from `ClaudeStreamEventMessage` | **FIX:** Add field to type, remove cast |
| `event-bridge.ts` | 273 | `(output.content[idx] as any).arguments` | `output.content[idx]` is union type, not narrowed to `ToolCall` | **FIX:** Use `as ToolCall` (known-safe, inside tool_use branch) |
| `event-bridge.ts` | 308 | `delete (block as any).index` | `index` is required on `TrackedContentBlock`, cannot delete required prop | **FIX:** Make `index` optional on `TrackedContentBlock` |
| `event-bridge.ts` | 336 | `(contentBlock as any).arguments` | `contentBlock` already typed as `ToolCall`, but `.arguments` assignment triggers type issue | **FIX:** Investigate -- `ToolCall.arguments` is `Record<string, any>` so this may be a readonly issue or a `finalArgs` type mismatch (finalArgs can be `string`) |
| `provider.ts` | 156 | `} as any)` | Pi's `AssistantMessageEventStream.push()` type doesn't accept this event shape | **SKIP:** Pi-ai type compatibility, not NDJSON type issue |
| `provider.ts` | 324 | `} as any)` | Pi's `AssistantMessageEventStream.push()` type doesn't accept this event shape | **SKIP:** Pi-ai type compatibility, not NDJSON type issue |
| `stream-parser.ts` | 36 | `parsed as NdjsonMessage` | `JSON.parse` returns `unknown`, needs cast to typed union | **KEEP:** Intentional type assertion; validated by preceding checks. Expanding the union does not change this line. |

**Phase 7 target:** 4 casts fixed, 2 skipped (pi-ai), 1 kept (intentional).

## `event-bridge.ts:336` Deep Dive

This cast needs special attention. The code is:

```typescript
const contentBlock = output.content[idx] as ToolCall;
(contentBlock as any).arguments = finalArgs;
```

`contentBlock` is already typed as `ToolCall`. `ToolCall.arguments` is `Record<string, any>`. But `finalArgs` is typed as `Record<string, unknown> | string` -- when JSON parse fails, it falls back to the raw string. Since `Record<string, any>` does not accept `string`, the cast is needed.

**Fix options:**
1. Assert `finalArgs as Record<string, any>` -- safe because pi handles string arguments at runtime (documented in code comment at line 338-340)
2. Narrow with `if (typeof finalArgs === "object")` and handle string case separately
3. Leave the cast since it is a pi-ai type boundary issue

**Recommendation:** Option 1 -- use `as Record<string, any>` instead of `as any`. This is more precise and documents intent.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 3.x |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run --coverage` |
| Type check command | `npx tsc --noEmit` |

### Phase Requirements -> Test Map

Phase 7 has no formal requirement IDs (it is an infrastructure prerequisite). The success criteria serve as testable requirements.

| Criterion | Behavior | Test Type | Automated Command | File Exists? |
|-----------|----------|-----------|-------------------|-------------|
| SC-1 | `ClaudeAssistantMessage` in `NdjsonMessage` union, covers error fields | unit (type compile check) | `npx tsc --noEmit` | N/A (compile check) |
| SC-2 | `ClaudeStreamEventMessage` includes `parent_tool_use_id` | unit (type compile check + runtime test) | `npx vitest run tests/stream-parser.test.ts -t "assistant"` | Wave 0 |
| SC-3 | `ClaudeResultMessage` subtypes include error variants | unit (type compile check + runtime test) | `npx vitest run tests/stream-parser.test.ts -t "result"` | Existing (update) |
| SC-4 | `ClaudeResultMessage` includes `is_error` and `errors` fields | unit (type compile check + runtime test) | `npx vitest run tests/stream-parser.test.ts -t "is_error"` | Wave 0 |
| SC-5 | Zero `as any` casts needed by consuming code (for new types) | type check | `npx tsc --noEmit` + grep audit | N/A (compile check + manual) |

### Sampling Rate

- **Per task commit:** `npx tsc --noEmit && npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run --coverage`
- **Phase gate:** Full suite green + typecheck green + `as any` audit shows only expected remaining casts

### Wave 0 Gaps

- [ ] `tests/stream-parser.test.ts` -- Add test cases for new message types: `assistant` message parsing, `result` with `is_error: true`, `stream_event` with `parent_tool_use_id`
- [ ] Type compile verification -- Ensure new types can be used without `as any` in test code that simulates consuming patterns

*(No new test files needed -- existing test files cover the modules being modified)*

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `subtype: "success" \| "error"` | `subtype: "success" \| "error" \| "error_during_execution" \| "error_max_turns" \| "error_max_budget_usd"` | Claude CLI evolution (pre-2025) | Error subtypes were added as the CLI matured; old code only handled the original two |
| No `assistant` message type | `assistant` message with `error` field | Claude CLI stream-json format | CLI now emits assistant messages with error categories for API-level failures |
| No `parent_tool_use_id` | `parent_tool_use_id` on stream events | Agent SDK sub-agent support | Sub-agent events carry parent context; previously all events were top-level |

**Deprecated/outdated:**
- Treating `result.subtype === "error"` as the only error case -- misses `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, and `is_error: true` on success subtype

## Open Questions

1. **`ClaudeResultMessage.subtype` extensibility**
   - What we know: Five known subtypes documented in Agent SDK and GitHub issues
   - What's unclear: Whether the CLI may add new subtypes in the future
   - Recommendation: Use the five known literals without `| string` fallback. Consuming code should use `subtype !== "success"` pattern (which catches unknown values at runtime). If TypeScript strict checks become a problem in future phases, add `| string` then.

2. **`error` field location on `ClaudeAssistantMessage`**
   - What we know: The research shows two shapes -- `message.error` (inside the message object) and top-level `error` field
   - What's unclear: Whether both locations are used or only one
   - Recommendation: Support both with `error?` at top level AND `message.error?` nested. Phase 8 will validate against real CLI output (per D-06).

3. **`TrackedContentBlock.index` optional change ripple effects**
   - What we know: Making `index` optional allows the `delete` without cast
   - What's unclear: Whether any code reads `block.index` after the block stop event (which would now need an undefined check)
   - Recommendation: Audit all `block.index` reads in event-bridge.ts -- all are in `findIndex()` callbacks BEFORE the stop handler deletes it, so this is safe.

## Sources

### Primary (HIGH confidence)
- `src/types.ts` -- Current NDJSON type definitions (direct inspection)
- `src/provider.ts` -- Consuming code with `as any` casts (direct inspection)
- `src/event-bridge.ts` -- Consuming code with `as any` casts (direct inspection)
- `src/stream-parser.ts` -- Parser returning NdjsonMessage (direct inspection)
- `.planning/research/SUMMARY.md` -- Milestone research with wire protocol shapes
- `.planning/research/ARCHITECTURE.md` -- Exact type changes needed, JSON examples
- `.planning/research/FEATURES.md` -- Error category enumeration, message type details
- `.planning/research/PITFALLS.md` -- Type-related pitfalls (narrow subtype check)

### Secondary (MEDIUM confidence)
- Agent SDK TypeScript Reference -- `SDKMessage` union type, `AssistantMessageError` type
- Agent SDK Streaming Output docs -- `StreamEvent`, `parent_tool_use_id`
- Agent SDK Agent Loop docs -- `ResultMessage` subtypes
- GitHub Issue #12312 -- Exact JSON for "Prompt is too long" error (assistant + result pair)
- NDJSON Wire Protocol community gist -- Result subtypes, assistant error field

### Tertiary (LOW confidence)
- GitHub Issue #24594 -- Confirms some NDJSON fields are undocumented (flags for Phase 8 validation)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- No new dependencies; pure TypeScript type definitions
- Architecture: HIGH -- Following established discriminated union pattern already in use
- Pitfalls: HIGH -- All pitfalls verified against actual codebase; `as any` inventory is exhaustive
- Type shapes: HIGH for known fields, MEDIUM for `error` field location on assistant message (Phase 8 will validate)

**Research date:** 2026-03-21
**Valid until:** Indefinite for type patterns; type shapes valid until Claude CLI next major version
