import { describe, expect, spyOn, test } from "bun:test";
import plugin from "./index";

type HookCallback = (event: Record<string, unknown>) => unknown;

interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

interface FakeContextOptions {
  readonly options?: Record<string, unknown>;
  readonly parentID?: string;
  readonly eventSource?: AsyncIterable<unknown>;
  readonly disposalGate?: Promise<void>;
  readonly listModelsGate?: Promise<void>;
  readonly switchGate?: Promise<void>;
  readonly commitSwitchImmediately?: boolean;
  readonly onListModels?: () => void;
  readonly onSwitch?: () => void;
}

function fakeContext(options: FakeContextOptions = {}) {
  const hooks = new Map<string, HookCallback>();
  const registrations: Array<{
    readonly name: string;
    readonly providerID?: string;
  }> = [];
  const disposed: string[] = [];
  const switches: unknown[] = [];
  const signals: AbortSignal[] = [];
  let selected: ModelRef = { providerID: "p", id: "a", variant: "default" };

  const ctx = {
    options: options.options ?? {},
    session: {
      hook: async (
        name: string,
        callback: HookCallback,
        hookOptions?: { providerID?: string },
      ) => {
        registrations.push({ name, providerID: hookOptions?.providerID });
        hooks.set(name, callback);
        return {
          dispose: async () => {
            if (options.disposalGate) await options.disposalGate;
            disposed.push(name);
          },
        };
      },
      get: async () => ({
        parentID: options.parentID ?? "ses_parent",
        model: selected,
      }),
      switchModel: async (
        input: { model: ModelRef },
        settings?: { signal?: AbortSignal },
      ) => {
        switches.push(input);
        if (settings?.signal) signals.push(settings.signal);
        if (options.commitSwitchImmediately) selected = input.model;
        options.onSwitch?.();
        if (options.switchGate) await options.switchGate;
        if (!options.commitSwitchImmediately) selected = input.model;
      },
    },
    model: {
      list: async (
        _input?: unknown,
        settings?: { signal?: AbortSignal },
      ) => {
        if (settings?.signal) signals.push(settings.signal);
        options.onListModels?.();
        if (options.listModelsGate) await options.listModelsGate;

        return {
          data: [{ providerID: "p", id: "b", enabled: true, variants: [] }],
        };
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        options.eventSource ?? lifecycleEvents(signal),
    },
  };

  return {
    ctx,
    hooks,
    registrations,
    disposed,
    switches,
    signals,
    readSelected: () => selected,
  };
}

async function* lifecycleEvents(signal: AbortSignal): AsyncGenerator<unknown> {
  yield { type: "session.created" };

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function eventQueue(): {
  readonly source: AsyncIterable<unknown>;
  push(event: unknown): void;
  close(): void;
} {
  const items: unknown[] = [];
  let wake: ((value: unknown | null) => void) | undefined;
  let closed = false;

  return {
    source: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (items.length > 0) {
            yield items.shift();
            continue;
          }
          if (closed) return;

          const next = await new Promise<unknown | null>((resolve) => {
            wake = resolve;
          });
          if (next === null) return;
          yield next;
        }
      },
    },
    push(event) {
      if (wake) {
        const resolve = wake;
        wake = undefined;
        resolve(event);
        return;
      }
      items.push(event);
    },
    close() {
      closed = true;
      wake?.(null);
      wake = undefined;
    },
  };
}

