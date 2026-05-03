# pi-claude-cli

> **Why this fork.** Anthropic recommends Claude Code `--effort xhigh` for Opus 4.7 coding. Upstream [`rchern/pi-claude-cli`](https://github.com/rchern/pi-claude-cli) never sends that level: Pi `xhigh` becomes `max` on Opus and `high` elsewhere. This fork maps Opus 4.7+ `xhigh` to `xhigh`, with opt-in `max` for rare cases. See [Thinking effort](#thinking-effort) for details.

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

## How it works

The extension registers as a custom pi provider exposing all Claude models. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on PATH). Version 2.1.123 or newer is recommended; earlier versions may not accept all `--effort` levels documented below.
- A Claude Pro or Max subscription
- [pi](https://github.com/mariozechner/pi-coding-agent)

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-claude-cli"]
}
```

Then select a Claude model via `/model` in the interactive UI. All Claude models appear under the `pi-claude-cli` provider.

## Features

- Streams text, thinking, and tool call tokens in real-time
- Maps tool names and arguments bidirectionally between Claude and pi
- Exposes custom pi tools to Claude via MCP (schema-only, no execution)
- Break-early pattern prevents Claude CLI from auto-executing tools
- Constrains Claude Code's visible built-in tools to the tools pi advertised for the turn
- Isolates subprocesses from user-level Claude Code plugins, hooks, and external MCPs by default
- Session resume via `--resume` eliminates history replay on follow-up turns
- Truthful, model-family-aware mapping from pi's thinking levels to Claude CLI `--effort`
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## Claude trace mode

Set `PI_CLAUDE_CLI_TRACE_DIR=/path/to/traces` to record one trace directory per Claude subprocess turn. This is intentionally opt-in because it stores prompts and raw model streams on disk.

Each trace contains:

- `meta.json`: model, cwd, session IDs, resolved effort, exact `claude` argv, and redacted auth-related environment facts
- `system-prompt.txt`: the full prompt pi-claude-cli passes through `--append-system-prompt`
- `stdin.ndjson`: every line pi-claude-cli writes to Claude Code, including the user message and permission/control responses
- `stdout.ndjson`: every raw stream-json line emitted by Claude Code, including system events, tool calls, tool results, and result events
- `stderr.log`: raw Claude Code stderr
- `lifecycle.jsonl`: concise timing/index events for spawn, stdin writes, stdout lines, control requests, break-early kills, exits, aborts, and timeouts
- `claude-debug.log`: Claude Code's own debug log, enabled by passing `--debug-file` only when trace mode is on

When trace mode is enabled, pi-claude-cli also passes `--include-hook-events` so hook/system lifecycle events are included in `stdout.ndjson`. The trace records the whole process boundary that pi-claude-cli can observe; Claude Code's built-in internal system prompt is only visible if Claude Code itself exposes it in stream-json or debug output.

## Claude Code isolation

pi is the harness for prompts, skills, tools, and custom tool execution. To keep Claude Code from injecting a second harness into the same turn, pi-claude-cli starts Claude subprocesses with:

- `--setting-sources local` by default, which avoids user-level Claude Code plugins and hooks while preserving normal Claude Code auth
- `--strict-mcp-config`, so Claude only sees the MCP config pi-claude-cli explicitly passes for custom pi tool schemas
- `--tools <mapped built-ins>`, derived from pi's `Available tools:` section, so a read-only pi turn exposes Claude Code `Read` but not `Bash`, `Glob`, or unrelated native tools
- `--disable-slash-commands`, so Claude Code native slash commands and native skills do not compete with Pi skills

This matters for Pi skills. Pi lists skills as files and tells the model to load the listed `<location>` with `read`; Claude Code user plugins may instead inject native-skill instructions such as using the `Skill` tool. The isolation flags keep Opus focused on Pi's actual contract.

Two environment variables can relax the defaults for debugging:

- `PI_CLAUDE_CLI_SETTING_SOURCES=default` omits `--setting-sources`; any other non-empty value is passed directly, such as `user,project,local`.
- `PI_CLAUDE_CLI_STRICT_MCP_CONFIG=0` (also accepts `false`/`no`/`off`) omits `--strict-mcp-config`.

## Thinking effort

Pi exposes thinking levels `minimal | low | medium | high | xhigh`. Claude Code CLI 2.1.123 accepts `--effort low | medium | high | xhigh | max`. The two scales overlap but are not identical, so this extension maps between them per model family. The default mapping is truthful (1:1 where possible) and never silently promotes a request to `max`.

| Pi level | Opus 4.7+ (default) | Pre-4.7 Opus       | Sonnet / Haiku / other |
| -------- | ------------------- | ------------------ | ---------------------- |
| (off)    | `--effort` omitted  | `--effort` omitted | `--effort` omitted     |
| minimal  | low                 | low                | low                    |
| low      | low                 | low                | low                    |
| medium   | medium              | medium             | medium                 |
| high     | high                | high               | high                   |
| xhigh    | **xhigh**           | high (cap)         | high (cap)             |

When `reasoning` is `off`, no `--effort` flag is sent and the CLI uses its session default.

When the CLI level the user picked does not match the resolved level (e.g. Pi `xhigh` is capped to CLI `high` on Sonnet), the extension emits a one-time `console.warn` so the remap is visible. The same warning fires once per `(family, pi-level)` pair per process, so it does not spam.

### Overrides

Two opt-in environment variables let you shape the mapping explicitly:

- `PI_CLAUDE_CLI_EFFORT=<low|medium|high|xhigh|max>` hard-pins the CLI effort for every request that has reasoning enabled. Use this to force `max` always (`PI_CLAUDE_CLI_EFFORT=max`) or to lock everything to a single level. When reasoning is off, no flag is sent regardless.
- `PI_CLAUDE_CLI_MAX_MODE=1` (also accepts `true`/`yes`/`on`) promotes Pi `xhigh` to CLI `max` on Opus 4.7+ models only. Lower Pi levels are unaffected; pre-4.7 Opus and non-Opus models are unaffected. Use this if you want your top Pi level to map to the CLI's top level on the latest Opus.

If both are set, `PI_CLAUDE_CLI_EFFORT` wins because it's the more explicit knob.

### Why per-family?

Anthropic documents `xhigh` as a first-class effort level for Opus 4.7 coding, so 1:1 mapping there is what users expect. For older Opus and for Sonnet/Haiku, `xhigh` was not part of the documented recommendation, so the extension caps at `high` to avoid sending an effort level that may not produce the result the user expects. Setting `PI_CLAUDE_CLI_EFFORT=xhigh` explicitly opts into sending it everywhere.

### Migration from earlier versions

Earlier releases silently shifted Opus mapping up: Pi `medium` → CLI `high`, Pi `high` → CLI `max`, Pi `xhigh` → CLI `max`. That mapping was misleading and predates the CLI's current `xhigh` level. The new defaults are truthful: Pi `xhigh` on Opus 4.7+ now sends `--effort xhigh`, and lower levels send their literal counterpart. To restore the old "Opus xhigh = max" behavior on Opus 4.7+ only, set `PI_CLAUDE_CLI_MAX_MODE=1`.

## License

MIT
