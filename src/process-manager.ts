/**
 * Process manager for spawning and managing Claude CLI subprocesses.
 *
 * Handles subprocess lifecycle: spawn with correct CLI flags, write NDJSON
 * messages to stdin, force-kill after result (CLI hangs bug), and stderr capture.
 * Also provides startup validation for CLI presence and authentication.
 */

import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import type { ClaudeTrace } from "./claude-trace.js";
import { extractAllowedClaudeTools } from "./tool-availability.js";

const DEFAULT_CLAUDE_SETTING_SOURCES = "local";

function claudeSettingSources(): string | undefined {
  const raw = process.env.PI_CLAUDE_CLI_SETTING_SOURCES;
  if (raw === undefined) return DEFAULT_CLAUDE_SETTING_SOURCES;

  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "default") return undefined;
  return value;
}

function useStrictMcpConfig(): boolean {
  const raw = process.env.PI_CLAUDE_CLI_STRICT_MCP_CONFIG;
  if (raw === undefined) return true;

  const value = raw.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

function useDisableSlashCommands(): boolean {
  const raw = process.env.PI_CLAUDE_CLI_DISABLE_SLASH_COMMANDS;
  if (raw === undefined) return true;

  const value = raw.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

/**
 * Spawn a Claude CLI subprocess with all required flags for stream-json communication.
 *
 * @param modelId - The model ID to pass via --model flag
 * @param systemPrompt - Optional system prompt appended via --append-system-prompt
 * @param options - Optional cwd, AbortSignal, and effort level
 * @returns The spawned ChildProcess with piped stdin/stdout/stderr
 */
export function spawnClaude(
  modelId: string,
  systemPrompt?: string,
  options?: {
    cwd?: string;
    signal?: AbortSignal;
    effort?: string;
    mcpConfigPath?: string;
    resumeSessionId?: string;
    newSessionId?: string;
    allowedTools?: string[];
    trace?: ClaudeTrace;
  },
): ChildProcess {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    modelId,
    "--permission-prompt-tool",
    "stdio",
  ];

  if (useDisableSlashCommands()) {
    args.push("--disable-slash-commands");
  }

  const settingSources = claudeSettingSources();
  if (settingSources) {
    args.push("--setting-sources", settingSources);
  }

  if (useStrictMcpConfig()) {
    args.push("--strict-mcp-config");
  }

  if (options?.resumeSessionId) {
    // Resume an existing session — CLI loads prior conversation from disk
    args.push("--resume", options.resumeSessionId);
  } else if (options?.newSessionId) {
    // First turn: create session with this ID so subsequent turns can --resume it
    args.push("--session-id", options.newSessionId);
  }

  if (systemPrompt) {
    // Write system prompt to a temp file to avoid ENAMETOOLONG on Windows.
    // Claude CLI's --append-system-prompt accepts a file path or literal text.
    const tmpFile = join(
      tmpdir(),
      `pi-claude-cli-sysprompt-${process.pid}.txt`,
    );
    writeFileSync(tmpFile, systemPrompt, "utf-8");
    args.push("--append-system-prompt", tmpFile);
  }

  const allowedTools =
    options?.allowedTools ?? extractAllowedClaudeTools(systemPrompt);
  // Claude CLI 2.1.123 treats an explicitly empty --tools value as "allow no
  // built-in tools". We rely on that when Pi advertises only custom/no tools;
  // omitting --tools would let Claude Code fall back to its default built-ins.
  // Keep this covered by unit/e2e tests because it is a CLI behavior contract,
  // not a TypeScript-enforced invariant.
  if (allowedTools) {
    args.push("--tools", allowedTools.join(","));
  }

  if (options?.effort) {
    args.push("--effort", options.effort);
  }

  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath);
  }

  if (options?.trace) {
    args.push("--include-hook-events");
    args.push("--debug-file", options.trace.debugFile);
  }

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options?.cwd ?? process.cwd(),
  });

  options?.trace?.writeMeta({
    args,
    command: "claude",
    cwd: options?.cwd ?? process.cwd(),
    systemPromptTempFile: systemPrompt
      ? join(tmpdir(), `pi-claude-cli-sysprompt-${process.pid}.txt`)
      : undefined,
    childPid: proc.pid ?? null,
  });
  options?.trace?.record("spawn", {
    command: "claude",
    args,
    childPid: proc.pid ?? null,
  });

  return proc as ChildProcess;
}