async function* failingEvents(): AsyncGenerator<unknown> {
  yield { type: "session.created" };
  throw new Error("stream failed");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setupWithFallback(
  options: Record<string, unknown> = {
    fallback: { "p/a": ["p/b"] },
  },
  context: FakeContextOptions = {},
) {
  const fake = fakeContext({ options, ...context });
  const cleanup = await plugin.setup(fake.ctx as never);

  return { ...fake, cleanup };
}

async function invoke(
  hooks: Map<string, HookCallback>,
  name: string,
  event: Record<string, unknown>,
): Promise<void> {
  await hooks.get(name)?.(event);
}

function retryEvent(model: ModelRef, overrides: Record<string, unknown> = {}) {
  return {
    sessionID: "ses_child",
    agent: "explore",
    model,
    error: { status: 429, type: "provider.rate-limit" },
    attempt: 2,
    decision: { retry: true, delay: 10 },
    ...overrides,
  };
}

describe("model-fallback plugin", () => {
  test("declares a stable id and a setup function", () => {
    expect(plugin.id).toBe("model-fallback");
    expect(typeof plugin.setup).toBe("function");
  });

  test("registers nothing when the mapping is empty", async () => {
    const fake = fakeContext({ options: { fallback: {} } });

    const cleanup = await plugin.setup(fake.ctx as never);

    expect(cleanup).toBeUndefined();
    expect(fake.hooks.size).toBe(0);
  });

  test("diagnoses a malformed option without registering hooks", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeContext({ options: { fallback: "invalid" } });

    try {
      const cleanup = await plugin.setup(fake.ctx as never);

      expect(cleanup).toBeUndefined();
      expect(fake.hooks.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("registers only retry hooks scoped to configured providers", async () => {
    const fake = await setupWithFallback({
      fallback: { "p/a": ["q/b", "p/c"] },
    });

    expect(
      fake.registrations.map(({ name, providerID }) => `${name}:${providerID}`).sort(),
    ).toEqual(["retry:p", "retry:q"]);

    await fake.cleanup?.();
  });

  test("switches a child from the retry hook alone", async () => {
    const fake = await setupWithFallback();
    const model = { providerID: "p", id: "a", variant: "default" };
    const retry = retryEvent(model);

    await invoke(fake.hooks, "retry", retry);

    expect(fake.switches).toEqual([
      {
        sessionID: "ses_child",
        model: { providerID: "p", id: "b" },
      },
    ]);
    expect(retry.decision).toEqual({ retry: true, delay: 0 });

    await fake.cleanup?.();
  });

  test("does not switch a root session", async () => {
    const fake = await setupWithFallback(
      { fallback: { "p/a": ["p/b"] } },
      { parentID: "" },
    );
    const retry = retryEvent(
      { providerID: "p", id: "a", variant: "default" },
      { sessionID: "ses_root" },
    );

    await invoke(fake.hooks, "retry", retry);

    expect(fake.switches).toEqual([]);
    expect(retry.decision).toEqual({ retry: true, delay: 10 });

    await fake.cleanup?.();
  });

  test("leaves a non-429 decision untouched", async () => {
    const fake = await setupWithFallback();
    const retry = retryEvent(
      { providerID: "p", id: "a", variant: "default" },
      { error: { status: 404, type: "provider.response" } },
    );

    await invoke(fake.hooks, "retry", retry);

    expect(fake.switches).toEqual([]);
    expect(retry.decision).toEqual({ retry: true, delay: 10 });

    await fake.cleanup?.();
  });

  test("an interruption cancels a pending decision without a preceding step event", async () => {
    const queue = eventQueue();
    const inventoryGate = deferred();
    const lookupEntered = deferred();
    const fake = await setupWithFallback(undefined, {
      eventSource: queue.source,
      listModelsGate: inventoryGate.promise,
      onListModels: () => lookupEntered.resolve(),
    });
    const retry = retryEvent({ providerID: "p", id: "a", variant: "default" });

    const pending = invoke(fake.hooks, "retry", retry);
    await lookupEntered.promise;

    queue.push({
      type: "session.execution.interrupted",
      data: { sessionID: "ses_child" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    inventoryGate.resolve();
    await pending;

    expect(fake.switches).toEqual([]);
    expect(retry.decision).toEqual({ retry: true, delay: 10 });
    expect(fake.signals.some((signal) => signal.aborted)).toBe(true);

    queue.close();
    await fake.cleanup?.();
  });

  test("a deletion cancels a pending decision", async () => {
    const queue = eventQueue();
    const inventoryGate = deferred();
    const lookupEntered = deferred();
    const fake = await setupWithFallback(undefined, {
      eventSource: queue.source,
      listModelsGate: inventoryGate.promise,
      onListModels: () => lookupEntered.resolve(),
    });
    const retry = retryEvent({ providerID: "p", id: "a", variant: "default" });

    const pending = invoke(fake.hooks, "retry", retry);
    await lookupEntered.promise;

    queue.push({
      type: "session.deleted",
      data: { sessionID: "ses_child" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    inventoryGate.resolve();
    await pending;

    expect(fake.switches).toEqual([]);
    expect(retry.decision).toEqual({ retry: true, delay: 10 });

    queue.close();
    await fake.cleanup?.();
  });

  test("ignores malformed lifecycle events", async () => {
    const queue = eventQueue();
    const fake = await setupWithFallback(undefined, { eventSource: queue.source });

    queue.push({ type: "session.created" });
    queue.push({ type: "session.deleted" });
    queue.push({ type: "session.deleted", data: {} });
    queue.push({ type: "session.execution.interrupted", data: { sessionID: 7 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const retry = retryEvent({ providerID: "p", id: "a", variant: "default" });
    await invoke(fake.hooks, "retry", retry);

    expect(fake.switches).toHaveLength(1);
    expect(retry.decision).toEqual({ retry: true, delay: 0 });

    queue.close();
    await fake.cleanup?.();
  });

  test("reports a lifecycle subscription failure", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const fake = await setupWithFallback(undefined, {
        eventSource: failingEvents(),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes("event subscription stopped"),
        ),
      ).toBe(true);

      await fake.cleanup?.();
    } finally {
      warn.mockRestore();
    }
  });

  test("invalidates a pending lookup before waiting for unload cleanup", async () => {
    const inventoryGate = deferred();
    const lookupEntered = deferred();
    const disposalGate = deferred();
    const fake = await setupWithFallback(undefined, {
      disposalGate: disposalGate.promise,
      listModelsGate: inventoryGate.promise,
      onListModels: () => lookupEntered.resolve(),
    });
    const retry = retryEvent({ providerID: "p", id: "a", variant: "default" });

    const pending = invoke(fake.hooks, "retry", retry);
    await lookupEntered.promise;

    const cleanup = Promise.resolve(fake.cleanup?.());
    expect(fake.signals.some((signal) => signal.aborted)).toBe(true);

    inventoryGate.resolve();
    await pending;

    expect(fake.switches).toEqual([]);
    expect(retry.decision).toEqual({ retry: true, delay: 10 });

    // The hooks are still registered while disposal is pending, but the closed
    // router must not accept new retries.
    const lateRetry = retryEvent({
      providerID: "p",
      id: "a",
      variant: "default",
    });
    await invoke(fake.hooks, "retry", lateRetry);

    expect(fake.switches).toEqual([]);
    expect(lateRetry.decision).toEqual({ retry: true, delay: 10 });

    disposalGate.resolve();
    await cleanup;
  });

  test("drops a switch completion that arrives after unload starts", async () => {
    const switchGate = deferred();
    const switchEntered = deferred();
    const disposalGate = deferred();
    const fake = await setupWithFallback(undefined, {
      commitSwitchImmediately: true,
      disposalGate: disposalGate.promise,
      switchGate: switchGate.promise,
      onSwitch: () => switchEntered.resolve(),
    });
    const retry = retryEvent({ providerID: "p", id: "a", variant: "default" });

    const pending = invoke(fake.hooks, "retry", retry);
    await switchEntered.promise;

    const cleanup = Promise.resolve(fake.cleanup?.());
    switchGate.resolve();
    await pending;

    expect(fake.switches).toHaveLength(1);
    expect(retry.decision).toEqual({ retry: true, delay: 10 });
    expect(fake.readSelected()).toEqual({ providerID: "p", id: "b" });

    disposalGate.resolve();
    await cleanup;

    // A late completion must not restore chain ownership for a later retry.
    const lateRetry = retryEvent({ providerID: "p", id: "b", variant: "default" });
    await invoke(fake.hooks, "retry", lateRetry);

    expect(fake.switches).toHaveLength(1);
    expect(lateRetry.decision).toEqual({ retry: true, delay: 10 });
  });

  test("disposes retry hooks and stops the lifecycle subscription on unload", async () => {
    const fake = await setupWithFallback();

    expect([...fake.hooks.keys()]).toEqual(["retry"]);

    await fake.cleanup?.();

    expect(fake.disposed).toEqual(["retry"]);
  });
});
