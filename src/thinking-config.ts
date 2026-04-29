/**
 * Thinking effort configuration for mapping pi's ThinkingLevel to Claude CLI --effort flags.
 *
 * Pi's reasoning levels:    minimal | low | medium | high | xhigh
 * Claude CLI effort levels: low     | medium | high  | xhigh | max
 *
 * The mapping is model-family aware because not every Claude model treats every CLI
 * effort level the same way. Opus 4.7+ is the first family that documentably supports
 * `xhigh` (and `max`) as first-class effort levels for coding, so it gets the full,
 * 1:1 mapping. Older Opus and non-Opus models are mapped conservatively (capped at
 * CLI `high`) to avoid sending an effort level that may not be valid or may produce
 * surprising results.
 *
 * Two opt-in environment variables let users override the defaults explicitly:
 *
 *   PI_CLAUDE_CLI_EFFORT=<low|medium|high|xhigh|max>
 *     Hard-pin the CLI effort flag for every request that has reasoning enabled.
 *     Useful for "always max" style workflows.
 *
 *   PI_CLAUDE_CLI_MAX_MODE=1
 *     Promote Pi's `xhigh` to CLI `max` on Opus 4.7+ models only. Use this if you
 *     want your top Pi level to map to CLI's top level on Opus 4.7+. Older Opus and
 *     non-Opus models are unaffected.
 *
 * If both are set, PI_CLAUDE_CLI_EFFORT wins (it's the more explicit knob).
 *
 * When a remap happens (e.g. Pi `xhigh` capped to CLI `high` on a non-Opus model)
 * a one-time console.warn is emitted per (modelId, piLevel) pair so users are not
 * silently surprised.
 *
 * IMPORTANT: The CLI does NOT support --thinking-budget. Only --effort is supported.
 * Pi's `thinkingBudgets` option is ignored with a console.warn.
 */

import type { ThinkingLevel, ThinkingBudgets } from "@mariozechner/pi-ai";

/** CLI effort levels accepted by `claude --effort` (verified against CLI 2.1.123). */
export type CliEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Set of valid CLI effort levels for env-var validation. */
const VALID_CLI_EFFORTS: ReadonlySet<CliEffortLevel> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Coarse model-family classification for effort mapping.
 *
 * - `opus-4-7-plus`: Opus 4.7 and any newer Opus version (forward-compatible).
 *   Supports the full CLI effort range up to `xhigh` natively, and `max` via opt-in.
 * - `opus-pre-4-7`: Opus 4.0–4.6. Mapping is conservative (caps at CLI `high`)
 *   because `xhigh` was not part of the documented recommendation for these models.
 * - `non-opus`: Sonnet, Haiku, and anything else. Same conservative cap as pre-4.7
 *   Opus.
 */
export type ModelFamily = "opus-4-7-plus" | "opus-pre-4-7" | "non-opus";

/**
 * 1:1 truthful mapping for models that natively support all CLI effort levels
 * up to `xhigh`. This is the default for Opus 4.7+.
 */
const OPUS_4_7_PLUS_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/**
 * Conservative mapping for older Opus and non-Opus models. `xhigh` is downgraded
 * to `high` so we never send a CLI effort level the model may not handle well.
 * Users can still force a specific CLI level via `PI_CLAUDE_CLI_EFFORT=<level>`.
 */
const CONSERVATIVE_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
};

/**
 * Detect whether a model ID refers to an Opus model.
 * Uses includes('opus') for forward-compatibility with future Opus versions.
 */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes("opus");
}

/**
 * Classify a model id into a {@link ModelFamily}.
 *
 * Parses the major.minor version after `opus-` so that Opus 4.7, 4.8, 4.10, 5.x,
 * etc. are all recognised as `opus-4-7-plus` without needing code changes.
 *
 * Two layout flavours are supported:
 *
 *   Modern: "...opus-<major>[-<minor>][-<YYYYMMDD>][-suffix]"
 *     e.g. "claude-opus-4-7", "claude-opus-4-7-20260415", "claude-opus-5-1"
 *
 *   Legacy: "...<major>-opus[-<YYYYMMDD>]"
 *     e.g. "claude-3-opus-20240229", "claude-3-opus"
 *
 * Version components are restricted to 1–2 digits so an 8-digit date suffix
 * (which can sit immediately after `opus-`) is not mistaken for a version.
 *
 * Examples:
 *   "claude-opus-4-7"            -> "opus-4-7-plus"
 *   "claude-opus-4-7-20260415"   -> "opus-4-7-plus"
 *   "claude-opus-5"              -> "opus-4-7-plus"
 *   "claude-opus-4-6-20260301"   -> "opus-pre-4-7"
 *   "claude-opus-4-1-20250805"   -> "opus-pre-4-7"
 *   "claude-3-opus-20240229"     -> "opus-pre-4-7"
 *   "claude-sonnet-4-5"          -> "non-opus"
 *   "claude-haiku-4-5-20251001"  -> "non-opus"
 *
 * @param modelId - Model identifier from pi's catalog.
 * @returns The detected family. When the model is not Opus, returns `"non-opus"`.
 */
export function detectModelFamily(modelId: string | undefined): ModelFamily {
  if (!modelId || !isOpusModel(modelId)) return "non-opus";

  // Modern layout: `opus-<major>[-<minor>]` followed by either end-of-string,
  // a non-version separator (-, _), or a 6+ digit date.
  let major: number | undefined;
  let minor = 0;
  const modern = modelId.match(
    /opus-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{6,}|$|[-_])/,
  );
  if (modern) {
    major = Number(modern[1]);
    if (modern[2] !== undefined) minor = Number(modern[2]);
  } else {
    // Legacy layout: `<major>-opus` (e.g. claude-3-opus-20240229).
    const legacy = modelId.match(/(?:^|[-_])(\d{1,2})-opus(?!\w)/);
    if (legacy) major = Number(legacy[1]);
  }

  if (major === undefined || Number.isNaN(major)) return "opus-pre-4-7";
  if (major > 4) return "opus-4-7-plus";
  if (major === 4 && minor >= 7) return "opus-4-7-plus";
  return "opus-pre-4-7";
}

