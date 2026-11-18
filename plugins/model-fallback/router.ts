import {
  chainLabel,
  chainOwns,
  createChain,
  describeSkip,
  selectCandidate,
  sameSelection,
  toModelRef,
  type FallbackChain,
  type CandidateSkip,
  type InventoryModel,
  type RuntimeModelRef,
} from "./candidates.ts";
import {
  formatTarget,
  sourceKey,
  targetKey,
  type FallbackConfig,
  type ModelTarget,
} from "./config.ts";

export interface FallbackSessionInfo {
  readonly parentID?: string;
  readonly model?: RuntimeModelRef;
}

export interface FallbackRuntime {
  getSession(
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<FallbackSessionInfo>;
  switchModel(
    sessionID: string,
    model: RuntimeModelRef,
    signal?: AbortSignal,
  ): Promise<void>;
  listModels(signal?: AbortSignal): Promise<readonly InventoryModel[]>;
}

export interface FallbackRetryEvent {
  readonly sessionID: string;
  readonly model: RuntimeModelRef;
  readonly errorStatus: number | undefined;
}

export type RetryDecision =
  | { readonly retry: true; readonly delay: 0 }
  | { readonly retry: false };

export interface FallbackRouterOptions {
  readonly config: FallbackConfig;
  readonly runtime: FallbackRuntime;
  readonly warn: (message: string) => void;
}

interface Operation {
  readonly controller: AbortController;
}

/** Bound retained routing state; new sessions fail closed when it is full. */
const MAX_CHAINS = 512;
const MAX_OPERATIONS = 512;

/**
 * Applies the fallback policy for one plugin instance.
 *
 * Rules belong to models, while a switch belongs to one child session. Any
 * native `retry` with a `429` in a child whose selected model is a configured
 * source or the current target of its own chain may take over. Root sessions
 * and every other error keep the host decision.
 */
export class FallbackRouter {
  private readonly chains = new Map<string, FallbackChain>();
  private readonly operations = new Map<string, Operation>();
  private closed = false;

  constructor(private readonly options: FallbackRouterOptions) {}

  /**
   * Return a decision only when this plugin owns the failed retry. `undefined`
   * leaves the host's native retry policy untouched.
   */
  async handleRetry(
    event: FallbackRetryEvent,
  ): Promise<RetryDecision | undefined> {
    if (this.closed) return undefined;
    if (event.errorStatus !== 429) return undefined;
    if (this.operations.has(event.sessionID)) return undefined;

    const operation = this.beginOperation(event.sessionID);
    if (!operation) return undefined;

    try {
      const decision = await this.fallback(event, operation);
      return this.isCurrent(event.sessionID, operation) ? decision : undefined;
    } catch (error) {
      if (this.isCurrent(event.sessionID, operation)) {
        this.warn(
          `unexpected failure while routing session ${event.sessionID}: ${describeError(error)}`,
        );
      }
      return undefined;
    } finally {
      this.finishOperation(event.sessionID, operation);
    }
  }

  /** Release a deleted session and invalidate any decision still in flight. */
  forgetSession(sessionID: string): void {
    if (this.closed) return;

    this.invalidateOperation(sessionID);
    this.chains.delete(sessionID);
  }

  /** Invalidate a pending decision for a child whose execution was interrupted. */
  interruptSession(sessionID: string): void {
    if (this.closed) return;

    this.invalidateOperation(sessionID);
  }

  /**
   * Close the router before any asynchronous unload work starts. Pending
   * operations are aborted and all state is dropped; late hook callbacks can no
   * longer start a switch or publish a retry decision.
   */
  close(): void {
    if (this.closed) return;

    this.closed = true;
    for (const operation of this.operations.values()) {
      operation.controller.abort();
    }

    this.operations.clear();
    this.chains.clear();
  }

  private async fallback(
    event: FallbackRetryEvent,
    operation: Operation,
  ): Promise<RetryDecision | undefined> {
    const signal = operation.controller.signal;
    const session = await this.readSession(event.sessionID, signal);
    if (!this.isCurrent(event.sessionID, operation)) return undefined;
    if (!session?.parentID) return undefined;

    if (!session.model || !sameSelection(session.model, event.model)) {
      this.discardUnownedSelection(event.sessionID, session.model);
      return undefined;
    }

    const chain = this.chainFor(event.sessionID, session.model);
    if (!chain) return undefined;

    const inventory = await this.readInventory(signal);
    if (!this.isCurrent(event.sessionID, operation)) return undefined;
    if (!inventory) return undefined;

    // The inventory lookup can be slow. Revalidate the child selection before
    // any switch so a manual change made while waiting is never overwritten.
    const current = await this.readSession(event.sessionID, signal);
    if (!this.isCurrent(event.sessionID, operation)) return undefined;
    if (!current) return undefined;
    if (
      !current.parentID ||
      !current.model ||
      !sameSelection(current.model, event.model)
    ) {
      this.discardUnownedSelection(event.sessionID, current.model);
      return undefined;
    }

    const choice = selectCandidate(
      chain.targets,
      inventory,
      chain.cursor,
    );
    this.reportSkips(chain, choice.skipped);

    if (!choice.target || choice.index === undefined) {
      return this.exhausted(chain);
    }
    return this.switchTo(
      chain,
      event.sessionID,
      choice.target,
      choice.index,
      operation,
    );
  }

