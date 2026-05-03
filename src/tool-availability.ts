import { isBuiltInPiToolName, mapPiToolNameToClaude } from "./tool-mapping.js";

/**
 * Extract Claude built-in tool names from Pi's "Available tools" section.
 *
 * Returns undefined when the prompt does not look like a Pi harness prompt.
 * Returns [] when Pi advertised tools, but none map to Claude built-ins.
 */
export function extractAllowedClaudeTools(
  systemPrompt?: string,
): string[] | undefined {
  if (!systemPrompt) return undefined;

  const lines = systemPrompt.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "Available tools:");
  if (start < 0) return undefined;

  const allowed: string[] = [];
  const seen = new Set<string>();

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) break;

    const match = /^-\s*([A-Za-z0-9_-]+)\s*:/.exec(trimmed);
    if (!match) break;

    const piToolName = match[1];
    if (!isBuiltInPiToolName(piToolName)) continue;

    const claudeToolName = mapPiToolNameToClaude(piToolName);
    if (seen.has(claudeToolName)) continue;
    seen.add(claudeToolName);
    allowed.push(claudeToolName);
  }

  return allowed;
}
