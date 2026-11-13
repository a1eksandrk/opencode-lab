import { describe, expect, test } from "bun:test";
import plugin, { parseWhitelist } from "./index";

type ModelLike = { providerID: string; id: string };
type Editor = {
  list(): ModelLike[];
  remove(providerID: string, modelID: string): void;
};

/** Register the plugin with a fake context and return the captured transform. */
async function captureTransform(
  whitelist: unknown,
): Promise<((editor: Editor) => void) | undefined> {
  let transform: ((editor: Editor) => void) | undefined;

  const ctx = {
    options: { whitelist },
    model: {
      transform: async (callback: (editor: Editor) => void) => {
        transform = callback;
        return { dispose: async () => {} };
      },
    },
  };

  await plugin.setup(ctx as never);
  return transform;
}

/** Run the captured transform against `models`, returning `providerID/modelID`. */
function applyTransform(
  transform: ((editor: Editor) => void) | undefined,
  models: ModelLike[],
): string[] {
  const removed: string[] = [];

  transform?.({
    list: () => models,
    remove: (providerID, modelID) => removed.push(`${providerID}/${modelID}`),
  });

  return removed;
}

describe("model-whitelist plugin", () => {
  test("declares a stable id", () => {
    expect(plugin.id).toBe("model-whitelist");
  });

  test("exports a setup function", () => {
    expect(typeof plugin.setup).toBe("function");
  });
});

describe("parseWhitelist", () => {
  test("returns undefined for non-objects", () => {
    expect(parseWhitelist(undefined)).toBeUndefined();
    expect(parseWhitelist(null)).toBeUndefined();
    expect(parseWhitelist("openai")).toBeUndefined();
    expect(parseWhitelist(["openai"])).toBeUndefined();
  });

  test("keeps only string entries and preserves empty arrays", () => {
    expect(parseWhitelist({ openai: ["gpt-4o", 42], anthropic: [] })).toEqual({
      openai: ["gpt-4o"],
      anthropic: [],
    });
  });

  test("ignores non-array values", () => {
    expect(
      parseWhitelist({ openai: "gpt-4o", anthropic: ["claude-sonnet-5-5"] }),
    ).toEqual({ anthropic: ["claude-sonnet-5-5"] });
  });
});

describe("model transform", () => {
  test("removes only non-allowed models of whitelisted providers", async () => {
    const transform = await captureTransform({
      openai: ["gpt-4o"],
      anthropic: [],
    });

    const removed = applyTransform(transform, [
      { providerID: "openai", id: "gpt-4o" },
      { providerID: "openai", id: "gpt-4o-mini" },
      { providerID: "anthropic", id: "claude-sonnet-5-5" },
      { providerID: "google", id: "gemini-pro" },
    ]);

    expect(removed.sort()).toEqual([
      "anthropic/claude-sonnet-5-5",
      "openai/gpt-4o-mini",
    ]);
  });

  test("matches model ids exactly and case-sensitively", async () => {
    const transform = await captureTransform({ openai: ["gpt-4o"] });

    const removed = applyTransform(transform, [
      { providerID: "openai", id: "gpt-4o" },
      { providerID: "openai", id: "GPT-4O" },
      { providerID: "openai", id: "gpt-4o-mini" },
    ]);

    expect(removed.sort()).toEqual(["openai/GPT-4O", "openai/gpt-4o-mini"]);
  });

  test("does not register a transform for an invalid whitelist", async () => {
    expect(await captureTransform(undefined)).toBeUndefined();
    expect(await captureTransform("openai")).toBeUndefined();
    expect(await captureTransform(["openai"])).toBeUndefined();
  });
});
