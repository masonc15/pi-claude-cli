---
created: 2026-03-21T18:00:00.000Z
title: Pi's find tool returns no results in standalone pi (fd/spawnSync issue)
area: tooling
files:
  - node_modules/@mariozechner/pi-coding-agent/dist/core/tools/find.js
---

## Problem

After activating the `find` tool via `setActiveTools`, it works in GSD but returns "No files found matching pattern" in standalone pi (`pi -e ./index.ts`).

## Evidence

- Inputs identical in both: `{ pattern: "**/README*", cwd: "D:\Code\pi-claude-cli" }`
- GSD result: `"README.md"` — works
- Pi result: `"No files found matching pattern"` — broken
- Direct `fd.exe` with same args: works (`D:/Code/pi-claude-cli/README.md`)
- `fd.exe` exists at `~/.pi/agent/bin/fd.exe`

## Root cause (partial)

- Standalone pi (pi-coding-agent 0.58.0) uses `fd` via `spawnSync`
- GSD (pi-coding-agent 2.40.0) replaced `fd` with native Rust glob (`@gsd/native/glob`, commit `fbf1968d` in gsd-build/gsd-2)
- Something about how pi 0.58.0 invokes `fd` via `spawnSync` produces no results, despite `fd` working directly from shell with same args
- Exact cause unknown — could be arg construction, env, working dir, or gitignore handling in the spawnSync call

## Impact

`find` tool (Glob mapping) doesn't work in standalone pi on Windows. Works in GSD. Other tools (read, write, edit, bash, ls) work in both.

## Solution

May resolve when standalone pi updates to match GSD's native glob implementation. If not, investigate the specific `spawnSync` call args in pi's find.js.
