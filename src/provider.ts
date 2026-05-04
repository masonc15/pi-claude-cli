/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context
 * 2. Spawns a Claude CLI subprocess with correct flags
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages and cleans up the subprocess
 * 7. Implements break-early: kills subprocess at message_stop when
 *    built-in or custom-tools MCP tool_use blocks are seen
 * 8. Hardened lifecycle: inactivity timeout, subprocess exit handler,
 *    streamEnded guard, abort via SIGKILL, process registry
 */

import { createInterface } from "node:readline";
import {
  AssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
} from "@mariozechner/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
} from "./prompt-builder.js";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { handleControlRequest } from "./control-handler.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
import { extractAllowedClaudeTools } from "./tool-availability.js";
import { createClaudeTrace } from "./claude-trace.js";
import type { ClaudeRateLimitEventMessage } from "./types.js";
/**
 * Inactivity timeout: kill the subprocess if no stdout for this long.
 *
 * Six minutes is generous because Opus 4.7 with `--effort xhigh` regularly
 * spends 3+ minutes generating a single response (interleaved thinking +
 * tool input streaming), and one upstream stall during that response should
 * not nuke the whole turn. The timer resets on every line of stdout, so
 * actively-streaming responses never trip it.
 */
const INACTIVITY_TIMEOUT_MS = 360_000;

/** Pi provider id this extension registers under. Used to detect whether a
 *  prior assistant turn went through this extension and therefore left a
 *  Claude CLI session file on disk that we can `--resume`. */
const PI_CLAUDE_CLI_PROVIDER_ID = "pi-claude-cli";

/**
 * Marker prefix on repair-notice text blocks. Used both to identify the
 * notice in pi's persisted history (so the next turn skips `--resume` and
 * rebuilds the full prompt — the CLI's own session file does not contain
 * this synthetic block) and to make the notice greppable in pi's logs.
 */
const TRUNCATION_NOTICE_MARKER = "[pi-claude-cli notice]";

type ClaudeRateLimitInfo = NonNullable<
  ClaudeRateLimitEventMessage["rate_limit_info"]
>;

function timeoutOverrideMs(): number | undefined {
  const raw = process.env.PI_CLAUDE_CLI_TIMEOUT_MS?.trim();
  if (!raw) return undefined;

  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;

  console.warn(
    `[pi-claude-cli] PI_CLAUDE_CLI_TIMEOUT_MS="${raw}" is not a positive number; using default timeout`,
  );
  return undefined;
}

function resolveTimeoutMs(optionsTimeoutMs: unknown): number {
  if (
    typeof optionsTimeoutMs === "number" &&
    Number.isFinite(optionsTimeoutMs) &&
    optionsTimeoutMs > 0
  ) {
    return optionsTimeoutMs;
  }

  return timeoutOverrideMs() ?? INACTIVITY_TIMEOUT_MS;
}

function extractTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return "";
    })
    .join("");

  return text || undefined;
}

function assistantErrorMessage(msg: unknown): string | undefined {
  if (
    !msg ||
    typeof msg !== "object" ||
    (msg as { type?: unknown }).type !== "assistant"
  ) {
    return undefined;
  }

  const error = (msg as { error?: unknown }).error;
  if (typeof error !== "string" || !error) return undefined;

  const text = extractTextContent(
    (msg as { message?: { content?: unknown } }).message?.content,
  );

  return text ? `Claude CLI ${error}: ${text}` : `Claude CLI ${error}`;
}

function resultEnvelopeErrorMessage(msg: unknown): string {
  const result =
    typeof (msg as { result?: unknown }).result === "string"
      ? (msg as { result: string }).result
      : undefined;
  const error =
    typeof (msg as { error?: unknown }).error === "string"
      ? (msg as { error: string }).error
      : undefined;
  const status = (msg as { api_error_status?: unknown }).api_error_status;
  const message = error ?? result ?? "Unknown error from Claude CLI";

  return typeof status === "number" && Number.isFinite(status)
    ? `Claude CLI API error ${status}: ${message}`
    : `Claude CLI API error: ${message}`;
}

