import {
  detectRuntime,
  PLUGIN_DIR,
  runScenario,
  type RunResult,
} from "./harness.ts";
import type { MockRequest, Scenario } from "./mock.ts";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

type Event = Record<string, unknown>;

const SCENARIOS: readonly Scenario[] = [
  "core",
  "root429",
  "non429",
  "chain",
  "exhausted",
  "lifecycle",
  "variants",
  "unknownVariant",
];

function check(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, detail };
}

function events(result: RunResult, name: string): Event[] {
  return result.events.filter((event) => event.event === name);
}

function model(event: Event): { providerID?: string; id?: string; variant?: string } {
  const value = event.model;
  if (!isRecord(value)) return {};

  return {
    providerID: typeof value.providerID === "string" ? value.providerID : undefined,
    id: typeof value.id === "string" ? value.id : undefined,
    variant: typeof value.variant === "string" ? value.variant : undefined,
  };
}

function isRecord(value: unknown): value is Event {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpRequests(result: RunResult, providerID: string, id: string): Event[] {
  return events(result, "http.request").filter(
    (event) =>
      event.kind === "primary" &&
      model(event).providerID === providerID &&
      model(event).id === id,
  );
}

function retries(result: RunResult): Event[] {
  return events(result, "retry");
}

function toolAfter(result: RunResult, tool: string): Event[] {
  return events(result, "tool.after").filter((event) => event.tool === tool);
}

function contexts(result: RunResult): Event[] {
  const seen = new Set<string>();
  return events(result, "context").filter((event) => {
    if (typeof event.sessionID !== "string" || seen.has(event.sessionID)) {
      return false;
    }
    seen.add(event.sessionID);
    return true;
  });
}

function parentContext(result: RunResult): Event | undefined {
  return contexts(result).find((event) => event.agent === "e2e-parent");
}

function childContexts(result: RunResult): Event[] {
  return contexts(result).filter((event) => event.agent === "explore");
}

function mockRequests(result: RunResult, provider: MockRequest["provider"]): MockRequest[] {
  return result.requests.filter((request) => request.provider === provider);
}

function hasToolCall(request: MockRequest, name: string): boolean {
  return request.messages.some((message) => message.toolCallNames.includes(name));
}

function reportsContaining(stdout: string, text: string): number {
  return stdout.split(text).length - 1;
}

function commonChecks(result: RunResult): Check[] {
  const parent = parentContext(result);
  const children = childContexts(result);

  return [
    check("run did not time out", !result.timedOut),
    check("child session exists", children.length > 0),
    check(
      "child session points to the parent session",
      Boolean(
        parent?.sessionID &&
          children[0]?.parentID &&
          children[0].parentID === parent.sessionID,
      ),
    ),
  ];
}

function assertChildUses(
  result: RunResult,
  childID: string,
  providerID: string,
  id: string,
  name: string,
): Check {
  const requests = httpRequests(result, providerID, id);
  return check(
    name,
    requests.length > 0 && requests.every((event) => event.sessionID === childID),
  );
}

function evaluateCore(result: RunResult): Check[] {
  const parent = parentContext(result);
  const child = childContexts(result)[0];
  const childID = String(child?.sessionID);
  const paid = mockRequests(result, "paid").filter((request) => request.model === "explore");
  const reads = toolAfter(result, "read");
  const subagents = toolAfter(result, "subagent");

  return [
    ...commonChecks(result),
    assertChildUses(result, childID, "free", "explore", "the child started on free/explore"),
    assertChildUses(result, childID, "paid", "explore", "the fallback stayed in the same child"),
    check(
      "the retried request carried the read result and marker",
      paid.some((request) => request.marker && hasToolCall(request, "read")),
    ),
    check("exactly one read completed in the child", reads.length === 1, `reads=${reads.length}`),
    check("exactly one subagent invocation", subagents.length === 1, `subagents=${subagents.length}`),
    check(
      "every paid child request had one user prompt",
      paid.length > 0 && paid.every((request) => request.userPrompts === 1),
    ),
    check(
      "the parent stayed on free/parent",
      httpRequests(result, "free", "parent").length > 0 &&
        httpRequests(result, "paid", "parent").length === 0,
    ),
    check(
      "the parent received one marker-derived report",
      reportsContaining(result.stdout, "PARENT-REPORT:") === 1 &&
        result.stdout.includes(result.marker),
    ),
    check("the run exited successfully", result.exitCode === 0, `exit=${result.exitCode}`),
    check("parent context was observed", Boolean(parent)),
  ];
}

function evaluateRoot429(result: RunResult): Check[] {
  const rateLimits = retries(result).filter(
    (event) =>
      event.status === 429 &&
      model(event).providerID === "free" &&
      model(event).id === "parent",
  );

  return [
    check("run did not time out", !result.timedOut),
    check("the root 429 reached the retry hook", rateLimits.length > 0),
    check("no fallback provider was used", mockRequests(result, "paid").length === 0),
    check("no child session was created", childContexts(result).length === 0),
    check("the run completed", result.stdout.includes("ROOT-OK")),
    check("the root stayed on free/parent", httpRequests(result, "free", "parent").length > 0),
  ];
}

function evaluateNon429(result: RunResult): Check[] {
  const child = childContexts(result)[0];
  const childID = String(child?.sessionID);
  const reads = toolAfter(result, "read");

  return [
    ...commonChecks(result),
    assertChildUses(result, childID, "free", "explore", "the child stayed on free/explore"),
    check("no fallback provider was used", mockRequests(result, "paid").length === 0),
    check("exactly one read completed before the 404", reads.length === 1, `reads=${reads.length}`),
    check(
      "the 404 reached the retry hook",
      retries(result).some((event) => event.status === 404),
    ),
  ];
}

function evaluateChain(result: RunResult): Check[] {
  const child = childContexts(result)[0];
  const childID = String(child?.sessionID);
  const paid = mockRequests(result, "paid");
  const backup = mockRequests(result, "backup");
  const freeAfterFirstPaid = events(result, "http.request").filter(
    (event) =>
      model(event).providerID === "free" &&
      model(event).id === "explore" &&
      event.sessionID === childID &&
      eventIndex(result, event) > eventIndex(result, httpRequests(result, "paid", "explore")[0]),
  );

  return [
    ...commonChecks(result),
    assertChildUses(result, childID, "free", "explore", "the child started on free/explore"),
    assertChildUses(result, childID, "paid", "explore", "the first fallback stayed in the child"),
    assertChildUses(result, childID, "backup", "explore", "the second fallback stayed in the child"),
    check("the paid attempt was rate limited", paid.length === 1 && paid[0]?.status === 429),
    check("later steps continued on backup", backup.length >= 2, `backup=${backup.length}`),
    check(
      "the later backup step included the previous tool result",
      backup.length >= 2 && hasToolCall(backup[1]!, "glob"),
    ),
    check("the child never returned to free", freeAfterFirstPaid.length === 0),
    check("no second child was created", childContexts(result).length === 1),
    check(
      "the parent received the final marker report",
      reportsContaining(result.stdout, "PARENT-REPORT:") === 1,
    ),
    check("the run exited successfully", result.exitCode === 0, `exit=${result.exitCode}`),
  ];
}

function evaluateExhausted(result: RunResult): Check[] {
  const paid = mockRequests(result, "paid");

  return [
    ...commonChecks(result),
    check("only one child was created", childContexts(result).length === 1),
    check("only one subagent invocation was made", toolAfter(result, "subagent").length === 1),
    check("the paid fallback was attempted once", paid.length === 1, `paid=${paid.length}`),
    check("every paid attempt was rate limited", paid.every((request) => request.status === 429)),
    check("no backup was used", mockRequests(result, "backup").length === 0),
    check(
      "the terminal child failure reached the parent once",
      reportsContaining(result.stdout, "PARENT-CHILD-FAILED") === 1,
    ),
  ];
}

function evaluateLifecycle(result: RunResult): Check[] {
  const children = childContexts(result);
  const first = children[0];
  const second = children[1];
  const firstID = String(first?.sessionID);
  const secondID = String(second?.sessionID);
  const firstFree = httpRequests(result, "free", "explore").filter(
    (event) => event.sessionID === firstID,
  );
  const firstPaid = httpRequests(result, "paid", "explore").filter(
    (event) => event.sessionID === firstID,
  );
  const secondFree = httpRequests(result, "free", "explore").filter(
    (event) => event.sessionID === secondID,
  );
  const firstPaidMock = mockRequests(result, "paid");
  const followUps = result.requests.filter((request) =>
    request.messages.some((message) => message.text.includes("Follow up")),
  );

  return [
    check("run did not time out", !result.timedOut),
    check("two child sessions were created", children.length === 2),
    check(
      "the second child has a different session",
      Boolean(firstID && secondID && firstID !== secondID),
    ),
    check("the first child used the fallback", firstPaid.length > 0),
    check("the first child did not return to free", freeAfter(result, firstID, firstPaid)),
    check(
      "the first child follow-up used the fallback",
      firstPaidMock.length >= 2 && followUps.some((request) => request.provider === "paid"),
    ),
    check("the second child started on free", secondFree.length > 0),
    check(
      "the second child did not use paid",
      httpRequests(result, "paid", "explore").every((event) => event.sessionID !== secondID),
    ),
    check("both children completed one read", toolAfter(result, "read").length === 2),
    check(
      "the parent received a marker-derived report",
      reportsContaining(result.stdout, "PARENT-REPORT:") >= 1 &&
        result.stdout.includes(result.marker),
    ),
    check("the run exited successfully", result.exitCode === 0, `exit=${result.exitCode}`),
  ];
}

function evaluateVariants(result: RunResult): Check[] {
  const child = childContexts(result)[0];
  const childID = String(child?.sessionID);
  const native = mockRequests(result, "native");

  return [
    ...commonChecks(result),
    assertChildUses(result, childID, "free", "explore", "the child started on free/explore"),
    assertChildUses(result, childID, "native", "explore", "the fallback stayed in the child"),
    check("only the native target was used", mockRequests(result, "paid").length === 0),
    check("one native request was made", native.length === 1, `native=${native.length}`),
    check(
      "the native request used the high variant header",
      native[0]?.variantHeader === "high",
      `header=${native[0]?.variantHeader ?? "missing"}`,
    ),
    check(
      "the native request used the Anthropic protocol",
      native[0]?.protocol === "anthropic",
    ),
    check(
      "the native request carried the original tool result",
      native[0]?.marker === true && hasToolCall(native[0], "read"),
    ),
    check(
      "the parent received the Anthropic report",
      result.stdout.includes(result.marker) &&
        reportsContaining(result.stdout, "PARENT-REPORT:") === 1,
    ),
    check("the run exited successfully", result.exitCode === 0, `exit=${result.exitCode}`),
  ];
}

function evaluateUnknownVariant(result: RunResult): Check[] {
  const child = childContexts(result)[0];
  const childID = String(child?.sessionID);
  const paid = mockRequests(result, "paid");

  return [
    ...commonChecks(result),
    assertChildUses(result, childID, "free", "explore", "the child started on free/explore"),
    assertChildUses(result, childID, "paid", "explore", "the next target took over"),
    check("the unknown variant was not used", mockRequests(result, "native").length === 0),
    check(
      "the paid fallback carried the tool result",
      paid.some((request) => request.marker),
    ),
    check("the run exited successfully", result.exitCode === 0, `exit=${result.exitCode}`),
  ];
}

function freeAfter(result: RunResult, childID: string, paid: Event[]): boolean {
  const firstPaid = paid[0];
  if (!firstPaid) return false;

  return httpRequests(result, "free", "explore").every(
    (event) => event.sessionID !== childID || eventIndex(result, event) < eventIndex(result, firstPaid),
  );
}

function eventIndex(result: RunResult, event: Event | undefined): number {
  return event ? result.events.indexOf(event) : -1;
}

function evaluate(scenario: Scenario, result: RunResult): Check[] {
  switch (scenario) {
    case "core":
      return evaluateCore(result);
    case "root429":
      return evaluateRoot429(result);
    case "non429":
      return evaluateNon429(result);
    case "chain":
      return evaluateChain(result);
    case "exhausted":
      return evaluateExhausted(result);
    case "lifecycle":
      return evaluateLifecycle(result);
    case "variants":
      return evaluateVariants(result);
    case "unknownVariant":
      return evaluateUnknownVariant(result);
  }
}

function printRequests(result: RunResult): void {
  console.log("  requests:");
  for (const request of result.requests) {
    console.log(
      `    ${request.sequence}. ${request.protocol} ${request.provider}/${request.model ?? "?"} ` +
        `status=${request.status} marker=${request.marker} tools=${request.messages
          .flatMap((message) => message.toolCallNames)
          .join(",") || "-"}`,
    );
  }
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (requested && !SCENARIOS.includes(requested as Scenario)) {
    console.error(`unknown scenario: ${requested}`);
    console.error(`available: ${SCENARIOS.join(", ")}`);
    process.exit(2);
  }

  const selected: readonly Scenario[] = requested
    ? [requested as Scenario]
    : SCENARIOS;
  const runtimeVersion = await detectRuntime();
  console.log(`OpenCode runtime: ${runtimeVersion}`);
  console.log(`Plugin directory: ${PLUGIN_DIR}`);

  const failures: string[] = [];

  for (const scenario of selected) {
    console.log(`\n=== ${scenario} ===`);
    const result = await runScenario(scenario, runtimeVersion);
    const checks = evaluate(scenario, result);

    for (const entry of checks) {
      console.log(
        `${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`,
      );
    }

    if (checks.some((entry) => !entry.ok)) {
      failures.push(scenario);
      printRequests(result);
      if (result.stderr.trim()) {
        console.log("  stderr:");
        console.log(
          result.stderr
            .split("\n")
            .slice(-20)
            .map((line) => `    ${line}`)
            .join("\n"),
        );
      }
    }
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} scenario(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }

  console.log(`\nAll ${selected.length} scenario(s) passed.`);
}

await main();
