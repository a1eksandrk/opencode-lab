import { expect, test } from "bun:test";
import guard from "./index";

type ModelLike = { providerID: string; id: string };
type Editor = {
  list(): ModelLike[];
  remove(providerID: string, modelID: string): void;
};

async function captureTransform(
  providers: unknown,
): Promise<((editor: Editor) => void) | undefined> {
  let transform: ((editor: Editor) => void) | undefined;

  await guard.setup({
    options: { providers },
    model: {
      transform: async (callback: (editor: Editor) => void) => {
        transform = callback;
        return { dispose: async () => {} };
      },
    },
  } as never);

  return transform;
}

test("removes models outside the fixture providers", async () => {
  const transform = await captureTransform(["free", "paid"]);
  const removed: string[] = [];

  transform?.({
    list: () => [
      { providerID: "free", id: "parent" },
      { providerID: "paid", id: "explore" },
      { providerID: "openai", id: "gpt-5" },
      { providerID: "anthropic", id: "claude" },
    ],
    remove: (providerID, modelID) => removed.push(`${providerID}/${modelID}`),
  });

  expect(removed).toEqual(["openai/gpt-5", "anthropic/claude"]);
});

test("registers no transform without a provider allowlist", async () => {
  expect(await captureTransform(undefined)).toBeUndefined();
  expect(await captureTransform([])).toBeUndefined();
});
