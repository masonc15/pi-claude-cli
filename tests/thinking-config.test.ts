import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mapThinkingEffort,
  isOpusModel,
  detectModelFamily,
  _resetWarnDedupCache,
} from "../src/thinking-config";
import type { ThinkingBudgets } from "@mariozechner/pi-ai";

// Snapshot the env vars we mutate so tests are isolated.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Restore env, then strip our knobs so each test starts from a clean baseline.
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PI_CLAUDE_CLI_EFFORT;
  delete process.env.PI_CLAUDE_CLI_MAX_MODE;
  _resetWarnDedupCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("isOpusModel", () => {
  it("returns true for claude-opus-4-6-20260301", () => {
    expect(isOpusModel("claude-opus-4-6-20260301")).toBe(true);
  });

  it("returns true for claude-opus-4-7", () => {
    expect(isOpusModel("claude-opus-4-7")).toBe(true);
  });

  it("returns false for claude-sonnet-4-5-20250929", () => {
    expect(isOpusModel("claude-sonnet-4-5-20250929")).toBe(false);
  });

  it("returns false for claude-haiku-4-5-20251001", () => {
    expect(isOpusModel("claude-haiku-4-5-20251001")).toBe(false);
  });
});

describe("detectModelFamily", () => {
  it("recognises Opus 4.7 as opus-4-7-plus", () => {
    expect(detectModelFamily("claude-opus-4-7")).toBe("opus-4-7-plus");
    expect(detectModelFamily("claude-opus-4-7-20260415")).toBe("opus-4-7-plus");
  });

  it("recognises Opus 4.8 / 4.10 / 5.x as opus-4-7-plus (forward-compat)", () => {
    expect(detectModelFamily("claude-opus-4-8")).toBe("opus-4-7-plus");
    expect(detectModelFamily("claude-opus-4-10")).toBe("opus-4-7-plus");
    expect(detectModelFamily("claude-opus-5")).toBe("opus-4-7-plus");
    expect(detectModelFamily("claude-opus-5-1")).toBe("opus-4-7-plus");
    expect(detectModelFamily("claude-opus-6-2-20290101")).toBe("opus-4-7-plus");
  });

  it("recognises Opus 4.0–4.6 as opus-pre-4-7", () => {
    expect(detectModelFamily("claude-opus-4")).toBe("opus-pre-4-7");
    expect(detectModelFamily("claude-opus-4-1-20250805")).toBe("opus-pre-4-7");
    expect(detectModelFamily("claude-opus-4-5-20251101")).toBe("opus-pre-4-7");
    expect(detectModelFamily("claude-opus-4-6")).toBe("opus-pre-4-7");
    expect(detectModelFamily("claude-opus-4-6-20260301")).toBe("opus-pre-4-7");
  });

  it("recognises Opus 3.x as opus-pre-4-7", () => {
    expect(detectModelFamily("claude-opus-3-5")).toBe("opus-pre-4-7");
    expect(detectModelFamily("claude-3-opus-20240229")).toBe("opus-pre-4-7");
  });

  it("returns non-opus for Sonnet/Haiku/anything else", () => {
    expect(detectModelFamily("claude-sonnet-4-5")).toBe("non-opus");
    expect(detectModelFamily("claude-sonnet-4-6")).toBe("non-opus");
    expect(detectModelFamily("claude-haiku-4-5-20251001")).toBe("non-opus");
    expect(detectModelFamily("gpt-5")).toBe("non-opus");
  });

  it("returns non-opus for undefined/empty model id", () => {
    expect(detectModelFamily(undefined)).toBe("non-opus");
    expect(detectModelFamily("")).toBe("non-opus");
  });
});