function formatRateLimitWindow(rateLimitType?: string): string {
  switch (rateLimitType) {
    case "five_hour":
      return "5-hour";
    case "seven_day":
      return "7-day";
    default:
      return rateLimitType ? rateLimitType.replace(/_/g, " ") : "rate-limit";
  }
}

function formatRateLimitReset(resetsAt?: number): string | undefined {
  if (
    typeof resetsAt !== "number" ||
    !Number.isFinite(resetsAt) ||
    resetsAt <= 0
  ) {
    return undefined;
  }
  return new Date(resetsAt * 1000).toISOString();
}

function formatRateLimitNotice(
  info: ClaudeRateLimitInfo | undefined,
): string | undefined {
  if (!info) return undefined;

  const status =
    typeof info.status === "string" ? info.status.toLowerCase() : "";
  const utilization =
    typeof info.utilization === "number" && Number.isFinite(info.utilization)
      ? info.utilization
      : undefined;
  const shouldNotice =
    info.isUsingOverage === true ||
    status.includes("warning") ||
    (utilization !== undefined && utilization >= 0.9);

  if (!shouldNotice) return undefined;

  const percent =
    utilization !== undefined ? Math.round(utilization * 100) : undefined;
  const windowLabel = formatRateLimitWindow(info.rateLimitType);
  const reset = formatRateLimitReset(info.resetsAt);
  const usageText =
    percent !== undefined ? ` is at ${percent}%` : " is near its limit";
  const consequence =
    info.isUsingOverage === true ||
    (utilization !== undefined && utilization >= 1)
      ? "This request was allowed; if extra usage is enabled, continued requests may bill as extra usage until the reset."
      : "This request was allowed, but continued requests may hit the included limit soon.";

  return (
    `${TRUNCATION_NOTICE_MARKER} Claude Code ${windowLabel} included usage` +
    `${usageText}${reset ? `; reset: ${reset}` : ""}. ${consequence}`
  );
}

function appendRateLimitNotice<T extends { content?: unknown[] }>(
  message: T,
  notice: string | undefined,
): T {
  if (!notice) return message;
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    ...message,
    content: [...content, { type: "text", text: notice }],
  };
}

/**
 * Detect tool calls whose `arguments` is a string instead of an object.
 *
 * EventBridge.finalize() falls back to the raw partialJson string when a
 * tool_use block ends without a parseable JSON object — typically because
 * the upstream Claude CLI stream truncated mid-tool-input (inactivity
 * timeout, upstream stall, output token budget exhausted by xhigh thinking).
 * Pi-ai's AJV validator then rejects the call with "must be object" and the
 * model retries blindly with no signal that its tool input was cut off.
 *
 * To make the failure actionable, replace each truncated tool_use block with
 * a text block describing what happened and what was captured, log a warning
 * to pi's console, and force stopReason to "stop" so pi treats it as a
 * normal text response. The model sees the explanation in its next-turn
 * context and can switch strategy (smaller payload, Bash heredoc, etc.).
 *
 * Returns the (possibly modified) AssistantMessage and a flag indicating
 * whether any truncation was detected. Idempotent and safe on messages with
 * no tool calls.
 */
