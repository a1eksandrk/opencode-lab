import { expect, test } from "bun:test";
import observer from "./index";

test("waits for every hook registration and disposes them on cleanup", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const disposed: string[] = [];
  const hook = async (name: string, _callback: unknown, options?: { providerID?: string }) => {
    const key = `${name}:${options?.providerID ?? "*"}`;
    calls.push(key);
    await gate;
    return { dispose: async () => { disposed.push(key); } };
  };
  const ctx = {
    options: { endpoint: "http://localhost", providers: ["p", "q"] },
    session: { hook },
    tool: { hook },
  };

  const pending = Promise.resolve(observer.setup(ctx as never));
  expect(await Promise.race([pending.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");
  expect(calls).toEqual([
    "context:*", "http.request:p", "http.response:p",
    "http.request:q", "http.response:q", "retry:*", "execute.after:*",
  ]);

  release();
  const cleanup = await pending;
  await cleanup?.();
  expect(disposed).toEqual(calls);
});

test("propagates registration failures and disposes successful registrations", async () => {
  const disposed: string[] = [];
  const hook = async (name: string) => {
    if (name === "retry") throw new Error("registration failed");
    return { dispose: async () => { disposed.push(name); } };
  };
  const ctx = {
    options: { endpoint: "http://localhost" },
    session: { hook },
    tool: { hook },
  };

  await expect(Promise.resolve(observer.setup(ctx as never))).rejects.toThrow("registration failed");
  expect(disposed.sort()).toEqual(["context", "execute.after", "http.request", "http.response"]);
});
