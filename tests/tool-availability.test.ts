import { describe, expect, it } from "vitest";
import { extractAllowedClaudeTools } from "../src/tool-availability";

describe("extractAllowedClaudeTools", () => {
  it("maps Pi's read-only tool section to Claude Read", () => {
    const systemPrompt = [
      "Available tools:",
      "- read: Read file contents",
      "",
      "Guidelines:",
    ].join("\n");

    expect(extractAllowedClaudeTools(systemPrompt)).toEqual(["Read"]);
  });

  it("maps and deduplicates Pi built-in tool names", () => {
    const systemPrompt = [
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute a command",
      "- find: Find files",
      "- glob: Find files too",
      "- deploy: Custom project tool",
      "",
    ].join("\n");

    expect(extractAllowedClaudeTools(systemPrompt)).toEqual([
      "Read",
      "Bash",
      "Glob",
    ]);
  });

  it("returns an empty list when the section exists but has no built-ins", () => {
    const systemPrompt = [
      "Available tools:",
      "- deploy: Custom project tool",
      "",
      "Guidelines:",
    ].join("\n");

    expect(extractAllowedClaudeTools(systemPrompt)).toEqual([]);
  });

  it("returns undefined when no Pi tool section is present", () => {
    expect(extractAllowedClaudeTools("No tool section here.")).toBeUndefined();
  });
});
