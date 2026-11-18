export type Scenario =
  | "core"
  | "root429"
  | "non429"
  | "chain"
  | "exhausted"
  | "lifecycle"
  | "variants"
  | "unknownVariant";

export type Provider = "free" | "paid" | "backup" | "native" | "unknown";

export interface NormalizedMessage {
  readonly role: string;
  readonly text: string;
  readonly toolCallNames: readonly string[];
  readonly toolResult: boolean;
}

export interface MockRequest {
  readonly sequence: number;
  readonly at: string;
  readonly protocol: "openai" | "anthropic";
  readonly provider: Provider;
  readonly path: string;
  readonly model?: string;
  status: number;
  readonly stream: boolean;
  readonly variantHeader?: string;
  readonly messages: readonly NormalizedMessage[];
  readonly marker: boolean;
  readonly userPrompts: number;
  readonly subagentCalls: number;
}

export interface MockHandle {
  readonly url: string;
  readonly requests: MockRequest[];
  readonly events: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

const TOOL_NAMES = new Set(["subagent", "read", "glob"]);

export function startMock(scenario: Scenario, marker: string): MockHandle {
  const requests: MockRequest[] = [];
  const events: Array<Record<string, unknown>> = [];
  const markerPattern = new RegExp(marker);
  let rootAttempts = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/__observer") {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return Response.json({ ok: true });
      }

      if (url.pathname === "/anthropic/v1/messages") {
        return handleAnthropicRequest(request, requests, scenario, markerPattern);
      }

      return handleOpenAiRequest(
        request,
        url,
        requests,
        scenario,
        markerPattern,
        () => rootAttempts++,
      );
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    events,
    close: () => server.stop(true),
  };
}

async function handleOpenAiRequest(
  request: Request,
  url: URL,
  requests: MockRequest[],
  scenario: Scenario,
  markerPattern: RegExp,
  nextRootAttempt: () => number,
): Promise<Response> {
  const provider = providerFromPath(url.pathname);
  const body = await readJson(request);
  const messages = normalizeOpenAiMessages(body.messages);
  const model = typeof body.model === "string" ? body.model : undefined;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const stream = body.stream === true;
  const entry = createRequest({
    sequence: requests.length + 1,
    protocol: "openai",
    provider,
    path: url.pathname,
    model,
    stream,
    request,
    messages,
    markerPattern,
  });
  requests.push(entry);

  const response = await openAiResponse({
    scenario,
    provider,
    model,
    messages,
    tools: tools.length,
    stream,
    markerPattern,
    nextRootAttempt,
  });

  entry.status = response.status;
  return response;
}

function handleAnthropicRequest(
  request: Request,
  requests: MockRequest[],
  scenario: Scenario,
  markerPattern: RegExp,
): Promise<Response> {
  return request.json().then((value) => {
    const body = isRecord(value) ? value : {};
    const model = typeof body.model === "string" ? body.model : undefined;
    const messages = normalizeAnthropicMessages(body.messages);
    const entry = createRequest({
      sequence: requests.length + 1,
      protocol: "anthropic",
      provider: "native",
      path: new URL(request.url).pathname,
      model,
      stream: true,
      request,
      messages,
      markerPattern,
    });

    const response = anthropicResponse({
      scenario,
      messages,
      markerPattern,
    });

    entry.status = response.status;
    requests.push(entry);
    return response;
  });
}

interface OpenAiInput {
  readonly scenario: Scenario;
  readonly provider: Provider;
  readonly model?: string;
  readonly messages: readonly NormalizedMessage[];
  readonly tools: number;
  readonly stream: boolean;
  readonly markerPattern: RegExp;
  readonly nextRootAttempt: () => number;
}