/**
 * Clean up the temp system prompt file created by spawnClaude.
 * Safe to call multiple times or when no file exists.
 */
export function cleanupSystemPromptFile(): void {
  try {
    unlinkSync(join(tmpdir(), `pi-claude-cli-sysprompt-${process.pid}.txt`));
  } catch {
    // File doesn't exist or already deleted — ignore
  }
}

/**
 * Write a user message to the subprocess stdin as NDJSON.
 * Does NOT call stdin.end() -- stdin stays open for control_response in Phase 2.
 *
 * Accepts both string (text-only prompt) and array (ContentBlock[] with images)
 * content. JSON.stringify handles both natively. The stream-json protocol
 * supports either format in the content field.
 *
 * @param proc - The Claude subprocess
 * @param prompt - The prompt text or ContentBlock[] to send
 */
export function writeUserMessage(
  proc: ChildProcess,
  prompt: string | any[],
  onWrite?: (line: string) => void,
): void {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
  };
  const line = JSON.stringify(message) + "\n";
  proc.stdin!.write(line);
  onWrite?.(line);
}

/**
 * Force-kill a subprocess immediately via SIGKILL.
 * No-ops if the process is already dead (killed or exited).
 * Cross-platform safe: Node.js treats SIGKILL as forceful termination on Windows.
 *
 * @param proc - The subprocess to force-kill
 */
export function forceKillProcess(proc: ChildProcess): void {
  if (proc.killed || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
}

/** Registry of active subprocesses for cleanup on teardown. */
const activeProcesses = new Set<ChildProcess>();

/**
 * Register a subprocess in the global process registry.
 * The process is automatically removed from the registry when it exits.
 *
 * @param proc - The subprocess to track
 */
export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
  proc.on("exit", () => activeProcesses.delete(proc));
}

/**
 * Force-kill all registered subprocesses and clear the registry.
 * Safe to call multiple times -- no-ops on already-dead processes.
 */
export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    forceKillProcess(proc);
  }
  activeProcesses.clear();
}

/**
 * Force-kill the subprocess after a 500ms grace period.
 * The Claude CLI hangs after emitting the result message (known bug).
 * Brief grace period allows final stdout flushing before force-kill.
 *
 * @param proc - The Claude subprocess to clean up
 */
export function cleanupProcess(proc: ChildProcess): void {
  setTimeout(() => {
    forceKillProcess(proc);
  }, 500);
}

/**
 * Attach a data listener to stderr and accumulate output into a buffer.
 *
 * @param proc - The Claude subprocess
 * @returns A function that returns the accumulated stderr string
 */
export function captureStderr(proc: ChildProcess): () => string {
  let buffer = "";
  proc.stderr!.on("data", (data: Buffer) => {
    buffer += data.toString();
  });
  return () => buffer;
}

/**
 * Validate that the Claude CLI is installed and on PATH.
 * Throws with install instructions if not found.
 */
export function validateCliPresence(): void {
  try {
    execSync("claude --version", { stdio: "pipe", timeout: 5000 });
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install it: npm install -g @anthropic-ai/claude-code\n" +
        "Then authenticate: claude auth login",
    );
  }
}

/**
 * Validate that the Claude CLI is authenticated.
 * Returns false and warns if not authenticated.
 *
 * @returns true if authenticated, false otherwise
 */
export function validateCliAuth(): boolean {
  try {
    execSync("claude auth status", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    console.warn(
      "[pi-claude-cli] Claude CLI is not authenticated. " +
        "Run 'claude auth login' to authenticate.",
    );
    return false;
  }
}
