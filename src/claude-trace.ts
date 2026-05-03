import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import { join } from "node:path";

let nextTraceId = 0;
let warnedTraceFailure = false;

export interface ClaudeTrace {
  dir: string;
  debugFile: string;
  writeMeta(meta: Record<string, unknown>): void;
  writeSystemPrompt(systemPrompt: string | undefined): void;
  appendStdin(line: string): void;
  appendStdoutLine(line: string): void;
  appendStderr(chunk: string): void;
  record(event: string, fields?: Record<string, unknown>): void;
}

export interface ClaudeTraceCreateOptions {
  modelId: string;
  cwd: string;
  effort?: string;
  resumeSessionId?: string;
  newSessionId?: string;
  mcpConfigPath?: string;
}

function traceRoot(): string | undefined {
  const root = process.env.PI_CLAUDE_CLI_TRACE_DIR?.trim();
  return root || undefined;
}

function safeWrite(path: PathLike, data: string, append = false): void {
  try {
    if (append) {
      appendFileSync(path, data, "utf-8");
    } else {
      writeFileSync(path, data, "utf-8");
    }
  } catch (err) {
    if (!warnedTraceFailure) {
      warnedTraceFailure = true;
      console.warn(
        `[pi-claude-cli] Claude trace write failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function jsonLine(value: unknown): string {
  try {
    return JSON.stringify(value) + "\n";
  } catch {
    return (
      JSON.stringify({
        event: "trace_json_serialize_error",
        timestamp: new Date().toISOString(),
      }) + "\n"
    );
  }
}

function envSummary(): Record<string, unknown> {
  return {
    hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasAnthropicAuthToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    hasClaudeConfigDir: Boolean(process.env.CLAUDE_CONFIG_DIR),
    claudeCodeSimple: process.env.CLAUDE_CODE_SIMPLE ?? null,
  };
}

export function createClaudeTrace(
  options: ClaudeTraceCreateOptions,
): ClaudeTrace | undefined {
  const root = traceRoot();
  if (!root) return undefined;

  try {
    mkdirSync(root, { recursive: true });
  } catch (err) {
    if (!warnedTraceFailure) {
      warnedTraceFailure = true;
      console.warn(
        `[pi-claude-cli] Could not create Claude trace root ${root}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return undefined;
  }

  const timestamp = new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const id = `${safeTimestamp}-pid-${process.pid}-${++nextTraceId}`;
  const dir = join(root, id);
  const debugFile = join(dir, "claude-debug.log");

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (!warnedTraceFailure) {
      warnedTraceFailure = true;
      console.warn(
        `[pi-claude-cli] Could not create Claude trace dir ${dir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return undefined;
  }

  const lifecyclePath = join(dir, "lifecycle.jsonl");
  const stdoutPath = join(dir, "stdout.ndjson");
  const stdinPath = join(dir, "stdin.ndjson");
  const stderrPath = join(dir, "stderr.log");
  const systemPromptPath = join(dir, "system-prompt.txt");
  const metaPath = join(dir, "meta.json");

  const baseMeta = {
    id,
    createdAt: timestamp,
    traceDir: dir,
    modelId: options.modelId,
    cwd: options.cwd,
    effort: options.effort,
    resumeSessionId: options.resumeSessionId,
    newSessionId: options.newSessionId,
    mcpConfigPath: options.mcpConfigPath,
    env: envSummary(),
  };

  const trace: ClaudeTrace = {
    dir,
    debugFile,
    writeMeta(meta) {
      safeWrite(
        metaPath,
        JSON.stringify({ ...baseMeta, ...meta }, null, 2) + "\n",
      );
    },
    writeSystemPrompt(systemPrompt) {
      safeWrite(systemPromptPath, systemPrompt ?? "");
      trace.record("write_system_prompt", {
        bytes: Buffer.byteLength(systemPrompt ?? "", "utf-8"),
        present: Boolean(systemPrompt),
      });
    },
    appendStdin(line) {
      safeWrite(stdinPath, line, true);
      trace.record("write_stdin", { bytes: Buffer.byteLength(line, "utf-8") });
    },
    appendStdoutLine(line) {
      safeWrite(stdoutPath, line.endsWith("\n") ? line : line + "\n", true);
      trace.record("stdout_line", { bytes: Buffer.byteLength(line, "utf-8") });
    },
    appendStderr(chunk) {
      safeWrite(stderrPath, chunk, true);
      trace.record("stderr", { bytes: Buffer.byteLength(chunk, "utf-8") });
    },
    record(event, fields = {}) {
      safeWrite(
        lifecyclePath,
        jsonLine({ timestamp: new Date().toISOString(), event, ...fields }),
        true,
      );
    },
  };

  trace.writeMeta({});
  trace.writeSystemPrompt(undefined);
  trace.record("created");
  return trace;
}