function openAiResponse(input: OpenAiInput): Response {
  const { scenario, provider, model, messages, tools, stream } = input;

  if (provider === "unknown") return notFound(`No mock route for ${provider}/${model}`);

  if (scenario === "root429" && provider === "free" && model === "parent") {
    if (input.nextRootAttempt() === 0) return rateLimited();
    return textResponse("openai", model, "ROOT-OK", stream);
  }

  if (provider === "free" && model === "parent") {
    return parentResponse(input);
  }

  if (provider === "free" && model === "explore") {
    return freeChildResponse(input);
  }

  if (provider === "paid" && model === "explore") {
    return paidChildResponse(input);
  }

  if (provider === "backup" && model === "explore") {
    return backupChildResponse(input);
  }

  return notFound(`No mock model ${provider}/${model}`);
}

function parentResponse(input: OpenAiInput): Response {
  const { scenario, messages, stream, markerPattern } = input;
  const markerText = findMarker(messages, markerPattern);
  const calls = subagentCallCount(messages);

  if (scenario === "lifecycle") {
    if (calls === 0) return subagentCall(input, { prompt: INITIAL_CHILD_PROMPT });
    if (calls === 1 && markerText) {
      const sessionID = findSessionID(messages);
      return subagentCall(input, {
        sessionID,
        description: "Follow up on the same child",
        prompt: FOLLOW_UP_PROMPT,
      });
    }
    if (calls === 2 && markerText) {
      return subagentCall(input, { prompt: SECOND_CHILD_PROMPT });
    }
    if (calls >= 3 && markerText) {
      return textResponse("openai", "parent", `PARENT-REPORT:${markerText}`, stream);
    }
    return textResponse("openai", "parent", "PARENT-WAITING", stream);
  }

  if (!hasSubagentCall(messages)) {
    return subagentCall(input, { prompt: INITIAL_CHILD_PROMPT });
  }

  if (markerText) {
    return textResponse("openai", "parent", `PARENT-REPORT:${markerText}`, stream);
  }

  if (scenario === "exhausted" && messagesHaveSubagentFailure(messages)) {
    return textResponse("openai", "parent", "PARENT-CHILD-FAILED", stream);
  }

  return textResponse("openai", "parent", "PARENT-WAITING", stream);
}

function freeChildResponse(input: OpenAiInput): Response {
  const { scenario, messages, stream, markerPattern } = input;
  const hasResult = hasToolResult(messages);
  const text = messages.map((message) => message.text).join("\n");

  if (scenario === "lifecycle" && text.includes("second child")) {
    if (!hasResult) return readCall(input);
    const markerText = findMarker(messages, markerPattern);
    return textResponse("openai", "explore", `FREE-SECOND:${markerText}`, stream);
  }

  if (scenario === "lifecycle" && text.includes("Follow up")) {
    return textResponse("openai", "explore", "FREE-UNEXPECTED-FOLLOWUP", stream);
  }

  if (!hasResult) return readCall(input);

  if (scenario === "non429") {
    return Response.json(
      {
        error: {
          message: "Mock model not found",
          type: "invalid_request_error",
          code: "model_not_found",
        },
      },
      { status: 404 },
    );
  }

  return rateLimited();
}

function paidChildResponse(input: OpenAiInput): Response {
  const { scenario, messages, stream, markerPattern } = input;
  const markerText = findMarker(messages, markerPattern);
  const text = messages.map((message) => message.text).join("\n");

  if (scenario === "exhausted") return rateLimited();
  if (!markerText) return textResponse("openai", "explore", "PAID-MISSING-HISTORY", stream);

  if (scenario === "chain" && !hasToolCall(messages, "glob")) {
    return rateLimited();
  }

  if (scenario === "lifecycle" && text.includes("Follow up")) {
    return textResponse("openai", "explore", `PAID-FOLLOWUP:${markerText}`, stream);
  }

  return textResponse("openai", "explore", `PAID-REPORT:${markerText}`, stream);
}

function backupChildResponse(input: OpenAiInput): Response {
  const { messages, stream, markerPattern } = input;
  const markerText = findMarker(messages, markerPattern);

  if (!markerText) return textResponse("openai", "explore", "BACKUP-MISSING-HISTORY", stream);
  if (!hasToolCall(messages, "glob")) {
    return toolResponse("openai", "explore", {
      id: `call_glob_${crypto.randomUUID()}`,
      name: "glob",
      arguments: { pattern: "*.txt" },
    }, stream);
  }

  return textResponse("openai", "explore", `BACKUP-REPORT:${markerText}`, stream);
}

