import { Plugin } from "@opencode/plugin";

type Json = Record<string, unknown>;

function endpointOf(options: Readonly<Record<string, unknown>>): string {
  const endpoint = options.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new Error("e2e observer: missing endpoint option");
  }
  return endpoint;
}

function providerScope(options: Readonly<Record<string, unknown>>): string[] | undefined {
  const providers = options.providers;
  if (!Array.isArray(providers)) return undefined;

  return providers.filter((provider): provider is string => typeof provider === "string");
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Passive observer for the integration suite. It records session context,
 * HTTP statuses, retries, and tool completions; it never changes a retry
 * decision, model, or request.
 */
export default Plugin.define({
  id: "model-fallback-e2e-observer",

  async setup(ctx) {
    const endpoint = endpointOf(ctx.options);
    const log = (event: string, data: Json = {}) =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, at: new Date().toISOString(), ...data }),
      }).catch(() => {});

    const registrations = [ctx.session.hook("context", async (event) => {
      let parentID: string | undefined;
      try {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        parentID = session.parentID;
      } catch {
        // The context entry is still useful without the session lookup.
      }

      await log("context", {
        sessionID: event.sessionID,
        agent: event.agent,
        parentID,
      });
    })];

    const onHttpRequest = async (event: {
      sessionID: string;
      agent: string;
      model: unknown;
      kind: string;
    }) => {
      await log("http.request", {
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        kind: event.kind,
      });
    };

    const scopes: Array<string | undefined> = providerScope(ctx.options) ?? [undefined];
    for (const providerID of scopes) {
      const options = providerID ? { providerID } : undefined;
      registrations.push(ctx.session.hook("http.request", onHttpRequest, options));
    }

    registrations.push(ctx.session.hook("retry", async (event) => {
      await log("retry", {
        sessionID: event.sessionID,
        agent: event.agent,
        model: event.model,
        status: event.error.status,
      });
    }));

    registrations.push(ctx.tool.hook("execute.after", async (event) => {
      if (event.tool !== "read" && event.tool !== "subagent") return;

      await log("tool.after", {
        sessionID: event.sessionID,
        agent: event.agent,
        tool: event.tool,
      });
    }));

    const results = await Promise.allSettled(registrations);
    const active = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      await Promise.allSettled(active.map((registration) => registration.dispose()));
      throw failed.reason;
    }

    return async () => {
      await Promise.all(active.map((registration) => registration.dispose()));
    };
  },
});
