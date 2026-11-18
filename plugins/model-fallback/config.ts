import { isRecord } from "./guards.ts";

export interface SourceModel {
  readonly providerID: string;
  readonly id: string;
}

export interface ModelTarget extends SourceModel {
  readonly variant?: string;
}

export interface FallbackConfig {
  /** Ordered targets keyed by `provider/model` of the original source. */
  readonly targetsBySource: ReadonlyMap<string, readonly ModelTarget[]>;
  readonly diagnostics: readonly string[];
}

const EMPTY_CONFIG: FallbackConfig = {
  targetsBySource: new Map(),
  diagnostics: [],
};

export function sourceKey(model: SourceModel): string {
  return `${model.providerID}/${model.id}`;
}

export function targetKey(target: ModelTarget): string {
  return target.variant === undefined
    ? sourceKey(target)
    : `${sourceKey(target)}#${target.variant}`;
}

export function formatTarget(target: ModelTarget): string {
  return targetKey(target);
}

/**
 * Parse the `fallback` option. Malformed entries are reported and skipped;
 * valid sibling entries remain active.
 */
export function parseFallbackConfig(options: unknown): FallbackConfig {
  if (!isRecord(options)) return EMPTY_CONFIG;

  const value = options.fallback;
  if (value === undefined) return EMPTY_CONFIG;
  if (!isRecord(value)) {
    return {
      targetsBySource: new Map(),
      diagnostics: ['the "fallback" option must be an object mapping "provider/model" to target lists'],
    };
  }

  const targetsBySource = new Map<string, readonly ModelTarget[]>();
  const diagnostics: string[] = [];

  for (const [key, entries] of Object.entries(value)) {
    const source = parseSourceEntry(key, diagnostics);
    if (!source) continue;

    if (!Array.isArray(entries)) {
      diagnostics.push(`fallback[${JSON.stringify(key)}] must be an array of target models`);
      continue;
    }

    const targets = parseTargets(key, source, entries, diagnostics);
    if (targets.length > 0) targetsBySource.set(sourceKey(source), targets);
  }

  return { targetsBySource, diagnostics };
}

function parseSourceEntry(key: string, diagnostics: string[]): SourceModel | undefined {
  const source = parseSource(key);
  if (source) return source;

  diagnostics.push(
    `fallback key ${JSON.stringify(key)} is not a valid source model: expected "provider/model" without a variant`,
  );
  return undefined;
}

function parseTargets(
  key: string,
  source: SourceModel,
  entries: readonly unknown[],
  diagnostics: string[],
): ModelTarget[] {
  const targets: ModelTarget[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    if (typeof entry !== "string") {
      diagnostics.push(
        `fallback[${JSON.stringify(key)}][${index}] must be a string: expected "provider/model[#variant]"`,
      );
      return;
    }

    const target = parseTarget(entry);
    if (!target) {
      diagnostics.push(
        `fallback[${JSON.stringify(key)}][${index}] is not a valid target: expected "provider/model[#variant]"`,
      );
      return;
    }

    if (isSelfTarget(source, target)) return;

    const dedupeKey = targetKey(target);
    if (seen.has(dedupeKey)) return;

    seen.add(dedupeKey);
    targets.push(target);
  });

  return targets;
}

/** Split at the first `/` so model IDs may contain slashes. */
function parseSource(value: string): SourceModel | undefined {
  if (value.includes("#")) return undefined;

  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;

  return {
    providerID: value.slice(0, separator),
    id: value.slice(separator + 1),
  };
}

function parseTarget(value: string): ModelTarget | undefined {
  if (value.length === 0) return undefined;

  const separator = value.indexOf("#");
  if (separator === -1) return parseSource(value);

  if (value.indexOf("#", separator + 1) !== -1) return undefined;

  const variant = value.slice(separator + 1);
  if (variant.length === 0) return undefined;

  const source = parseSource(value.slice(0, separator));
  return source ? { ...source, variant } : undefined;
}

function isSelfTarget(source: SourceModel, target: ModelTarget): boolean {
  return source.providerID === target.providerID && source.id === target.id;
}