function repairTruncatedToolCalls<T extends { content?: unknown[] }>(
  message: T,
): { message: T; truncated: boolean } {
  const content = message.content;
  if (!Array.isArray(content) || content.length === 0) {
    return { message, truncated: false };
  }

  const partial: Array<{ name: string; partial: string }> = [];
  const repaired: unknown[] = [];

  for (const block of content) {
    const b = block as any;
    if (b?.type === "toolCall" && typeof b.arguments === "string") {
      partial.push({
        name: String(b.name ?? "unknown"),
        partial: b.arguments,
      });
      continue; // drop the malformed tool_use; replaced with a text block below
    }
    repaired.push(block);
  }

  if (partial.length === 0) {
    return { message, truncated: false };
  }

  const summary = partial
    .map((p) => {
      const head =
        p.partial.length > 200 ? p.partial.slice(0, 200) + "…" : p.partial;
      return `${p.name}(${head})`;
    })
    .join("; ");

  console.warn(
    `[pi-claude-cli] Stream truncated mid-tool-call: ${partial.length} tool ` +
      `block(s) had unparseable JSON args after the bridge finalized. The Claude ` +
      `CLI subprocess ended before content_block_stop fired for these blocks. ` +
      `Likely causes: inactivity timeout, upstream API stall, or output token ` +
      `budget exhausted by xhigh thinking. Partial input captured: ${summary}`,
  );

  repaired.push({
    type: "text",
    text:
      `${TRUNCATION_NOTICE_MARKER} Tool call was cut off mid-stream before ` +
      `the arguments finished generating. Partial input captured: ${summary}. ` +
      `The CLI subprocess ended before emitting content_block_stop — ` +
      `most likely the response exceeded the model's output token budget ` +
      `(xhigh thinking can consume most of it) or the upstream stream ` +
      `stalled. Try a smaller payload: write the file via Bash heredoc ` +
      `or split the content across multiple smaller Write calls.`,
  });

  return {
    message: { ...message, content: repaired } as T,
    truncated: true,
  };
}

/**
 * Determine whether the most recent assistant turn in `messages` went through
 * this extension. Pi attaches `provider` and `api` to every assistant message
 * (see `AssistantMessage` in @mariozechner/pi-ai), so we can scan backwards
 * for the last assistant entry and check.
 *
 * Returns false when the last assistant turn was from a different provider
 * (e.g. user switched mid-session from `kimi-coding` to `pi-claude-cli`),
 * because Claude CLI has no session file matching pi's session id and
 * `--resume <id>` would silently produce an empty response.
 *
 * Returns false when there is no prior assistant turn at all — caller should
 * already gate on `context.messages.length > 1`, but this is the safer answer
 * either way.
 */
function lastAssistantWasViaThisExtension(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    return (
      m.provider === PI_CLAUDE_CLI_PROVIDER_ID ||
      m.api === PI_CLAUDE_CLI_PROVIDER_ID
    );
  }
  return false;
}

/**
 * Detect whether the most recent assistant message contains a truncation
 * repair notice (a text block emitted by `repairTruncatedToolCalls`).
 *
 * When this is true the next turn must NOT use `--resume`. The Claude CLI's
 * persisted session file only sees what the CLI itself recorded for the
 * killed turn (typically a stub like "No response requested.") — it never
 * received our synthetic notice or the partial tool args. If we resumed,
 * `buildResumePrompt` would only forward trailing tool results plus the new
 * user message, so the model would never see the explanation and would
 * retry the same oversized tool call blindly.
 *
 * Falling back to a fresh CLI session re-flattens the full pi history
 * (including the notice text) into the prompt via `buildPrompt`, so the
 * model sees what happened and can switch strategy.
 */
function lastAssistantHasTruncationNotice(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (!Array.isArray(m.content)) return false;
    return m.content.some(
      (b: any) =>
        b?.type === "text" &&
        typeof b.text === "string" &&
        b.text.includes(TRUNCATION_NOTICE_MARKER),
    );
  }
  return false;
}

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
};

