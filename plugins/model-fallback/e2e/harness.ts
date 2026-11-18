import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, type MockHandle, type Scenario } from "./mock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * `MODEL_FALLBACK_PLUGIN_DIR` lets the release check load the unpacked package
 * instead of the workspace directory.
 */
export const PLUGIN_DIR =
  process.env.MODEL_FALLBACK_PLUGIN_DIR ?? resolve(HERE, "..");
const OBSERVER_DIR = join(HERE, "observer");
const REQUIRED_RUNTIME = "2.3.2";
const TIMEOUT_MS = 60_000;
const TASK =
  "Start the explore subagent to read marker.txt and report the exact marker.";
const MOCK_PROVIDERS = ["free", "paid", "backup", "native"] as const;

export interface RunResult {
  readonly scenario: Scenario;
  readonly runtimeVersion: string;
  readonly marker: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: MockHandle["requests"];
  readonly events: MockHandle["events"];
}

export async function runScenario(
  scenario: Scenario,
  runtimeVersion: string,
): Promise<RunResult> {
  const opencode = requireOpenCode();
  const marker = `E2E-MARKER-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const root = await mkdtemp(join(tmpdir(), "opencode-model-fallback-e2e-"));

  try {
    const workspace = join(root, "workspace");
    const configDir = join(root, "config");
    const dataDir = join(root, "data");
    const cacheDir = join(root, "cache");
    const stateDir = join(root, "state");
    await Promise.all(
      [workspace, configDir, dataDir, cacheDir, stateDir].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
    await writeFile(join(workspace, "marker.txt"), `${marker}\n`, "utf8");

    const mock = startMock(scenario, marker);
    try {
      await writeFile(
        join(workspace, "opencode.jsonc"),
        configFor(scenario, mock.url),
        "utf8",
      );

      const result = await spawnRun({
        opencode,
        workspace,
        configDir,
        dataDir,
        cacheDir,
        stateDir,
      });

      return {
        scenario,
        runtimeVersion,
        marker,
        ...result,
        requests: mock.requests,
        events: mock.events,
      };
    } finally {
      await mock.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function detectRuntime(): Promise<string> {
  const opencode = requireOpenCode();
  const proc = Bun.spawn([opencode, "--version"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const version = `${stdout}${stderr}`.trim();
  if (exitCode !== 0 || !/(?:^|[^\d.])2\.3\.2(?![\d.])/.test(version)) {
    throw new Error(
      `these regressions require OpenCode ${REQUIRED_RUNTIME}; found ${version || "no version output"}`,
    );
  }
  return version.split("\n")[0] ?? version;
}

function requireOpenCode(): string {
  const binary = Bun.which("opencode");
  if (!binary) {
    throw new Error(
      `opencode ${REQUIRED_RUNTIME} is required for the model-fallback integration suite but was not found on PATH`,
    );
  }
  return binary;
}

interface SpawnOptions {
  readonly opencode: string;
  readonly workspace: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly stateDir: string;
}

async function spawnRun(options: SpawnOptions): Promise<{
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  const args = [
    options.opencode,
    "run",
    "--standalone",
    "--format",
    "json",
    "--model",
    "free/parent",
    "--agent",
    "e2e-parent",
    "--archived",
    "--title",
    "model-fallback e2e",
    TASK,
  ];

  const proc = Bun.spawn(args, {
    cwd: options.workspace,
    env: isolatedEnv(options),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, TIMEOUT_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  return { exitCode, timedOut, stdout, stderr };
}

function isolatedEnv(options: SpawnOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SHELL"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  return {
    ...env,
    OPENCODE_CONFIG_DIR: options.configDir,
    XDG_DATA_HOME: options.dataDir,
    XDG_CACHE_HOME: options.cacheDir,
    XDG_STATE_HOME: options.stateDir,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    NO_COLOR: "1",
  };
}

function configFor(scenario: Scenario, mockURL: string): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "free/parent",
      providers: providers(mockURL),
      agents: agents(),
      plugins: [
        {
          package: PLUGIN_DIR,
          options: { fallback: fallbackFor(scenario) },
        },
        {
          package: OBSERVER_DIR,
          options: {
            endpoint: `${mockURL}/__observer`,
            providers: MOCK_PROVIDERS,
          },
        },
      ],
    },
    null,
    2,
  );
}

function providers(mockURL: string): Record<string, unknown> {
  const openAi = (path: string, name: string) => ({
    name,
    package: "@opencode/ai/providers/openai-compatible",
    settings: {
      baseURL: `${mockURL}/${path}/v1`,
      apiKey: `e2e-${path}-key`,
      timeout: 20_000,
    },
    models: {
      parent: { name: `${name} Parent`, limit: { context: 100_000, output: 8_192 } },
      explore: { name: `${name} Explore`, limit: { context: 100_000, output: 8_192 } },
    },
  });

  return {
    free: openAi("free", "E2E Free"),
    paid: openAi("paid", "E2E Paid"),
    backup: openAi("backup", "E2E Backup"),
    native: {
      name: "E2E Native Anthropic",
      package: "@opencode/ai/providers/anthropic",
      settings: {
        baseURL: `${mockURL}/anthropic/v1`,
        apiKey: "e2e-anthropic-key",
        timeout: 20_000,
      },
      models: {
        explore: {
          name: "E2E Native Explore",
          limit: { context: 100_000, output: 8_192 },
          variants: [
            {
              id: "high",
              headers: { "x-mock-variant": "high" },
            },
          ],
        },
      },
    },
  };
}

function agents(): Record<string, unknown> {
  return {
    "e2e-parent": {
      description: "Integration test parent orchestrator",
      mode: "primary",
      model: "free/parent",
      system:
        "Launch the explore subagent, then report its answer. Do not use other tools.",
      permissions: [
        { action: "read", resource: "*", effect: "deny" },
        { action: "subagent", resource: "explore", effect: "allow" },
      ],
    },
    explore: {
      description: "Integration test explore subagent",
      mode: "subagent",
      model: "free/explore",
      system: "Read the requested file and report its exact contents.",
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    },
  };
}

function fallbackFor(scenario: Scenario): Record<string, string[]> {
  switch (scenario) {
    case "chain":
      return { "free/explore": ["paid/explore", "backup/explore"] };
    case "root429":
      return { "free/parent": ["paid/parent"] };
    case "variants":
      return { "free/explore": ["native/explore#high"] };
    case "unknownVariant":
      return { "free/explore": ["native/explore#missing", "paid/explore"] };
    case "core":
    case "non429":
    case "exhausted":
    case "lifecycle":
      return { "free/explore": ["paid/explore"] };
  }
}