describe("mapThinkingEffort", () => {
  describe("undefined reasoning", () => {
    it("returns undefined when reasoning is undefined", () => {
      expect(
        mapThinkingEffort(undefined, "claude-sonnet-4-5", undefined),
      ).toBeUndefined();
    });

    it("returns undefined regardless of model", () => {
      expect(
        mapThinkingEffort(undefined, "claude-opus-4-7", undefined),
      ).toBeUndefined();
    });

    it("returns undefined even when PI_CLAUDE_CLI_EFFORT is set", () => {
      // Override only kicks in when reasoning is explicitly enabled. If pi
      // doesn't ask for thinking at all, we still omit --effort.
      process.env.PI_CLAUDE_CLI_EFFORT = "max";
      expect(
        mapThinkingEffort(undefined, "claude-opus-4-7", undefined),
      ).toBeUndefined();
    });
  });

  describe("Opus 4.7+ (truthful 1:1 mapping)", () => {
    const model = "claude-opus-4-7";

    it("maps minimal -> low", () => {
      expect(mapThinkingEffort("minimal", model)).toBe("low");
    });

    it("maps low -> low", () => {
      expect(mapThinkingEffort("low", model)).toBe("low");
    });

    it("maps medium -> medium (no longer silently shifted up)", () => {
      expect(mapThinkingEffort("medium", model)).toBe("medium");
    });

    it("maps high -> high (no longer silently shifted up)", () => {
      expect(mapThinkingEffort("high", model)).toBe("high");
    });

    it("maps xhigh -> xhigh (no longer silently promoted to max)", () => {
      expect(mapThinkingEffort("xhigh", model)).toBe("xhigh");
    });

    it("works on a future Opus 5.x model id", () => {
      expect(mapThinkingEffort("xhigh", "claude-opus-5")).toBe("xhigh");
      expect(mapThinkingEffort("medium", "claude-opus-5-1")).toBe("medium");
    });
  });

  describe("Pre-4.7 Opus (conservative cap)", () => {
    const model = "claude-opus-4-6-20260301";

    it("maps minimal -> low", () => {
      expect(mapThinkingEffort("minimal", model)).toBe("low");
    });

    it("maps low -> low", () => {
      expect(mapThinkingEffort("low", model)).toBe("low");
    });

    it("maps medium -> medium", () => {
      expect(mapThinkingEffort("medium", model)).toBe("medium");
    });

    it("maps high -> high", () => {
      expect(mapThinkingEffort("high", model)).toBe("high");
    });

    it("caps xhigh at high (downgrade)", () => {
      expect(mapThinkingEffort("xhigh", model)).toBe("high");
    });
  });

  describe("Non-Opus (conservative cap)", () => {
    const model = "claude-sonnet-4-5";

    it("maps minimal -> low", () => {
      expect(mapThinkingEffort("minimal", model)).toBe("low");
    });

    it("maps low -> low", () => {
      expect(mapThinkingEffort("low", model)).toBe("low");
    });

    it("maps medium -> medium", () => {
      expect(mapThinkingEffort("medium", model)).toBe("medium");
    });

    it("maps high -> high", () => {
      expect(mapThinkingEffort("high", model)).toBe("high");
    });

    it("caps xhigh at high", () => {
      expect(mapThinkingEffort("xhigh", model)).toBe("high");
    });

    it("uses conservative mapping when modelId is undefined", () => {
      expect(mapThinkingEffort("xhigh", undefined)).toBe("high");
      expect(mapThinkingEffort("medium", undefined)).toBe("medium");
    });
  });

  describe("PI_CLAUDE_CLI_EFFORT override", () => {
    it("forces max regardless of model family", () => {
      process.env.PI_CLAUDE_CLI_EFFORT = "max";
      expect(mapThinkingEffort("low", "claude-sonnet-4-5")).toBe("max");
      expect(mapThinkingEffort("xhigh", "claude-opus-4-6")).toBe("max");
      expect(mapThinkingEffort("minimal", "claude-opus-4-7")).toBe("max");
    });

    it("forces xhigh regardless of model family", () => {
      process.env.PI_CLAUDE_CLI_EFFORT = "xhigh";
      expect(mapThinkingEffort("medium", "claude-sonnet-4-5")).toBe("xhigh");
      expect(mapThinkingEffort("low", "claude-opus-4-6")).toBe("xhigh");
    });

    it("normalises case and whitespace", () => {
      process.env.PI_CLAUDE_CLI_EFFORT = "  Max  ";
      expect(mapThinkingEffort("low", "claude-sonnet-4-5")).toBe("max");
    });

    it("ignores invalid values and falls back to default mapping", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.PI_CLAUDE_CLI_EFFORT = "ultra";
      expect(mapThinkingEffort("xhigh", "claude-opus-4-7")).toBe("xhigh");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('PI_CLAUDE_CLI_EFFORT="ultra"'),
      );
    });

    it("ignores empty string and uses default mapping", () => {
      process.env.PI_CLAUDE_CLI_EFFORT = "";
      expect(mapThinkingEffort("medium", "claude-opus-4-7")).toBe("medium");
    });

    it("emits a one-time warning when the override fires", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.PI_CLAUDE_CLI_EFFORT = "max";
      mapThinkingEffort("low", "claude-sonnet-4-5");
      mapThinkingEffort("high", "claude-opus-4-7");
      const overrideWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("PI_CLAUDE_CLI_EFFORT=max is set"),
      );
      expect(overrideWarnings).toHaveLength(1);
    });
  });

  describe("PI_CLAUDE_CLI_MAX_MODE override", () => {
    it("promotes xhigh -> max on Opus 4.7+ when set to '1'", () => {
      process.env.PI_CLAUDE_CLI_MAX_MODE = "1";
      expect(mapThinkingEffort("xhigh", "claude-opus-4-7")).toBe("max");
    });

    it("accepts true/yes/on (case-insensitive)", () => {
      for (const value of ["true", "TRUE", "yes", "ON"]) {
        _resetWarnDedupCache();
        process.env.PI_CLAUDE_CLI_MAX_MODE = value;
        expect(mapThinkingEffort("xhigh", "claude-opus-4-7")).toBe("max");
      }
    });

    it("does not promote levels below xhigh", () => {
      process.env.PI_CLAUDE_CLI_MAX_MODE = "1";
      expect(mapThinkingEffort("high", "claude-opus-4-7")).toBe("high");
      expect(mapThinkingEffort("medium", "claude-opus-4-7")).toBe("medium");
      expect(mapThinkingEffort("low", "claude-opus-4-7")).toBe("low");
    });

    it("does not promote on pre-4.7 Opus models (conservative)", () => {
      process.env.PI_CLAUDE_CLI_MAX_MODE = "1";
      // pre-4.7 Opus stays capped at high regardless of MAX_MODE.
      expect(mapThinkingEffort("xhigh", "claude-opus-4-6")).toBe("high");
    });

    it("does not promote on non-Opus models", () => {
      process.env.PI_CLAUDE_CLI_MAX_MODE = "1";
      expect(mapThinkingEffort("xhigh", "claude-sonnet-4-5")).toBe("high");
    });

    it("ignores 0/false/empty/garbage values", () => {
      for (const value of ["0", "false", "", "no", "garbage"]) {
        process.env.PI_CLAUDE_CLI_MAX_MODE = value;
        expect(mapThinkingEffort("xhigh", "claude-opus-4-7")).toBe("xhigh");
      }
    });

    it("PI_CLAUDE_CLI_EFFORT wins when both env vars are set", () => {
      process.env.PI_CLAUDE_CLI_EFFORT = "high";
      process.env.PI_CLAUDE_CLI_MAX_MODE = "1";
      // Override pins to high, max-mode does not get a chance to promote.
      expect(mapThinkingEffort("xhigh", "claude-opus-4-7")).toBe("high");
    });
  });

  describe("remap warnings", () => {
    it("warns when xhigh is capped to high on a non-Opus model", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mapThinkingEffort("xhigh", "claude-sonnet-4-5");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Pi thinking level "xhigh" remapped to Claude CLI --effort high',
        ),
      );
    });

    it("warns once per (family, level) pair, not on every call", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mapThinkingEffort("xhigh", "claude-sonnet-4-5");
      mapThinkingEffort("xhigh", "claude-sonnet-4-6"); // same family, same level
      mapThinkingEffort("xhigh", "claude-haiku-4-5-20251001"); // same family, same level
      const remapWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("remapped to Claude CLI"),
      );
      expect(remapWarnings).toHaveLength(1);
    });

    it("warns separately for distinct (family, level) pairs", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mapThinkingEffort("xhigh", "claude-sonnet-4-5"); // non-opus
      mapThinkingEffort("xhigh", "claude-opus-4-6"); // pre-4-7
      const remapWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("remapped to Claude CLI"),
      );
      expect(remapWarnings).toHaveLength(2);
    });

    it("does NOT warn on truthful Opus 4.7+ mappings (xhigh -> xhigh)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mapThinkingEffort("xhigh", "claude-opus-4-7");
      mapThinkingEffort("medium", "claude-opus-4-7");
      mapThinkingEffort("high", "claude-opus-4-7");
      const remapWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("remapped to Claude CLI"),
      );
      expect(remapWarnings).toHaveLength(0);
    });

    it("warns when MAX_MODE promotes xhigh -> max (since names differ)", () => {
      process.env.PI_CLAUDE_CLI_MAX_MODE = "1";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mapThinkingEffort("xhigh", "claude-opus-4-7");
      const remapWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("remapped to Claude CLI"),
      );
      expect(remapWarnings).toHaveLength(1);
      expect(remapWarnings[0][0]).toContain("--effort max");
    });

    it("warns once when 'minimal' is mapped to 'low' (names differ)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // minimal always remaps to low because the CLI has no 'minimal' level.
      mapThinkingEffort("minimal", "claude-opus-4-7");
      const remapWarnings = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("remapped to Claude CLI"),
      );
      expect(remapWarnings).toHaveLength(1);
    });
  });

  describe("thinkingBudgets warning", () => {
    it("logs console.warn when thinkingBudgets has entries", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const budgets: ThinkingBudgets = { high: 50000 };
      mapThinkingEffort("high", "claude-sonnet-4-5", budgets);
      const matches = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("thinkingBudgets are not supported"),
      );
      expect(matches).toHaveLength(1);
    });

    it("does not warn when thinkingBudgets is undefined", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mapThinkingEffort("high", "claude-sonnet-4-5", undefined);
      const matches = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("thinkingBudgets are not supported"),
      );
      expect(matches).toHaveLength(0);
    });

    it("does not warn when thinkingBudgets is empty object", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mapThinkingEffort("high", "claude-sonnet-4-5", {} as ThinkingBudgets);
      const matches = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("thinkingBudgets are not supported"),
      );
      expect(matches).toHaveLength(0);
    });

    it("logs the budgets warning at most once per process", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const budgets: ThinkingBudgets = { high: 50000 };
      mapThinkingEffort("high", "claude-sonnet-4-5", budgets);
      mapThinkingEffort("high", "claude-opus-4-7", budgets);
      const matches = warnSpy.mock.calls.filter((c) =>
        String(c[0]).includes("thinkingBudgets are not supported"),
      );
      expect(matches).toHaveLength(1);
    });

    it("still returns the correct effort level when budgets trigger a warning", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const budgets: ThinkingBudgets = { high: 50000 };
      // Opus 4.7+ truthful mapping: high -> high.
      expect(mapThinkingEffort("high", "claude-opus-4-7", budgets)).toBe(
        "high",
      );
    });
  });
});
