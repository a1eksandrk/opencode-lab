import { Plugin } from "@opencode/plugin";
import { parseFallbackConfig, type FallbackConfig } from "./config.ts";
import { isNonEmptyString, isRecord } from "./guards.ts";
import { FallbackRouter, type FallbackRuntime } from "./router.ts";

const LOG_PREFIX = "[model-fallback]";

export default Plugin.define({
  id: "model-fallback",

  async setup(ctx) {
    const config = parseFallbackConfig(ctx.options);
    for (const diagnostic of config.diagnostics) {
      warn(diagnostic);
    }

    if (config.targetsBySource.size === 0) return;

    const router = new FallbackRouter({
      config,
      runtime: runtimeFrom(ctx),
      warn,
    });

    const controller = new AbortController();
    const hookOptions = hookProviderIDs(config).map((providerID) => ({
      providerID,
    }));
    const registrations = await Promise.all(
      hookOptions.map((options) =>
        ctx.session.hook(
          "retry",
          async (event) => {
            const decision = await router.handleRetry({
              sessionID: event.sessionID,
              model: event.model,
              errorStatus: event.error.status,
            });
            if (decision) event.decision = decision;
          },
          options,
        ),
      ),
    );

    const lifecycle = watchLifecycle(
      ctx.event.subscribe({ signal: controller.signal }),
      {
        forget: (sessionID) => router.forgetSession(sessionID),
        interrupt: (sessionID) => router.interruptSession(sessionID),
      },
      controller.signal,
    );

    return async () => {
      // Close before the first await so a pending lookup cannot complete
      // during subscription teardown or hook disposal.
      router.close();
      controller.abort();
      await lifecycle;
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
});

/**
 * Register the retry hook only for providers named by a configured source or
 * target. Providers outside the mapping never reach the plugin.
 */
function hookProviderIDs(config: FallbackConfig): string[] {
  const providers = new Set<string>();

  for (const [key, targets] of config.targetsBySource) {
    const separator = key.indexOf("/");
    if (separator > 0) providers.add(key.slice(0, separator));

    for (const target of targets) providers.add(target.providerID);
  }

  return [...providers];
}

function runtimeFrom(ctx: Plugin.Context): FallbackRuntime {
  return {
    getSession: (sessionID, signal) => ctx.session.get({ sessionID }, { signal }),
    switchModel: (sessionID, model, signal) =>
      ctx.session.switchModel({ sessionID, model }, { signal }),
    listModels: async (signal) =>
      (await ctx.model.list(undefined, { signal })).data,
  };
}

interface LifecycleHandlers {
  readonly forget: (sessionID: string) => void;
  readonly interrupt: (sessionID: string) => void;
}

async function watchLifecycle(
  events: AsyncIterable<unknown>,
  handlers: LifecycleHandlers,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const event of events) {
      const action = lifecycleAction(event);
      if (!action) continue;

      if (action.type === "forget") handlers.forget(action.sessionID);
      else handlers.interrupt(action.sessionID);
    }
  } catch (error) {
    if (signal.aborted) return;

    warn(
      `event subscription stopped: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }
}

type LifecycleAction =
  | { readonly type: "forget"; readonly sessionID: string }
  | { readonly type: "interrupt"; readonly sessionID: string };

function lifecycleAction(event: unknown): LifecycleAction | undefined {
  if (!isRecord(event)) return undefined;
  if (event.type !== "session.deleted" && event.type !== "session.execution.interrupted") {
    return undefined;
  }
  if (!isRecord(event.data)) return undefined;
  if (!isNonEmptyString(event.data.sessionID)) return undefined;

  return {
    type: event.type === "session.deleted" ? "forget" : "interrupt",
    sessionID: event.data.sessionID,
  };
}

function warn(message: string): void {
  console.warn(`${LOG_PREFIX} ${message}`);
}
