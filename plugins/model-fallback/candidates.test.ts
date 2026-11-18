import { describe, expect, test } from "bun:test";
import {
  chainOwns,
  createChain,
  describeSkip,
  selectCandidate,
  toModelRef,
  type InventoryModel,
} from "./candidates";
import type { ModelTarget } from "./config";

const A: ModelTarget = { providerID: "p", id: "a" };
const B: ModelTarget = { providerID: "p", id: "b" };
const C: ModelTarget = { providerID: "q", id: "c" };

function inventory(...models: InventoryModel[]): InventoryModel[] {
  return models;
}

function model(
  target: ModelTarget,
  overrides: Partial<InventoryModel> = {},
): InventoryModel {
  return {
    providerID: target.providerID,
    id: target.id,
    enabled: true,
    variants: [],
    ...overrides,
  };
}

describe("selectCandidate", () => {
  test("follows the configured order from the cursor", () => {
    const targets = [A, B, C];
    const available = inventory(model(A), model(B), model(C));

    expect(selectCandidate(targets, available).target).toEqual(A);
    expect(selectCandidate(targets, available, 1).target).toEqual(B);
    expect(selectCandidate(targets, available, 2).target).toEqual(C);
  });

  test("returns the selected index and honors a starting cursor", () => {
    const available = inventory(model(B), model(C));

    expect(selectCandidate([B, C], available).index).toBe(0);
    expect(selectCandidate([B, C], available, 1).index).toBe(1);
    expect(
      selectCandidate([B, C], available, 2).target,
    ).toBeUndefined();
  });

  test("skips an unavailable middle entry", () => {
    const choice = selectCandidate(
      [A, B, C],
      inventory(model(A), model(C)),
      1,
    );

    expect(choice.target).toEqual(C);
    expect(choice.skipped).toEqual([{ target: B, reason: "missing" }]);
  });

  test("skips a disabled model", () => {
    const choice = selectCandidate(
      [A, B],
      inventory(model(A, { enabled: false }), model(B)),
    );

    expect(choice.target).toEqual(B);
    expect(choice.skipped).toEqual([{ target: A, reason: "disabled" }]);
  });

  test("requires an explicit variant to exist", () => {
    const high: ModelTarget = { ...B, variant: "high" };
    const choice = selectCandidate(
      [high, C],
      inventory(model(B), model(C)),
    );

    expect(choice.target).toEqual(C);
    expect(choice.skipped).toEqual([{ target: high, reason: "variant-missing" }]);
  });

  test("accepts an explicit variant that exists", () => {
    const high: ModelTarget = { ...B, variant: "high" };
    const choice = selectCandidate(
      [high],
      inventory(model(B, { variants: [{ id: "high" }] })),
    );

    expect(choice.target).toEqual(high);
  });

  test("does not require a variant for a bare target", () => {
    const choice = selectCandidate([B], inventory(model(B)));

    expect(choice.target).toEqual(B);
    expect(choice.target?.variant).toBeUndefined();
  });

  test("returns no target when every entry is unavailable", () => {
    const choice = selectCandidate([A, B], inventory());

    expect(choice.target).toBeUndefined();
    expect(choice.skipped).toHaveLength(2);
  });
});

describe("fallback chain ownership", () => {
  test("starts at the first configured entry", () => {
    const chain = createChain({ providerID: "p", id: "a" }, [B]);

    expect(chain.cursor).toBe(0);
  });

  test("owns every variant of the source model", () => {
    const chain = createChain({ providerID: "p", id: "a" }, [B]);

    expect(chainOwns(chain, { providerID: "p", id: "a", variant: "high" })).toBe(
      true,
    );
    expect(chainOwns(chain, { providerID: "p", id: "b" })).toBe(false);
  });

  test("owns the current target and treats a bare target as the default", () => {
    const chain = createChain({ providerID: "p", id: "a" }, [B]);
    chain.current = B;

    expect(chainOwns(chain, { providerID: "p", id: "b", variant: "default" })).toBe(
      true,
    );
    expect(chainOwns(chain, { providerID: "p", id: "b", variant: "high" })).toBe(
      false,
    );
  });

  test("does not treat the source as owned after a successful switch", () => {
    const chain = createChain({ providerID: "p", id: "a" }, [B]);
    chain.current = B;

    expect(chainOwns(chain, { providerID: "p", id: "a" })).toBe(false);
  });
});

describe("toModelRef", () => {
  test("omits the variant for a bare target", () => {
    expect(toModelRef(B)).toEqual({ providerID: "p", id: "b" });
  });

  test("keeps an explicit target variant", () => {
    expect(toModelRef({ ...B, variant: "high" })).toEqual({
      providerID: "p",
      id: "b",
      variant: "high",
    });
  });
});

describe("describeSkip", () => {
  test("names every skip reason", () => {
    expect(describeSkip("missing")).toBe("model is not available");
    expect(describeSkip("disabled")).toBe("model is disabled");
    expect(describeSkip("variant-missing")).toBe(
      "requested variant is not available",
    );
  });
});
