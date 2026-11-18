import { describe, expect, test } from "bun:test";
import {
  FallbackRouter,
  type FallbackRetryEvent,
  type FallbackRuntime,
  type FallbackSessionInfo,
} from "./router";
import { parseFallbackConfig, type FallbackConfig } from "./config";
import type { InventoryModel, RuntimeModelRef } from "./candidates";

const CHILD = "ses_child";
const PARENT = "ses_parent";
const GRANDCHILD = "ses_grandchild";
const OTHER = "ses_other";
const A: RuntimeModelRef = { providerID: "p", id: "a", variant: "default" };
const B: RuntimeModelRef = { providerID: "p", id: "b", variant: "default" };
const C: RuntimeModelRef = { providerID: "q", id: "c", variant: "default" };
const D: RuntimeModelRef = { providerID: "r", id: "d", variant: "default" };

function config(fallback: Record<string, string[]>): FallbackConfig {
  return parseFallbackConfig({ fallback });
}

function model(
  ref: RuntimeModelRef,
  overrides: Partial<InventoryModel> = {},
): InventoryModel {
  return {
    providerID: ref.providerID,
    id: ref.id,
    enabled: true,
    variants: [],
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface FakeOptions {
  readonly sessions?: Record<string, FallbackSessionInfo>;
  readonly models?: InventoryModel[];
  readonly failGetSession?: boolean;
  readonly failListModels?: boolean;
  readonly failSwitch?: boolean;
  readonly switchGate?: Promise<void>;
  readonly switchGates?: Promise<void>[];
  readonly listModelsGate?: Promise<void>;
  readonly getSessionGates?: Array<Promise<void> | undefined>;
  readonly onSwitch?: (call: number) => void;
  readonly onListModels?: (call: number) => void;
  readonly onGetSession?: (call: number) => void;
  readonly commitSwitchBeforeGate?: boolean;
}

interface FakeRuntime {
  readonly runtime: FallbackRuntime;
  readonly sessions: Map<string, FallbackSessionInfo>;
  readonly calls: {
    readonly switches: { sessionID: string; model: RuntimeModelRef }[];
    readonly getSession: string[];
    readonly signals: AbortSignal[];
    listModels: number;
  };
}

function fakeRuntime(options: FakeOptions = {}): FakeRuntime {
  const sessions = new Map(
    Object.entries(
      options.sessions ?? {
        [CHILD]: { parentID: PARENT, model: A },
      },
    ),
  );
  const calls: FakeRuntime["calls"] = {
    switches: [],
    getSession: [],
    signals: [],
    listModels: 0,
  };

  const runtime: FallbackRuntime = {
    async getSession(sessionID, signal) {
      calls.getSession.push(sessionID);
      if (signal) calls.signals.push(signal);
      options.onGetSession?.(calls.getSession.length);

      const gate = options.getSessionGates?.shift();
      if (gate) await gate;

      if (options.failGetSession) throw new Error("session unavailable");

      const session = sessions.get(sessionID);
      if (!session) throw new Error("session not found");
      return session;
    },

    async switchModel(sessionID, next, signal) {
      calls.switches.push({ sessionID, model: next });
      if (signal) calls.signals.push(signal);
      if (options.failSwitch) throw new Error("switch rejected");

      options.onSwitch?.(calls.switches.length);

      const gate = options.switchGates?.shift() ?? options.switchGate;
      if (options.commitSwitchBeforeGate) {
        const session = sessions.get(sessionID);
        if (session) sessions.set(sessionID, { ...session, model: next });
      }
      if (gate) await gate;
      if (signal?.aborted) throw new Error("switch aborted");

      if (!options.commitSwitchBeforeGate) {
        const session = sessions.get(sessionID);
        if (session) sessions.set(sessionID, { ...session, model: next });
      }
    },

    async listModels(signal) {
      calls.listModels += 1;
      if (signal) calls.signals.push(signal);
      if (options.failListModels) throw new Error("inventory unavailable");

      options.onListModels?.(calls.listModels);
      if (options.listModelsGate) await options.listModelsGate;
      if (signal?.aborted) throw new Error("inventory aborted");

      return options.models ?? [model(B), model(C), model(D)];
    },
  };

  return { runtime, sessions, calls };
}

function router(
  fallback: Record<string, string[]>,
  fake: FakeRuntime,
  warnings: string[] = [],
): FallbackRouter {
  return new FallbackRouter({
    config: config(fallback),
    runtime: fake.runtime,
    warn: (message) => warnings.push(message),
  });
}

function retryEvent(
  modelRef: RuntimeModelRef,
  overrides: Partial<FallbackRetryEvent> = {},
): FallbackRetryEvent {
  return {
    sessionID: CHILD,
    model: modelRef,
    errorStatus: 429,
    ...overrides,
  };
}

describe("FallbackRouter model-scoped retry", () => {
  test("switches a child on a native 429 without any preceding event", async () => {
    const fake = fakeRuntime();
    const target = router({ "p/a": ["p/b"] }, fake);

    const decision = await target.handleRetry(retryEvent(A));

    expect(decision).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches).toEqual([
      { sessionID: CHILD, model: { providerID: "p", id: "b" } },
    ]);
  });

  test("leaves a root session untouched", async () => {
    const fake = fakeRuntime({ sessions: { [CHILD]: { model: A } } });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("leaves an unmapped source untouched", async () => {
    const fake = fakeRuntime();
    const target = router({ "p/other": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("leaves non-429 errors untouched", async () => {
    const fake = fakeRuntime();
    const target = router({ "p/a": ["p/b"] }, fake);

    const decision = await target.handleRetry(
      retryEvent(A, { errorStatus: 404 }),
    );

    expect(decision).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("leaves the decision when the session lookup fails", async () => {
    const fake = fakeRuntime({ failGetSession: true });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("leaves the decision when the inventory cannot be read", async () => {
    const fake = fakeRuntime({ failListModels: true });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("leaves the decision on an unexpected routing failure", async () => {
    const fake = fakeRuntime();
    fake.runtime.listModels = async () =>
      ({
        [Symbol.iterator]() {
          throw new Error("broken inventory");
        },
      }) as never;
    const warnings: string[] = [];
    const target = router({ "p/a": ["p/b"] }, fake, warnings);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
    expect(
      warnings.some((message) => message.includes("unexpected failure")),
    ).toBe(true);
  });

  test("does not switch when the selected model changed outside the plugin", async () => {
    const fake = fakeRuntime({
      sessions: { [CHILD]: { parentID: PARENT, model: C } },
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("leaves the decision when no candidate can take over", async () => {
    const fake = fakeRuntime({ models: [] });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("does not advance the chain when a switch fails", async () => {
    const fake = fakeRuntime({
      models: [model(B), model(C)],
      failSwitch: true,
    });
    const target = router({ "p/a": ["p/b", "q/c"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();

    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "p", id: "b" },
      { providerID: "p", id: "b" },
    ]);
  });

  test("runs at most one decision for duplicate callbacks", async () => {
    const gate = deferred();
    const fake = fakeRuntime({ switchGate: gate.promise, models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake);

    const first = target.handleRetry(retryEvent(A));
    const second = target.handleRetry(retryEvent(A));

    expect(await second).toBeUndefined();
    gate.resolve();
    expect(await first).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches).toHaveLength(1);
  });
});

describe("FallbackRouter candidate selection", () => {
  test("skips unavailable targets and selects the next one", async () => {
    const fake = fakeRuntime({ models: [model(C)] });
    const warnings: string[] = [];
    const target = router({ "p/a": ["p/b", "q/c"] }, fake, warnings);

    expect(await target.handleRetry(retryEvent(A))).toEqual({
      retry: true,
      delay: 0,
    });
    expect(fake.calls.switches[0]?.model).toEqual({
      providerID: "q",
      id: "c",
    });
    expect(warnings.some((message) => message.includes("p/b"))).toBe(true);
  });

  test("skips a missing explicit variant and uses the next entry", async () => {
    const fake = fakeRuntime({
      models: [model(B), model(C, { variants: [{ id: "high" }] })],
    });
    const target = router({ "p/a": ["p/b#high", "q/c#high"] }, fake);

    await target.handleRetry(retryEvent(A));

    expect(fake.calls.switches[0]?.model).toEqual({
      providerID: "q",
      id: "c",
      variant: "high",
    });
  });

  test("does not inherit the source variant", async () => {
    const fake = fakeRuntime();
    const target = router({ "p/a": ["p/b"] }, fake);
    const highA: RuntimeModelRef = { ...A, variant: "high" };
    fake.sessions.set(CHILD, { parentID: PARENT, model: highA });

    await target.handleRetry(retryEvent(highA));

    expect(fake.calls.switches[0]?.model).toEqual({
      providerID: "p",
      id: "b",
    });
  });

  test("follows the configured chain without returning to an earlier target", async () => {
    const fake = fakeRuntime();
    const target = router({ "p/a": ["p/b", "q/c"] }, fake);

    await target.handleRetry(retryEvent(A));
    await target.handleRetry(retryEvent(B));

    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "p", id: "b" },
      { providerID: "q", id: "c" },
    ]);
  });

  test("preserves the original chain after a stale retry", async () => {
    const fake = fakeRuntime({ models: [model(A), model(B), model(C)] });
    const target = router({ "p/a": ["p/b", "q/c"], "p/b": ["p/a"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toEqual({ retry: true, delay: 0 });
    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
    expect(await target.handleRetry(retryEvent(B))).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "p", id: "b" },
      { providerID: "q", id: "c" },
    ]);
  });

  test("preserves the original chain when revalidation cannot read the session", async () => {
    const fake = fakeRuntime({
      models: [model(A), model(B), model(C)],
      onGetSession: (call) => {
        if (call === 5) throw new Error("temporary session failure");
      },
    });
    const target = router({ "p/a": ["p/b", "q/c"], "p/b": ["p/a"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toEqual({ retry: true, delay: 0 });
    expect(await target.handleRetry(retryEvent(B))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
    expect(await target.handleRetry(retryEvent(B))).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "p", id: "b" },
      { providerID: "q", id: "c" },
    ]);
  });

  test("does not return to a target that recovered before a successful switch", async () => {
    const inventory = [model(C), model(D)];
    const fake = fakeRuntime({ models: inventory });
    const target = router({ "p/a": ["p/b", "q/c", "r/d"] }, fake);

    await target.handleRetry(retryEvent(A));

    inventory.push(model(B));
    await target.handleRetry(retryEvent(C));

    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "q", id: "c" },
      { providerID: "r", id: "d" },
    ]);
  });

  test("stops an exhausted owned chain without returning to an earlier target", async () => {
    const inventory = [model(C)];
    const fake = fakeRuntime({ models: inventory });
    const target = router({ "p/a": ["p/b", "q/c"] }, fake);

    await target.handleRetry(retryEvent(A));

    inventory.push(model(B));
    expect(await target.handleRetry(retryEvent(C))).toEqual({ retry: false });
    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "q", id: "c" },
    ]);
  });

  test("vetoes a 429 only after an owned chain is exhausted", async () => {
    const fake = fakeRuntime({ models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toEqual({
      retry: true,
      delay: 0,
    });
    expect(await target.handleRetry(retryEvent(B))).toEqual({ retry: false });
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("does not veto before a successful takeover", async () => {
    const fake = fakeRuntime({ models: [] });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
  });
});

describe("FallbackRouter SDK effects", () => {
  test("waits for the switch before returning the retry decision", async () => {
    const gate = deferred();
    const fake = fakeRuntime({ switchGate: gate.promise, models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake);

    const result = target.handleRetry(retryEvent(A));
    expect(
      await Promise.race([
        result.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");

    gate.resolve();
    expect(await result).toEqual({ retry: true, delay: 0 });
  });

  test("does not force a retry after a rejected switch", async () => {
    const fake = fakeRuntime({ failSwitch: true });
    const warnings: string[] = [];
    const target = router({ "p/a": ["p/b"] }, fake, warnings);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
    expect(warnings.some((message) => message.includes("failed"))).toBe(true);
  });

  test("confirms a bare target after the switch", async () => {
    const fake = fakeRuntime({ models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toEqual({
      retry: true,
      delay: 0,
    });
    expect(fake.calls.getSession).toHaveLength(3);
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("confirms an explicit variant after the switch", async () => {
    const fake = fakeRuntime({
      models: [model(C, { variants: [{ id: "high" }] })],
    });
    const target = router({ "p/a": ["q/c#high"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toEqual({
      retry: true,
      delay: 0,
    });
    expect(fake.calls.switches[0]?.model).toEqual({
      providerID: "q",
      id: "c",
      variant: "high",
    });
  });

  test("does not claim an explicit target when the host applied another variant", async () => {
    let fake!: FakeRuntime;
    fake = fakeRuntime({
      models: [model(C, { variants: [{ id: "high" }] })],
      onGetSession: (call) => {
        if (call === 3) {
          fake.sessions.set(CHILD, { parentID: PARENT, model: C });
        }
      },
    });
    const target = router({ "p/a": ["q/c#high"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("does not claim a switch when the selection changes before the RPC returns", async () => {
    const gate = deferred();
    const entered = deferred();
    const fake = fakeRuntime({
      models: [model(B)],
      switchGate: gate.promise,
      commitSwitchBeforeGate: true,
      onSwitch: () => entered.resolve(),
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    const pending = target.handleRetry(retryEvent(A));
    await entered.promise;

    fake.sessions.set(CHILD, { parentID: PARENT, model: D });
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(fake.sessions.get(CHILD)?.model).toEqual(D);

    // The old chain never claimed B, so a later B retry is not an owned
    // exhaustion and must leave the native decision unchanged.
    expect(await target.handleRetry(retryEvent(B))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
  });
});

describe("FallbackRouter operation lifetime", () => {
  test("interrupted unconfirmed chains do not block a later child", async () => {
    const fake = fakeRuntime();
    const listModels = fake.runtime.listModels;
    const target = router({ "p/a": ["p/b"] }, fake);

    for (let index = 0; index < 512; index += 1) {
      const sessionID = `ses_interrupted_${index}`;
      const entered = deferred();
      const gate = deferred();
      fake.sessions.set(sessionID, { parentID: PARENT, model: A });
      fake.runtime.listModels = async (signal) => {
        entered.resolve();
        await gate.promise;
        return listModels(signal);
      };
      const pending = target.handleRetry(retryEvent(A, { sessionID }));
      await entered.promise;
      target.interruptSession(sessionID);
      gate.resolve();
      expect(await pending).toBeUndefined();
    }

    expect(fake.calls.switches).toEqual([]);
    fake.runtime.listModels = listModels;
    expect(await target.handleRetry(retryEvent(A))).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches).toEqual([
      { sessionID: CHILD, model: { providerID: "p", id: "b" } },
    ]);
  });

  test("does not switch when an interruption lands during inventory lookup", async () => {
    const gate = deferred();
    const entered = deferred();
    const fake = fakeRuntime({
      listModelsGate: gate.promise,
      onListModels: () => entered.resolve(),
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    const pending = target.handleRetry(retryEvent(A));
    await entered.promise;

    target.interruptSession(CHILD);
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
    expect(fake.calls.signals.some((signal) => signal.aborted)).toBe(true);
  });

  test("keeps a confirmed chain after interruption during the next lookup", async () => {
    const fake = fakeRuntime();
    const target = router({ "p/a": ["p/b", "q/c"], "p/b": ["p/a"] }, fake);
    expect(await target.handleRetry(retryEvent(A))).toEqual({ retry: true, delay: 0 });

    const entered = deferred();
    const gate = deferred();
    const listModels = fake.runtime.listModels;
    fake.runtime.listModels = async (signal) => {
      entered.resolve();
      await gate.promise;
      return listModels(signal);
    };
    const pending = target.handleRetry(retryEvent(B));
    await entered.promise;
    target.interruptSession(CHILD);
    gate.resolve();
    expect(await pending).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);

    fake.runtime.listModels = listModels;
    expect(await target.handleRetry(retryEvent(B))).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches[1]?.model).toEqual({ providerID: "q", id: "c" });
  });

  test("a late interrupted lookup does not discard a newer confirmed chain", async () => {
    const fake = fakeRuntime();
    const target = router({ "p/a": ["p/b", "q/c"], "p/b": ["p/a"] }, fake);
    const entered = deferred();
    const gate = deferred();
    const listModels = fake.runtime.listModels;
    fake.runtime.listModels = async (signal) => {
      entered.resolve();
      await gate.promise;
      return listModels(signal);
    };
    const old = target.handleRetry(retryEvent(A));
    await entered.promise;
    target.interruptSession(CHILD);

    fake.runtime.listModels = listModels;
    expect(await target.handleRetry(retryEvent(A))).toEqual({ retry: true, delay: 0 });
    gate.resolve();
    expect(await old).toBeUndefined();
    expect(await target.handleRetry(retryEvent(B))).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "p", id: "b" },
      { providerID: "q", id: "c" },
    ]);
  });

  test("does not switch when deletion lands during inventory lookup", async () => {
    const gate = deferred();
    const entered = deferred();
    const fake = fakeRuntime({
      listModelsGate: gate.promise,
      onListModels: () => entered.resolve(),
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    const pending = target.handleRetry(retryEvent(A));
    await entered.promise;

    target.forgetSession(CHILD);
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("does not switch after unload during inventory lookup", async () => {
    const gate = deferred();
    const entered = deferred();
    const fake = fakeRuntime({
      listModelsGate: gate.promise,
      onListModels: () => entered.resolve(),
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    const pending = target.handleRetry(retryEvent(A));
    await entered.promise;

    target.close();
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("does not switch when the selection changes during inventory lookup", async () => {
    const gate = deferred();
    const entered = deferred();
    const fake = fakeRuntime({
      listModelsGate: gate.promise,
      onListModels: () => entered.resolve(),
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    const pending = target.handleRetry(retryEvent(A));
    await entered.promise;

    fake.sessions.set(CHILD, { parentID: PARENT, model: B });
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
  });

  test("ignores a switch that completes after invalidation", async () => {
    const gate = deferred();
    const entered = deferred();
    const fake = fakeRuntime({
      models: [model(B)],
      switchGates: [gate.promise],
      onSwitch: () => entered.resolve(),
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    const pending = target.handleRetry(retryEvent(A));
    await entered.promise;

    target.interruptSession(CHILD);
    gate.resolve();

    expect(await pending).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);

    // The host may still commit the switch. A later retry must not see a
    // resurrected chain, so no second switch may happen.
    fake.sessions.set(CHILD, { parentID: PARENT, model: B });
    expect(await target.handleRetry(retryEvent(B))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("keeps the guard of a newer operation when an old switch completes late", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstEntered = deferred();
    const secondEntered = deferred();
    const fake = fakeRuntime({
      models: [model(B)],
      switchGates: [firstGate.promise, secondGate.promise],
      onSwitch: (call) => {
        if (call === 1) firstEntered.resolve();
        if (call === 2) secondEntered.resolve();
      },
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    const first = target.handleRetry(retryEvent(A));
    await firstEntered.promise;

    target.forgetSession(CHILD);

    const second = target.handleRetry(retryEvent(A));
    await secondEntered.promise;

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();

    firstGate.resolve();
    expect(await first).toBeUndefined();

    secondGate.resolve();
    expect(await second).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches).toHaveLength(2);
  });
});

describe("FallbackRouter state and lifecycle", () => {
  test("keeps parallel children isolated", async () => {
    const fake = fakeRuntime({
      sessions: {
        [CHILD]: { parentID: PARENT, model: A },
        [OTHER]: { parentID: PARENT, model: A },
      },
      models: [model(B)],
    });
    const target = router({ "p/a": ["p/b"] }, fake);

    expect(await target.handleRetry(retryEvent(A))).toEqual({
      retry: true,
      delay: 0,
    });
    expect(
      await target.handleRetry(retryEvent(A, { sessionID: OTHER })),
    ).toEqual({ retry: true, delay: 0 });

    expect(fake.calls.switches.map((call) => call.sessionID)).toEqual([
      CHILD,
      OTHER,
    ]);
  });

  test("switches only the innermost child and leaves other sessions alone", async () => {
    const fake = fakeRuntime({
      sessions: {
        [CHILD]: { parentID: PARENT, model: C },
        [GRANDCHILD]: { parentID: CHILD, model: C },
        [OTHER]: { parentID: PARENT, model: C },
      },
      models: [model(D)],
    });
    const target = router({ "q/c": ["r/d"] }, fake);

    expect(
      await target.handleRetry(retryEvent(C, { sessionID: GRANDCHILD })),
    ).toEqual({ retry: true, delay: 0 });

    expect(fake.calls.switches).toEqual([
      { sessionID: GRANDCHILD, model: { providerID: "r", id: "d" } },
    ]);
    expect(fake.sessions.get(CHILD)?.model).toEqual(C);
    expect(fake.sessions.get(OTHER)?.model).toEqual(C);
  });

  test("respects a new selection instead of restoring the old chain", async () => {
    const fake = fakeRuntime({ models: [model(B), model(D)] });
    const warnings: string[] = [];
    const target = router(
      { "p/a": ["p/b"], "q/c": ["r/d"] },
      fake,
      warnings,
    );

    await target.handleRetry(retryEvent(A));

    fake.sessions.set(CHILD, { parentID: PARENT, model: C });
    expect(await target.handleRetry(retryEvent(C))).toEqual({
      retry: true,
      delay: 0,
    });

    expect(fake.calls.switches.map((call) => call.model)).toEqual([
      { providerID: "p", id: "b" },
      { providerID: "r", id: "d" },
    ]);
    expect(warnings.some((message) => message.includes("discarding"))).toBe(true);
  });

  test("discards the old chain when a stale event reveals a manual selection", async () => {
    const fake = fakeRuntime({ models: [model(A), model(B), model(C), model(D)] });
    const target = router({ "p/a": ["p/b", "q/c"], "p/b": ["p/a"] }, fake);
    await target.handleRetry(retryEvent(A));
    fake.sessions.set(CHILD, { parentID: PARENT, model: D });

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    fake.sessions.set(CHILD, { parentID: PARENT, model: B });
    expect(await target.handleRetry(retryEvent(B))).toEqual({ retry: true, delay: 0 });
    expect(fake.calls.switches[1]?.model).toEqual({ providerID: "p", id: "a" });
  });

  test("ignores an externally changed variant on a fallback model", async () => {
    const fake = fakeRuntime({ models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake);

    await target.handleRetry(retryEvent(A));

    const highB: RuntimeModelRef = { ...B, variant: "high" };
    fake.sessions.set(CHILD, { parentID: PARENT, model: highB });

    expect(await target.handleRetry(retryEvent(highB))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("forgets a session on cleanup", async () => {
    const fake = fakeRuntime({ models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake);

    await target.handleRetry(retryEvent(A));
    target.forgetSession(CHILD);

    expect(await target.handleRetry(retryEvent(B))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("clears all chains on unload", async () => {
    const fake = fakeRuntime({ models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake);

    await target.handleRetry(retryEvent(A));
    target.close();

    expect(await target.handleRetry(retryEvent(B))).toBeUndefined();
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("does not retain a chain that never took over", async () => {
    const fake = fakeRuntime({ models: [] });
    const target = router({ "p/a": ["p/b"] }, fake);
    const chains = (
      target as unknown as { chains: Map<string, unknown> }
    ).chains;

    await target.handleRetry(retryEvent(A));

    expect(chains.size).toBe(0);
  });

  test("leaves the native decision when routing state is full and admits later work", async () => {
    const warnings: string[] = [];
    const fake = fakeRuntime({ models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake, warnings);
    const chains = (
      target as unknown as { chains: Map<string, unknown> }
    ).chains;
    for (let index = 0; index < 512; index += 1) {
      chains.set(`ses_full_${index}`, {});
    }

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
    expect(
      warnings.some((message) => message.includes("routing state is full")),
    ).toBe(true);

    chains.delete("ses_full_0");
    expect(await target.handleRetry(retryEvent(A))).toEqual({
      retry: true,
      delay: 0,
    });
    expect(fake.calls.switches).toHaveLength(1);
  });

  test("leaves the native decision when too many operations are in flight", async () => {
    const warnings: string[] = [];
    const fake = fakeRuntime({ models: [model(B)] });
    const target = router({ "p/a": ["p/b"] }, fake, warnings);
    const operations = (
      target as unknown as {
        operations: Map<string, { controller: AbortController }>;
      }
    ).operations;
    for (let index = 0; index < 512; index += 1) {
      operations.set(`ses_op_${index}`, { controller: new AbortController() });
    }

    expect(await target.handleRetry(retryEvent(A))).toBeUndefined();
    expect(fake.calls.switches).toEqual([]);
    expect(
      warnings.some((message) => message.includes("too many operations")),
    ).toBe(true);

    operations.delete("ses_op_0");
    expect(await target.handleRetry(retryEvent(A))).toEqual({
      retry: true,
      delay: 0,
    });
    expect(fake.calls.switches).toHaveLength(1);
  });
});
