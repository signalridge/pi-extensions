/**
 * shared-store.ts — in-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: the runtime captures `store.commitDelta(deltaKey)`
 * alongside each agent result in the journal. On resume,
 * `store.applyDelta(delta)` rebuilds the store state additively in callSeq
 * order, so parallel-agent writes are replayed correctly without the
 * last-complete-wins ordering bug that a whole-Map restore() would cause.
 *
 * `deltaKey` must be unique across every run that shares this store instance,
 * not just within one run's callSeq. A nested `workflow()` call restarts its
 * own callSeq at 0 while inheriting the parent's store, so a bare callIndex
 * would collide. Callers compose `deltaKey` as `${runId}:${callIndex}`.
 */

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  // Per-agent write deltas; keyed by a run-unique `${runId}:${callIndex}` string.
  private readonly agentDeltas = new Map<string, Record<string, unknown>>();
  // Pre-write shadow values for the CURRENT delta-key's in-progress writes, so a
  // failed retry attempt's mutations can be rolled back (see `discardDelta`)
  // instead of leaking into the live store or a later successful attempt's
  // recorded delta. Populated lazily on first write to a given key within the
  // current delta window; cleared whenever the delta is finalized either way.
  private readonly priorValues = new Map<string, Map<string, { existed: boolean; value: unknown }>>();

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    this.map.set(key, value);
  }

  /** Store a value and record the write in the per-agent delta for `deltaKey`. */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    let priors = this.priorValues.get(deltaKey);
    if (!priors) {
      priors = new Map();
      this.priorValues.set(deltaKey, priors);
    }
    // Only shadow the value from BEFORE this delta window started writing to
    // this key — a second write within the same attempt must not overwrite the
    // shadow with its own (already-in-window) value.
    if (!priors.has(key)) {
      priors.set(
        key,
        this.map.has(key) ? { existed: true, value: this.map.get(key) } : { existed: false, value: undefined },
      );
    }
    this.map.set(key, value);
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = {};
      this.agentDeltas.set(deltaKey, delta);
    }
    delta[key] = value;
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    return this.map.get(key);
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Return a deep-copied plain-object snapshot of all entries. */
  snapshot(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.map));
  }

  /**
   * Extract and clear the write delta accumulated for `deltaKey`.
   * Called after an agent completes to get the set of keys it wrote.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    const delta = this.agentDeltas.get(deltaKey) ?? {};
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
    return delta;
  }

  /**
   * Undo the writes recorded for `deltaKey` and discard its bookkeeping,
   * without touching any other key. Used when a retry attempt fails: that
   * attempt's writes must not remain visible in the live store nor merge into
   * the delta eventually recorded by a later successful attempt of the SAME
   * call. Per-key guard: a key is only rolled back if the store STILL holds
   * this attempt's own last write to it (`Object.is`); a concurrent sibling's
   * overwrite is left untouched.
   */
  discardDelta(deltaKey: string): void {
    const delta = this.agentDeltas.get(deltaKey);
    if (!delta) return;
    const priors = this.priorValues.get(deltaKey);
    for (const key of Object.keys(delta)) {
      if (!Object.is(this.map.get(key), delta[key])) continue;
      const prior = priors?.get(key);
      if (prior?.existed) this.map.set(key, prior.value);
      else this.map.delete(key);
    }
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
  }

  /** Apply a write delta additively — sets each key without clearing others. */
  applyDelta(delta: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(delta)) {
      this.map.set(k, v);
    }
  }

  /** Replace all entries with a snapshot (full reset). */
  restore(snap: Record<string, unknown>): void {
    this.map.clear();
    for (const [k, v] of Object.entries(snap)) {
      this.map.set(k, v);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.map.clear();
    this.agentDeltas.clear();
    this.priorValues.clear();
  }
}