type ErrorStopReason = Extract<StopReason, "error" | "aborted">;

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any built-in or custom-tools MCP tool was seen, kills
 * the subprocess before Claude CLI can auto-execute the tools.
 *
 * Hardened with: inactivity timeout (360s), subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via SIGKILL, and
 * process registry integration for teardown cleanup.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();

  (async () => {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let abortHandler: (() => void) | undefined;
    let bridge: ReturnType<typeof createEventBridge> | undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let streamEnded = false;
    let broken = false;
    let resultReceived = false;
    let processClosed = false;
    let rateLimitNotice: string | undefined;
    let resolveProcessClose: () => void = () => {};
    const processClosePromise = new Promise<void>((resolve) => {
      resolveProcessClose = resolve;
    });

    function emptyUsage(): AssistantMessage["usage"] {
      return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      };
    }

    function buildErrorMessage(
      errMsg: string,
      reason: ErrorStopReason,
    ): AssistantMessage {
      if (!bridge) {
        return {
          role: "assistant",
          content: [{ type: "text", text: `Error: ${errMsg}` }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: reason,
          errorMessage: errMsg,
          timestamp: Date.now(),
        };
      }

      // Close out any in-flight tool_use blocks so partial args are not
      // dropped when the stream ends without a content_block_stop.
      bridge.finalize();
      const output = bridge.getOutput();
      const baseContent = output.content?.length
        ? output.content
        : [{ type: "text" as const, text: `Error: ${errMsg}` }];
      const repaired = repairTruncatedToolCalls({
        ...output,
        content: baseContent,
        stopReason: reason,
      });
      const message = appendRateLimitNotice(repaired.message, rateLimitNotice);

      return {
        ...message,
        stopReason: reason,
        errorMessage: errMsg,
      };
    }

    function endStreamWithError(
      errMsg: string,
      reason: ErrorStopReason = "error",
    ) {
      if (streamEnded || broken) return;
      streamEnded = true;
      stream.push({
        type: "error",
        reason,
        error: buildErrorMessage(errMsg, reason),
      });
      stream.end();
    }

    try {
      const cwd = options?.cwd ?? process.cwd();
      const inactivityTimeoutMs = resolveTimeoutMs(options?.timeoutMs);

      // Resume only if pi provides a session ID AND a prior assistant turn in
      // this conversation went through pi-claude-cli. Pi passes sessionId on
      // every call (including the first), but we can only --resume a Claude
      // CLI session that already exists on disk; if the most recent assistant
      // turn went through a different provider (e.g. the user switched models
      // mid-session), Claude CLI has no matching session file and `--resume`
      // produces an empty response with zero tokens. Falling back to a fresh
      // call rebuilds the full conversation history into the prompt instead.
      //
      // Also skip resume when the last assistant turn carries a truncation
      // repair notice — the CLI's session file does not contain that
      // synthetic block, so resuming would hide the notice from the model
      // and the next turn would retry the same oversized tool call.
      const resumeSessionId =
        options?.sessionId &&
        context.messages.length > 1 &&
        lastAssistantWasViaThisExtension(context.messages) &&
        !lastAssistantHasTruncationNotice(context.messages)
          ? options.sessionId
          : undefined;

      // Build prompt: if resuming, only send the latest user turn;
      // otherwise build the full flattened conversation history
      const prompt = resumeSessionId
        ? buildResumePrompt(context)
        : buildPrompt(context);
      const fullSystemPrompt = buildSystemPrompt(context, cwd);
      const systemPrompt = resumeSessionId ? undefined : fullSystemPrompt;
      const allowedTools = extractAllowedClaudeTools(fullSystemPrompt);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      const trace = createClaudeTrace({
        modelId: model.id,
        cwd,
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
      });
      trace?.writeSystemPrompt(systemPrompt || undefined);
      trace?.record("prompt_built", {
        resume: Boolean(resumeSessionId),
        promptKind: Array.isArray(prompt) ? "content_blocks" : "text",
        promptBytes: Buffer.byteLength(
          typeof prompt === "string" ? prompt : JSON.stringify(prompt),
          "utf-8",
        ),
      });

      // Spawn subprocess
      proc = spawnClaude(model.id, systemPrompt || undefined, {
        cwd,
        signal: options?.signal,
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
        allowedTools,
        trace,
      });
      const getStderr = captureStderr(proc);
      proc.stderr!.on("data", (data: Buffer) => {
        trace?.appendStderr(data.toString());
      });

      // Register in global process registry for teardown cleanup
      registerProcess(proc);

      // Create event bridge before installing lifecycle handlers so every
      // failure path can return a normal assistant-shaped error payload.
      const eventBridge = createEventBridge(stream, model);
      bridge = eventBridge;

      // Track tool_use blocks for break-early decision at message_stop
      let sawBuiltInOrCustomTool = false;
      let sawAssistantStreamEvent = false;

      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      // Handle process error -- attach before stdin write so fast spawn
      // failures cannot close before the provider sees them.
      proc.on("error", (err: Error) => {
        if (broken) return; // Break-early killed the process intentionally
        trace?.record("error", { message: err.message });
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- attach before stdin write so immediate
      // CLI crashes are surfaced instead of becoming empty successful turns.
      proc.on("close", (code: number | null, signal: string | null) => {
        trace?.record("close", { code, signal });
        processClosed = true;
        resolveProcessClose();
        clearTimeout(inactivityTimer);
        if (broken) return; // Break-early kill, expected
        if (code !== 0 && code !== null) {
          const stderr = getStderr();
          const message = stderr
            ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
            : `Claude CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        }
      });

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          trace?.record("inactivity_timeout", {
            timeoutMs: inactivityTimeoutMs,
          });
          forceKillProcess(proc!);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${inactivityTimeoutMs / 1000} seconds`,
          );
        }, inactivityTimeoutMs);
      }

      // Set up abort signal handler -- uses SIGKILL for immediate force-kill
      if (options?.signal) {
        abortHandler = () => {
          trace?.record("abort");
          if (proc) {
            forceKillProcess(proc);
          }
          clearTimeout(inactivityTimer);
          endStreamWithError("Claude CLI subprocess aborted", "aborted");
        };

        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Write user message only after failure handlers and stdout reader are
      // attached; fake/real CLIs can fail immediately.
      writeUserMessage(proc, prompt, (line) => trace?.appendStdin(line));

      // Start inactivity timer after writing user message
      resetInactivityTimer();

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        trace?.appendStdoutLine(line);

        if (broken) return; // Guard: ignore buffered lines after break-early

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        trace?.record("parsed_stdout", {
          type: (msg as any).type,
          subtype: (msg as any).subtype,
          streamEventType: (msg as any).event?.type,
          toolName: (msg as any).event?.content_block?.name,
          parentToolUseId: (msg as any).parent_tool_use_id ?? null,
        });

        const assistantError = assistantErrorMessage(msg);
        if (assistantError) {
          trace?.record("assistant_error", {
            error: (msg as any).error,
          });
          clearTimeout(inactivityTimer);
          forceKillProcess(proc!);
          endStreamWithError(assistantError);
          rl.close();
          return;
        }

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !(msg as any).parent_tool_use_id;
          if (isTopLevel) {
            sawAssistantStreamEvent = true;
            eventBridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName && isPiKnownClaudeTool(toolName)) {
              // Built-in tool (Read/Write/etc.) OR custom MCP tool (mcp__custom-tools__*)
              // Internal Claude Code tools (ToolSearch, Task, etc.) are excluded
              sawBuiltInOrCustomTool = true;
              trace?.record("pi_known_tool_use_seen", { toolName });
            }
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawBuiltInOrCustomTool
          ) {
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            trace?.record("break_early", {
              reason: "pi_will_execute_tool",
            });
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(proc!);
            rl.close();
            return; // Don't process further -- done event already pushed by event bridge
          }
        } else if (msg.type === "control_request") {
          const allowed = handleControlRequest(msg, proc!.stdin!, (line) => {
            trace?.appendStdin(line);
            trace?.record("control_response", {
              requestId: (msg as any).request_id,
              toolName: (msg as any).request?.tool_name,
            });
          });
          trace?.record("control_request", {
            requestId: (msg as any).request_id,
            toolName: (msg as any).request?.tool_name,
            allowed,
          });
        } else if (msg.type === "rate_limit_event") {
          rateLimitNotice =
            formatRateLimitNotice(msg.rate_limit_info) ?? rateLimitNotice;
          if (rateLimitNotice) {
            trace?.record("rate_limit_notice", {
              notice: rateLimitNotice,
              info: msg.rate_limit_info,
            });
          }
        } else if (msg.type === "result") {
          resultReceived = true;
          trace?.record("result", {
            subtype: msg.subtype,
            isError: (msg as any).is_error === true,
            apiErrorStatus: (msg as any).api_error_status ?? null,
            hasAssistantStreamEvent: sawAssistantStreamEvent,
          });
          if (msg.subtype === "error") {
            endStreamWithError(msg.error ?? "Unknown error from Claude CLI");
            clearTimeout(inactivityTimer);
            forceKillProcess(proc!);
            rl.close();
            return;
          } else if ((msg as any).is_error === true) {
            endStreamWithError(resultEnvelopeErrorMessage(msg));
            clearTimeout(inactivityTimer);
            forceKillProcess(proc!);
            rl.close();
            return;
          } else if (!sawAssistantStreamEvent) {
            endStreamWithError(
              "Claude CLI returned success without assistant stream events",
            );
          }
          // For both success and error: clean up the subprocess
          clearTimeout(inactivityTimer);
          cleanupProcess(proc!);
          rl.close();
        }
      });

      // Wait for readline to close (result received or process ended)
      await new Promise<void>((resolve) => {
        rl.on("close", resolve);
      });

      // Some fast CLI failures close stdout before Node emits the child
      // process `close` event. Give that event a tiny chance to report a
      // non-zero exit before treating stdout EOF as a successful truncation.
      if (!streamEnded && !resultReceived && !processClosed) {
        await Promise.race([
          processClosePromise,
          new Promise((resolve) => setTimeout(resolve, 25)),
        ]);
      }

      if (
        !streamEnded &&
        !resultReceived &&
        !broken &&
        !sawAssistantStreamEvent
      ) {
        clearTimeout(inactivityTimer);
        const stderr = getStderr().trim();
        const message = stderr
          ? `Claude CLI exited without a result event: ${stderr}`
          : "Claude CLI exited without a result event";
        endStreamWithError(message);
      }

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        // Close out any in-flight tool_use blocks so partial args are not
        // dropped when the stream ends without a content_block_stop.
        eventBridge.finalize();
        const output = eventBridge.getOutput();

        // Convert any truncated tool_use blocks (string-valued args from
        // finalize fallback) into a text notice the model can see and act
        // on. `truncated` lets us downgrade stopReason to "stop" so pi
        // doesn't try to execute the dropped tool call.
        const repaired = repairTruncatedToolCalls({
          ...output,
          stopReason: output.stopReason,
        });
        const message = appendRateLimitNotice(
          repaired.message,
          rateLimitNotice,
        );

        // If stopReason is toolUse but there are no pi-known tool calls in
        // content, it means only user MCP tools were called (filtered by
        // event bridge) OR every tool_use was truncated and stripped above.
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (message.content || []).filter(
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          repaired.truncated ||
          (output.stopReason === "toolUse" && piToolCalls.length === 0)
            ? "stop"
            : output.stopReason;

        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...message, stopReason: effectiveReason },
        });
        stream.end();
      }
    } catch (err: any) {
      // `trace` is scoped inside the try block so unexpected setup failures
      // before it exists are reported through the normal stream error path.
      endStreamWithError(err.message ?? "Unexpected error in streamViaCli");
    } finally {
      // Clean up abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      cleanupSystemPromptFile();
    }
  })();

  return stream;
}
