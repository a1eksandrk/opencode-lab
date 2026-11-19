import { describe, expect, test } from "bun:test";
import {
  parseFallbackConfig,
  sourceKey,
  targetKey,
  type FallbackConfig,
} from "./config";

function targets(config: FallbackConfig): Record<string, string[]> {
  return Object.fromEntries(
    [...config.targetsBySource].map(([key, values]) => [
      key,
      values.map(targetKey),
    ]),
  );
}

describe("parseFallbackConfig", () => {
  test("treats missing, empty, or non-object input as a no-op", () => {
    expect(targets(parseFallbackConfig(undefined))).toEqual({});
    expect(targets(parseFallbackConfig({}))).toEqual({});
    expect(targets(parseFallbackConfig({ fallback: {} }))).toEqual({});
    expect(parseFallbackConfig(undefined).diagnostics).toEqual([]);
  });

  test("diagnoses a non-object fallback option", () => {
    const config = parseFallbackConfig({ fallback: ["openai/gpt"] });

    expect(targets(config)).toEqual({});
    expect(config.diagnostics).toHaveLength(1);
  });

  test("keeps ordered targets with and without variants", () => {
    const config = parseFallbackConfig({
      fallback: {
        "openai/gpt": ["anthropic/claude#high", "google/gemini"],
      },
    });

    expect(targets(config)).toEqual({
      "openai/gpt": ["anthropic/claude#high", "google/gemini"],
    });
    expect(config.targetsBySource.get("openai/gpt")?.[0]?.variant).toBe("high");
    expect(config.targetsBySource.get("openai/gpt")?.[1]?.variant).toBeUndefined();
  });

  test("splits the source at the first slash and keeps nested model IDs", () => {
    const config = parseFallbackConfig({
      fallback: {
        "openai/org/gpt": ["anthropic/org/claude#high"],
      },
    });

    expect(targets(config)).toEqual({
      "openai/org/gpt": ["anthropic/org/claude#high"],
    });
    expect(config.targetsBySource.get("openai/org/gpt")?.[0]).toEqual({
      providerID: "anthropic",
      id: "org/claude",
      variant: "high",
    });
  });

  test("ignores self-targets and deduplicates identical targets", () => {
    const config = parseFallbackConfig({
      fallback: {
        "p/a": ["q/b", "q/b", "p/a", "p/a#high", "q/b#high", "q/b#high"],
      },
    });

    expect(targets(config)).toEqual({ "p/a": ["q/b", "q/b#high"] });
  });

  test("keeps valid entries when sibling entries are malformed", () => {
    const config = parseFallbackConfig({
      fallback: {
        "p/a": ["q/b", 42, "bad", "q/c"],
        "p/": ["q/b"],
        "p/b": ["q/d"],
        "p/c": "q/e",
      },
    });

    expect(targets(config)).toEqual({
      "p/a": ["q/b", "q/c"],
      "p/b": ["q/d"],
    });
    expect(config.diagnostics).toHaveLength(4);
  });

  test("rejects malformed source and target separators", () => {
    const config = parseFallbackConfig({
      fallback: {
        "no-separator": ["q/b"],
        "/empty-provider": ["q/b"],
        "p/": ["q/b"],
        "p/a#variant": ["q/b"],
        "p/b": ["", "/b", "q/", "q/a#", "q/a#x#y", "q/a", 7],
      },
    });

    expect(targets(config)).toEqual({ "p/b": ["q/a"] });
    expect(config.diagnostics).toHaveLength(10);
  });

  test("omits sources with no usable targets", () => {
    const config = parseFallbackConfig({ fallback: { "p/a": [] } });

    expect(targets(config)).toEqual({});
    expect(config.diagnostics).toEqual([]);
  });

  test("builds stable source and target keys", () => {
    expect(sourceKey({ providerID: "p", id: "org/a" })).toBe("p/org/a");
    expect(targetKey({ providerID: "p", id: "org/a" })).toBe("p/org/a");
    expect(targetKey({ providerID: "p", id: "a", variant: "high" })).toBe(
      "p/a#high",
    );
  });
});