  private async switchTo(
    chain: FallbackChain,
    sessionID: string,
    target: ModelTarget,
    index: number,
    operation: Operation,
  ): Promise<RetryDecision | undefined> {
    try {
      await this.options.runtime.switchModel(
        sessionID,
        toModelRef(target),
        operation.controller.signal,
      );
    } catch (error) {
      if (!operation.controller.signal.aborted) {
        this.warn(
          `fallback switch to ${formatTarget(target)} failed for session ${sessionID}: ${describeError(error)}`,
        );
      }
      return undefined;
    }

    // The switch may already be committed by the host. Do not update ownership
    // or publish a retry decision for an operation invalidated while it ran.
    if (!this.isCurrent(sessionID, operation)) return undefined;

    // The switch is not atomic with selection: the user may have chosen another
    // model while the RPC was in flight. Only claim the target if the child is
    // still on the exact intended provider, model, and variant.
    const current = await this.readSession(
      sessionID,
      operation.controller.signal,
    );
    if (!this.isCurrent(sessionID, operation)) return undefined;

    const intended = toModelRef(target);
    if (!current?.model || !sameSelection(current.model, intended)) {
      this.warn(
        `fallback switch to ${formatTarget(target)} was superseded for session ${sessionID}; leaving retry policy unchanged`,
      );
      return undefined;
    }

    chain.current = target;
    chain.cursor = index + 1;

    return { retry: true, delay: 0 };
  }

  private beginOperation(sessionID: string): Operation | undefined {
    if (this.operations.size >= MAX_OPERATIONS) {
      this.warn(
        `dropping a routing operation for session ${sessionID}: too many operations are in flight`,
      );
      return undefined;
    }

    const operation: Operation = { controller: new AbortController() };
    this.operations.set(sessionID, operation);
    return operation;
  }

  private finishOperation(sessionID: string, operation: Operation): void {
    if (this.operations.get(sessionID) !== operation) return;

    this.operations.delete(sessionID);

    // A chain that never took over owns nothing. Recreate it on the next
    // attempt instead of retaining state for every rate-limited child.
    const chain = this.chains.get(sessionID);
    if (chain && !chain.current) this.chains.delete(sessionID);
  }

  private invalidateOperation(sessionID: string): void {
    const operation = this.operations.get(sessionID);
    if (!operation) return;

    this.operations.delete(sessionID);
    const chain = this.chains.get(sessionID);
    if (chain && !chain.current) this.chains.delete(sessionID);
    operation.controller.abort();
  }

  private isCurrent(sessionID: string, operation: Operation): boolean {
    return (
      this.operations.get(sessionID) === operation &&
      !operation.controller.signal.aborted
    );
  }

  private chainFor(
    sessionID: string,
    selected: RuntimeModelRef,
  ): FallbackChain | undefined {
    const existing = this.chains.get(sessionID);
    if (existing && chainOwns(existing, selected)) return existing;
    if (existing) this.discardChain(sessionID, "the selected model changed");

    const targets = this.options.config.targetsBySource.get(sourceKey(selected));
    if (!targets) return undefined;
    if (this.chains.size >= MAX_CHAINS) {
      this.warn(
        `not starting a fallback chain for session ${sessionID}: routing state is full`,
      );
      return undefined;
    }

    const chain = createChain(
      { providerID: selected.providerID, id: selected.id },
      targets,
    );
    this.chains.set(sessionID, chain);
    return chain;
  }

  private exhausted(chain: FallbackChain): RetryDecision | undefined {
    // Without a successful takeover this plugin owns nothing to stop.
    if (!chain.current) return undefined;

    if (!chain.exhausted) {
      chain.exhausted = true;
      this.warn(
        `fallback chain ${chainLabel(chain)} is exhausted; leaving the child error to OpenCode`,
      );
    }

    return { retry: false };
  }

  private reportSkips(
    chain: FallbackChain,
    skipped: readonly CandidateSkip[],
  ): void {
    for (const { target, reason } of skipped) {
      const key = `${targetKey(target)}:${reason}`;
      if (chain.reported.has(key)) continue;

      chain.reported.add(key);
      this.warn(
        `skipping fallback target ${formatTarget(target)} for ${chainLabel(chain)}: ${describeSkip(reason)}`,
      );
    }
  }

  private async readSession(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<FallbackSessionInfo | undefined> {
    try {
      return await this.options.runtime.getSession(sessionID, signal);
    } catch (error) {
      if (!signal.aborted) {
        this.warn(
          `could not read session ${sessionID}; leaving retry policy unchanged: ${describeError(error)}`,
        );
      }
      return undefined;
    }
  }

  private async readInventory(
    signal: AbortSignal,
  ): Promise<readonly InventoryModel[] | undefined> {
    try {
      return await this.options.runtime.listModels(signal);
    } catch (error) {
      if (!signal.aborted) {
        this.warn(
          `could not read the model inventory; leaving retry policy unchanged: ${describeError(error)}`,
        );
      }
      return undefined;
    }
  }

  private discardChain(sessionID: string, reason: string): void {
    if (!this.chains.delete(sessionID)) return;

    this.warn(`discarding fallback state for session ${sessionID}: ${reason}`);
  }

  private discardUnownedSelection(
    sessionID: string,
    selected: RuntimeModelRef | undefined,
  ): void {
    const chain = this.chains.get(sessionID);
    if (selected && chain && !chainOwns(chain, selected)) {
      this.discardChain(sessionID, "the selected model changed");
    }
  }

  private warn(message: string): void {
    this.options.warn(message);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}