interface AnthropicInput {
  readonly scenario: Scenario;
  readonly messages: readonly NormalizedMessage[];
  readonly markerPattern: RegExp;
}

function anthropicResponse(input: AnthropicInput): Response {
  if (input.scenario === "unknownVariant") {
    return textResponse("anthropic", "explore", "ANTHROPIC-SHOULD-NOT-RUN");
  }

  const markerText = findMarker(input.messages, input.markerPattern);
  if (!markerText) {
    return textResponse("anthropic", "explore", "ANTHROPIC-MISSING-HISTORY");
  }

  return textResponse("anthropic", "explore", `ANTHROPIC-REPORT:${markerText}`);
}

const INITIAL_CHILD_PROMPT =
  "Read marker.txt with the read tool and report the exact marker text.";
const FOLLOW_UP_PROMPT =
  "Follow up on the same task and report the exact marker text again.";
const SECOND_CHILD_PROMPT =
  "Read marker.txt in the second child and report the exact marker text.";

function subagentCall(
  input: OpenAiInput,
  options: { prompt: string; sessionID?: string; description?: string },
): Response {
  return toolResponse("openai", "parent", {
    id: `call_subagent_${crypto.randomUUID()}`,
    name: "subagent",
    arguments: {
      agent: "explore",
      description: options.description ?? "Explore the marker file",
      prompt: options.prompt,
      ...(options.sessionID ? { sessionID: options.sessionID } : {}),
    },
  }, input.stream);
}

function readCall(input: OpenAiInput): Response {
  return toolResponse("openai", "explore", {
    id: `call_read_${crypto.randomUUID()}`,
    name: "read",
    arguments: { path: "marker.txt" },
  }, input.stream);
}

function createRequest(options: {
  sequence: number;
  protocol: "openai" | "anthropic";
  provider: Provider;
  path: string;
  model?: string;
  stream: boolean;
  request: Request;
  messages: readonly NormalizedMessage[];
  markerPattern: RegExp;
}): MockRequest {
  return {
    sequence: options.sequence,
    at: new Date().toISOString(),
    protocol: options.protocol,
    provider: options.provider,
    path: options.path,
    model: options.model,
    status: 200,
    stream: options.stream,
    variantHeader: options.request.headers.get("x-mock-variant") ?? undefined,
    messages: options.messages,
    marker: options.messages.some((message) => options.markerPattern.test(message.text)),
    userPrompts: options.messages.filter((message) => message.role === "user").length,
    subagentCalls: subagentCallCount(options.messages),
  };
}

async function readJson(request: Request): Promise<Json> {
  try {
    const value = await request.json();
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function providerFromPath(path: string): Provider {
  if (path.startsWith("/free/")) return "free";
  if (path.startsWith("/paid/")) return "paid";
  if (path.startsWith("/backup/")) return "backup";
  return "unknown";
}

function normalizeOpenAiMessages(value: unknown): NormalizedMessage[] {
  if (!Array.isArray(value)) return [];

  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const toolCallNames = calls
      .map((call) => {
        if (!isRecord(call) || !isRecord(call.function)) return "";
        return typeof call.function.name === "string" ? call.function.name : "";
      })
      .filter((name) => TOOL_NAMES.has(name));

    return {
      role: typeof record.role === "string" ? record.role : "unknown",
      text: textOf(record.content),
      toolCallNames,
      toolResult: record.role === "tool",
    };
  });
}

