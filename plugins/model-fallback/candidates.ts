import {
  sourceKey,
  type ModelTarget,
  type SourceModel,
} from "./config.ts";

export interface InventoryModel {
  readonly providerID: string;
  readonly id: string;
  readonly enabled?: boolean;
  readonly variants?: readonly { readonly id: string }[];
}

export type SkipReason = "missing" | "disabled" | "variant-missing";

export interface CandidateSkip {
  readonly target: ModelTarget;
  readonly reason: SkipReason;
}

export interface CandidateChoice {
  readonly target?: ModelTarget;
  /** Position of the selected target in the configured list. */
  readonly index?: number;
  readonly skipped: readonly CandidateSkip[];
}

export interface FallbackChain {
  readonly source: SourceModel;
  readonly targets: readonly ModelTarget[];
  current?: ModelTarget;
  /** Next position to consider; only a confirmed switch advances it. */
  cursor: number;
  readonly reported: Set<string>;
  exhausted?: boolean;
}

export interface RuntimeModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/** True for the same provider and model ID; variants are intentionally ignored. */
export function sameModel(a: RuntimeModelRef, b: RuntimeModelRef): boolean {
  return a.providerID === b.providerID && a.id === b.id;
}

/** True for the same provider, model ID, and variant. A bare variant means the default. */
export function sameSelection(a: RuntimeModelRef, b: RuntimeModelRef): boolean {
  return sameModel(a, b) && normalizeVariant(a.variant) === normalizeVariant(b.variant);
}

/**
 * A chain owns the selected model only while the child is still on the source
 * or on the target recorded by a successful switch.
 */
export function chainOwns(chain: FallbackChain, selected: RuntimeModelRef): boolean {
  if (chain.current) return sameSelection(chain.current, selected);

  return sameModel(chain.source, selected);
}

export function createChain(
  source: SourceModel,
  targets: readonly ModelTarget[],
): FallbackChain {
  return {
    source,
    targets,
    cursor: 0,
    reported: new Set(),
  };
}

/**
 * Select the first available target at or after `from`. `from` is the chain
 * cursor, so an entry that was skipped before a successful switch is never
 * reconsidered if it recovers later.
 */
export function selectCandidate(
  targets: readonly ModelTarget[],
  inventory: readonly InventoryModel[],
  from = 0,
): CandidateChoice {
  const models = indexInventory(inventory);
  const skipped: CandidateSkip[] = [];

  for (let index = Math.max(0, from); index < targets.length; index += 1) {
    const target = targets[index];
    if (!target) continue;

    const reason = unavailableReason(target, models);
    if (reason) {
      skipped.push({ target, reason });
      continue;
    }

    return { target, index, skipped };
  }

  return { skipped };
}

export function toModelRef(target: ModelTarget): RuntimeModelRef {
  return target.variant === undefined
    ? { providerID: target.providerID, id: target.id }
    : { providerID: target.providerID, id: target.id, variant: target.variant };
}

export function describeSkip(reason: SkipReason): string {
  switch (reason) {
    case "missing":
      return "model is not available";
    case "disabled":
      return "model is disabled";
    case "variant-missing":
      return "requested variant is not available";
  }
}

export function chainLabel(chain: FallbackChain): string {
  return sourceKey(chain.source);
}

function normalizeVariant(variant: string | undefined): string {
  return variant ?? "default";
}

function indexInventory(
  inventory: readonly InventoryModel[],
): ReadonlyMap<string, InventoryModel> {
  const models = new Map<string, InventoryModel>();

  for (const model of inventory) {
    models.set(sourceKey(model), model);
  }

  return models;
}

function unavailableReason(
  target: ModelTarget,
  models: ReadonlyMap<string, InventoryModel>,
): SkipReason | undefined {
  const model = models.get(sourceKey(target));
  if (!model) return "missing";
  if (model.enabled === false) return "disabled";

  if (target.variant !== undefined) {
    const variants = model.variants ?? [];
    if (!variants.some((variant) => variant.id === target.variant)) {
      return "variant-missing";
    }
  }

  return undefined;
}
