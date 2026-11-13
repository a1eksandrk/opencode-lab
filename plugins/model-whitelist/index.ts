import { Plugin } from "@opencode/plugin";

/** `{ providerID: modelID[] }` — providers not listed are left untouched. */
export type Whitelist = Readonly<Record<string, readonly string[]>>;

/**
 * Normalize the `whitelist` option. Returns `undefined` when the value is not
 * a plain object, so the plugin can no-op. Empty arrays are preserved: an
 * empty list hides every model of that provider.
 */
export function parseWhitelist(value: unknown): Whitelist | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const whitelist: Record<string, string[]> = {};
  for (const [providerID, models] of Object.entries(value)) {
    if (!Array.isArray(models)) continue;

    whitelist[providerID] = models.filter(
      (model): model is string => typeof model === "string",
    );
  }

  return whitelist;
}

export default Plugin.define({
  id: "model-whitelist",

  async setup(ctx) {
    const whitelist = parseWhitelist(ctx.options.whitelist);
    if (!whitelist) return;

    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        const providerID = String(model.providerID);
        const modelID = String(model.id);
        const allowed = whitelist[providerID];

        if (allowed && !allowed.includes(modelID)) {
          editor.remove(providerID, modelID);
        }
      }
    });
  },
});
