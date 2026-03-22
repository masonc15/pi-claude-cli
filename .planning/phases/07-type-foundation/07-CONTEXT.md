# Phase 7: Type Foundation - Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Update NDJSON type definitions in `types.ts` to accurately represent every message shape the Claude CLI emits. This is an infrastructure prerequisite — it enables Phases 8 (Error Passthrough) and 9 (Sub-Agent Progress) to use proper types instead of `as any` casts.

</domain>

<decisions>
## Implementation Decisions

### `as any` cleanup scope
- **D-01:** Define new/updated types AND fix existing `as any` casts in consuming code (provider.ts, event-bridge.ts) — validates types actually work, fully satisfies success criterion 5
- **D-02:** This phase touches consuming code only to replace `as any` casts with proper type narrowing — no behavioral changes to consuming code

### Unknown message type handling
- **D-03:** `NdjsonMessage` union stays strict (discriminated on `type` field) — maximum type safety with exhaustive switch coverage
- **D-04:** Runtime resilience comes from `parseLine()` returning `null` for unparseable/unknown messages (existing pattern) — no catch-all type needed in the union

### Wire protocol verification
- **D-05:** Trust milestone research + upstream docs for type definitions — research is HIGH confidence with exact JSON shapes from GitHub issues and Agent SDK TypeScript types
- **D-06:** Real-world verification deferred to Phase 8 execution (research flag already exists for `assistant` message handling)

### Claude's Discretion
- Exact type guard implementation strategy (type predicates vs inline narrowing)
- Whether to use branded types or plain interfaces
- Internal organization within `types.ts` (grouping, ordering, comments)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Type definitions (primary target)
- `src/types.ts` -- Current NDJSON type definitions; all type changes happen here

### Consuming code (cast cleanup)
- `src/provider.ts` -- Uses `(msg as any).parent_tool_use_id` at line ~238; primary consumer of `NdjsonMessage` union
- `src/event-bridge.ts` -- Uses `(output.content[idx] as any).arguments` at lines ~273, ~336; consumes `ClaudeApiEvent`
- `src/stream-parser.ts` -- Returns `parsed as NdjsonMessage` at line ~36; type assertion on parse

### Milestone research (type specifications)
- `.planning/research/SUMMARY.md` -- Exact type changes needed, wire protocol shapes, confidence assessment
- `.planning/research/FEATURES.md` -- Error category enumeration, message type details
- `.planning/research/PITFALLS.md` -- Pitfall 4 (narrow subtype check), pitfall 5 (missing result event)
- `.planning/research/ARCHITECTURE.md` -- Integration points, `rl.on("line")` handler structure

### Upstream references (wire protocol source of truth)
- Agent SDK Streaming Output docs -- `StreamEvent` type, `parent_tool_use_id`, message flow
- Agent SDK Agent Loop docs -- `ResultMessage` subtypes, error handling
- Agent SDK TypeScript Reference -- Complete `SDKMessage` union type

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `parseLine()` in `stream-parser.ts`: Already handles null/malformed input gracefully -- new types don't require parser changes
- `NdjsonMessage` union in `types.ts`: Discriminated on `type` field -- new message types follow the same pattern

### Established Patterns
- Discriminated union on `type` field for `NdjsonMessage` -- new `ClaudeAssistantMessage` follows this pattern
- Optional fields with `?` for wire protocol fields that may be absent -- consistent with existing `ClaudeResultMessage.result?`, `error?`
- `ClaudeApiEvent` uses string literal union for `type` field -- established pattern for event discrimination

### Integration Points
- `provider.ts` `rl.on("line")` handler: switch on `msg.type` -- new `"assistant"` case will be added in Phase 8
- `event-bridge.ts` `handleEvent()`: switch on `event.type` -- no changes needed for Phase 7 (event types are correct)
- `stream-parser.ts` `parseLine()`: casts to `NdjsonMessage` -- cast remains valid as union expands

</code_context>

<specifics>
## Specific Ideas

No specific requirements -- open to standard approaches. The milestone research already provides exact JSON shapes and field specifications for all new types.

</specifics>

<deferred>
## Deferred Ideas

None -- discussion stayed within phase scope.

### Reviewed Todos (not folded)
- **Pi's find tool returns no results in standalone pi (fd/spawnSync issue)** -- tooling issue unrelated to type definitions; belongs in a separate fix, not Phase 7 scope

</deferred>

---

*Phase: 07-type-foundation*
*Context gathered: 2026-03-21*