/**
 * Read the optional `PI_CLAUDE_CLI_EFFORT` override.
 *
 * Returns the validated CLI effort level when the env var is set and valid.
 * When set but invalid, a console.warn is emitted (once) and the override is
 * ignored. When unset or empty, returns undefined.
 */
function readEffortOverride(): CliEffortLevel | undefined {
  const raw = process.env.PI_CLAUDE_CLI_EFFORT;
  if (!raw) return undefined;
  const normalised = raw.trim().toLowerCase() as CliEffortLevel;
  if (VALID_CLI_EFFORTS.has(normalised)) return normalised;
  warnOnce(
    `invalid-effort-override:${raw}`,
    `[pi-claude-cli] PI_CLAUDE_CLI_EFFORT="${raw}" is not a valid CLI effort level. ` +
      `Expected one of: ${Array.from(VALID_CLI_EFFORTS).join(", ")}. Override ignored.`,
  );
  return undefined;
}

/**
 * Read the optional `PI_CLAUDE_CLI_MAX_MODE` flag.
 *
 * Truthy values: "1", "true", "yes", "on" (case-insensitive).
 * Anything else (unset, empty, "0", "false", etc.) returns false.
 */
function readMaxMode(): boolean {
  const raw = process.env.PI_CLAUDE_CLI_MAX_MODE;
  if (!raw) return false;
  const normalised = raw.trim().toLowerCase();
  return (
    normalised === "1" ||
    normalised === "true" ||
    normalised === "yes" ||
    normalised === "on"
  );
}

/** Dedup set so the same remap warning fires at most once per process. */
const warnedKeys = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

/**
 * Reset the warning dedup cache. Exported for tests; not part of the public
 * runtime contract.
 */
export function _resetWarnDedupCache(): void {
  warnedKeys.clear();
}

/**
 * Map pi's ThinkingLevel to a CLI effort string.
 *
 * Behaviour:
 *
 * 1. If `reasoning` is undefined, returns undefined so `--effort` is omitted and
 *    Claude CLI uses its session/CLI default.
 * 2. If `PI_CLAUDE_CLI_EFFORT` is set to a valid CLI level, that value is used
 *    verbatim regardless of model.
 * 3. Otherwise, the level is looked up in the family-specific mapping table:
 *    - Opus 4.7+: 1:1 mapping including `xhigh`. With `PI_CLAUDE_CLI_MAX_MODE=1`,
 *      Pi `xhigh` is promoted to CLI `max`.
 *    - Pre-4.7 Opus and non-Opus: conservative mapping that caps at CLI `high`.
 * 4. When a remap happens (the resolved CLI level differs from the literal
 *    name of the Pi level), a one-time `console.warn` is emitted explaining
 *    what happened so the user is not silently surprised.
 *
 * @param reasoning - Pi's thinking level (undefined = omit flag).
 * @param modelId - Model ID for family detection.
 * @param thinkingBudgets - Custom budgets (logged as unsupported, not applied).
 * @returns CLI effort level string, or undefined if `--effort` should be omitted.
 */
export function mapThinkingEffort(
  reasoning?: ThinkingLevel,
  modelId?: string,
  thinkingBudgets?: ThinkingBudgets,
): CliEffortLevel | undefined {
  if (reasoning === undefined) {
    return undefined; // omit --effort flag entirely
  }

  if (thinkingBudgets && Object.keys(thinkingBudgets).length > 0) {
    warnOnce(
      "thinking-budgets-unsupported",
      "[pi-claude-cli] Custom thinkingBudgets are not supported with the Claude Code CLI subprocess. " +
        "The CLI uses --effort levels instead of token budgets. Budgets will be ignored.",
    );
  }

  // Explicit override always wins.
  const override = readEffortOverride();
  if (override) {
    warnOnce(
      `override:${override}`,
      `[pi-claude-cli] PI_CLAUDE_CLI_EFFORT=${override} is set; sending --effort ${override} ` +
        `for every request regardless of the Pi thinking level.`,
    );
    return override;
  }

  const family = detectModelFamily(modelId);
  const baseMap =
    family === "opus-4-7-plus" ? OPUS_4_7_PLUS_MAP : CONSERVATIVE_MAP;
  let resolved = baseMap[reasoning];

  // Optional max-mode promotion for Opus 4.7+ only.
  if (family === "opus-4-7-plus" && reasoning === "xhigh" && readMaxMode()) {
    resolved = "max";
  }

  // Warn if the Pi level name does not match the resolved CLI level name.
  // (e.g. Pi `xhigh` resolves to CLI `high` on non-Opus.)
  if (resolved !== reasoning) {
    const key = `remap:${family}:${reasoning}->${resolved}`;
    warnOnce(
      key,
      `[pi-claude-cli] Pi thinking level "${reasoning}" remapped to Claude CLI ` +
        `--effort ${resolved} for model family "${family}"` +
        (modelId ? ` (model: ${modelId})` : "") +
        `. Set PI_CLAUDE_CLI_EFFORT=<level> to override or PI_CLAUDE_CLI_MAX_MODE=1 ` +
        `to promote xhigh to max on Opus 4.7+.`,
    );
  }

  return resolved;
}