function normalizeAnthropicMessages(value: unknown): NormalizedMessage[] {
  if (!Array.isArray(value)) return [];

  return value.map((item) => {
    const record = isRecord(item) ? item : {};
    const content = Array.isArray(record.content) ? record.content : [];
    const toolCallNames: string[] = [];
    let text = "";
    let toolResult = false;

    for (const block of content) {
      if (!isRecord(block)) continue;

      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        if (TOOL_NAMES.has(block.name)) toolCallNames.push(block.name);
      }
      if (block.type === "tool_result") {
        toolResult = true;
        text += JSON.stringify(block.content ?? "");
      }
    }

    return {
      role: typeof record.role === "string" ? record.role : "unknown",
      text,
      toolCallNames,
      toolResult,
    };
  });
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join("");
}

function findMarker(
  messages: readonly NormalizedMessage[],
  markerPattern: RegExp,
): string | undefined {
  for (const message of messages) {
    const match = message.text.match(markerPattern);
    if (match) return match[0];
  }
  return undefined;
}

function findSessionID(messages: readonly NormalizedMessage[]): string | undefined {
  const pattern = /sessionID\s*[:=]\s*"?(ses_[A-Za-z0-9]+)/;
  for (const message of messages) {
    const match = message.text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function hasToolResult(messages: readonly NormalizedMessage[]): boolean {
  return messages.some((message) => message.toolResult);
}

function hasToolCall(messages: readonly NormalizedMessage[], name: string): boolean {
  return messages.some((message) => message.toolCallNames.includes(name));
}

function hasSubagentCall(messages: readonly NormalizedMessage[]): boolean {
  return hasToolCall(messages, "subagent");
}

function subagentCallCount(messages: readonly NormalizedMessage[]): number {
  return messages.reduce(
    (count, message) =>
      count + message.toolCallNames.filter((name) => name === "subagent").length,
    0,
  );
}

function messagesHaveSubagentFailure(messages: readonly NormalizedMessage[]): boolean {
  return messages.some(
    (message) =>
      message.text.includes("Subagent failed") ||
      message.text.includes("Subagent cancelled") ||
      message.text.includes("rate limit"),
  );
}

function notFound(message: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", code: "not_found" } },
    { status: 404 },
  );
}

function rateLimited(): Response {
  return Response.json(
    {
      error: {
        message: "Mock rate limit",
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    },
    { status: 429, headers: { "retry-after": "0" } },
  );
}

function textResponse(
  protocol: "openai" | "anthropic",
  model: string,
  text: string,
  stream = true,
): Response {
  return protocol === "openai"
    ? openAiTextResponse(model, text, stream)
    : anthropicTextResponse(model, text);
}

function toolResponse(
  protocol: "openai",
  model: string,
  call: { id: string; name: string; arguments: Json },
  stream: boolean,
): Response {
  const args = JSON.stringify(call.arguments);

  if (!stream) {
    return Response.json(openAiCompletion(model, {
      content: null,
      tool_calls: [
        { id: call.id, type: "function", function: { name: call.name, arguments: args } },
      ],
    }, "tool_calls"));
  }

  return sse([
    openAiChunk(model, { role: "assistant", content: "" }, null),
    openAiChunk(model, {
      tool_calls: [
        {
          index: 0,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: args },
        },
      ],
    }, null),
    openAiChunk(model, {}, "tool_calls"),
    "[DONE]",
  ]);
}

function openAiTextResponse(model: string, text: string, stream: boolean): Response {
  if (!stream) return Response.json(openAiCompletion(model, { content: text }, "stop"));

  return sse([
    openAiChunk(model, { role: "assistant", content: "" }, null),
    openAiChunk(model, { content: text }, null),
    openAiChunk(model, {}, "stop"),
    "[DONE]",
  ]);
}

function openAiCompletion(
  model: string,
  message: Record<string, unknown>,
  finish: string,
): Json {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function openAiChunk(
  model: string,
  delta: Record<string, unknown>,
  finish: string | null,
): Json {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function anthropicTextResponse(model: string, text: string): Response {
  return sse([
    {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ]);
}

function sse(events: Array<Json | "[DONE]">): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const event of events) {
        const data = event === "[DONE]" ? "[DONE]" : JSON.stringify(event);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
