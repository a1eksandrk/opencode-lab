import { Plugin } from "@opencode/plugin";

function allowedProviders(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;

  const providers = value.filter(
    (provider): provider is string => typeof provider === "string",
  );
  return providers.length > 0 ? new Set(providers) : undefined;
}

/**
 * E2E-only model guard. It removes every model outside the fixture providers,
 * including any implicit auxiliary model that a global catalog might add.
 */
export default Plugin.define({
  id: "model-fallback-e2e-fixture-guard",

  async setup(ctx) {
    const allowed = allowedProviders(ctx.options.providers);
    if (!allowed) return;

    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        const providerID = String(model.providerID);
        if (!allowed.has(providerID)) {
          editor.remove(providerID, String(model.id));
        }
      }
    });
  },
});
