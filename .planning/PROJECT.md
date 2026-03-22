# pi-claude-cli

## What This Is

A pi coding agent extension that acts as a custom LLM provider, routing all LLM calls through the official Claude Code CLI (`claude`) as a subprocess. Uses the stream-json wire protocol for real-time token streaming, bidirectional tool mapping, extended thinking support, and custom tool exposure via MCP. Allows using a Claude Pro/Max subscription for authentication rather than requiring an API key. Adapted from [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) (MIT).

## Core Value

Enable pi users to leverage their Claude Pro/Max subscription as the LLM backend — no API key, no separate billing, full Claude model access through the official CLI.

## Requirements

### Validated

- Provider registration with all Claude models via `pi.registerProvider()` — v1.0
- Subprocess bridge with NDJSON streaming (`claude -p --stream-json`) — v1.0
- Bidirectional tool name/argument mapping (Read<->read, file_path<->path, etc.) — v1.0
- Break-early architecture: Claude proposes tools, subprocess killed before execution, pi executes — v1.0
- Custom tool MCP proxy via schema-only stdio server and `--mcp-config` — v1.0
- Extended thinking with configurable effort levels and Opus elevation — v1.0
- Usage metrics tracking with `calculateCost` — v1.0
- Image support (base64 passthrough for final user message, placeholders for history) — v1.0
- Cross-platform subprocess lifecycle (cross-spawn, SIGKILL cleanup, inactivity timeout) — v1.0
- Session resume via `--resume` and `--session-id` flags — v1.0 (post-milestone)
- Cross-platform CI/CD with automated npm publishing — v1.0

### Active

## Current Milestone: v0.4.0 Observability

**Goal:** Surface subprocess activity and errors to the user instead of silently swallowing them.

**Target features:**
- Show sub-agent progress during internal tool execution instead of silent "Working..." (#12)
- Pass through all actionable CLI errors (context limits, subscription caps, rate limits, auth failures, billing errors) instead of swallowing them (#2)
- Update README with pi install instructions (#3)

### Out of Scope

- Direct Anthropic API calls — The entire point is avoiding API key requirements
- Claude Agent SDK dependency — Replaced by direct CLI subprocess
- Custom authentication flows — Relies on existing `claude` CLI auth
- Custom tool result replay — Claude ignores flat-text tool results on second turn (architectural limitation of prompt-based history)

## Context

**Current state:** v0.3.1 shipped on npm. 7,991 LOC TypeScript. 302+ tests across 9 test files. Published as `pi-claude-cli` with `pi-package` keyword. v1.0 MVP milestone completed (6 phases, 26/26 requirements). Phase 7 (Type Foundation) complete — NDJSON types now cover all CLI message shapes.

**Architecture:** Each pi LLM request spawns a `claude -p` subprocess. Extension parses NDJSON output via readline, bridges Claude API events to pi's `AssistantMessageEventStream`, and kills the subprocess at `message_stop` (break-early) before Claude can auto-execute tools. Session resume reuses Claude's `--resume` flag to avoid replaying full conversation history.

**Known issues:**
- `find` tool (fd/spawnSync) returns no results in standalone pi on Windows — works in GSD which uses native Rust glob
- Custom tool MCP proxy: Claude can propose custom tool calls, but tool result replay on the second turn doesn't work (flat-text prompt format limitation)

## Constraints

- **Transport:** Must use `claude -p` CLI subprocess only — no SDK, no direct API
- **Auth:** Relies on Claude CLI's existing authentication (Pro/Max subscription)
- **Compatibility:** Must work with pi's `registerProvider` API and `AssistantMessageEventStream` event contract
- **License:** MIT, with attribution to claude-agent-sdk-pi
- **Platform:** Node.js, must handle subprocess spawning on Windows/macOS/Linux

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Break-early architecture (Phase 4 replaced deny/allow) | `--permission-prompt-tool stdio` + kill at `message_stop` is simpler and more reliable than selective deny/allow | Good — eliminates race conditions with built-in tool execution |
| Stateless subprocess with `--resume` | Fresh subprocess per request, but `--resume` avoids token cost of full history replay | Good — shipped as issue #1 |
| Stream-json control protocol | CLI flags alone cannot achieve "propose but don't execute" (experimentally confirmed) | Good — control protocol enables MCP tool allow/deny |
| Schema-only MCP server (.cjs) | Minimal 36-line server exposes tool schemas without executing tools | Good — avoids MCP SDK dependency |
| `--input-format stream-json` required | Needed for control_response messages; cannot drop input formatter | Good — enables full bidirectional protocol |

---
*Last updated: 2026-03-22 after Phase 7 (Type Foundation) complete*
