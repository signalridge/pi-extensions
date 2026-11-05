import { createHash } from "node:crypto";
import { types } from "node:util";

/** The native canonical identity, including its failures for non-JSON input. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type Leaf = string | number | boolean | null | undefined;
type Shape = Leaf | { array: boolean; prototype: object | null; keys: string[]; values: Shape[] };
interface RecordHash {
  key: WeakRef<object>;
  shape: Shape;
  hash: string;
  bytes: number;
  nodes: number;
}
export const FINGERPRINT_LIMITS = Object.freeze({ entries: 1024, bytes: 32 * 1024 * 1024, nodes: 32768 });
const ENTRY_NODES = 2048;
const DEPTH = 64;
const unsafe = Symbol("not plain bounded JSON");

// Native raw JSON has a serialization-affecting internal brand that an exact
// prototype/descriptor clone cannot reproduce. Older runtimes lack this API.
const isRawJSON = (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;
function nativeRawJSON(value: object): boolean {
  return typeof isRawJSON === "function" && isRawJSON(value);
}

// Some runtimes identify BigInt/Symbol wrappers by prototype rather than native
// slots. Feature-test once; intrinsic valueOf probes are callback-free and keep
// altered-prototype boxes out even on those runtimes. Reliable native checks
// retain the fast path without throwing for every ordinary JSON object.
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;
const probeBigInt = !types.isBoxedPrimitive(Object.setPrototypeOf(Object(0n), null));
const probeSymbol = !types.isBoxedPrimitive(Object.setPrototypeOf(Object(Symbol()), null));
function boxed(value: object): boolean {
  if (types.isBoxedPrimitive(value)) return true;
  if (probeBigInt) {
    try {
      Reflect.apply(bigintValueOf, value, []);
      return true;
    } catch {
      // Ordinary objects have no [[BigIntData]] slot.
    }
  }
  if (probeSymbol) {
    try {
      Reflect.apply(symbolValueOf, value, []);
      return true;
    } catch {
      // Ordinary objects have no [[SymbolData]] slot.
    }
  }
  return false;
}

/** Descriptors never invoke user getters. Reject proxies BEFORE reflective operations.
 * Dense arrays and plain objects only: no toJSON, exotic prototypes, symbols,
 * accessors, hidden properties, holes, cycles or unbounded metadata. Strings are
 * immutable value references, not serialized/copied bodies or native entry owners.
 */
function shape(value: unknown, budget: { bytes: number; nodes: number }, path: Set<object>, depth = 0): Shape {
  if (++budget.nodes > ENTRY_NODES || depth > DEPTH) throw unsafe;
  budget.bytes += 64;
  // Native tool records may have optional own data properties set to undefined.
  // Compare those too; the original serializer still decides omission/array null.
  // A root undefined never reaches this path and retains fingerprint's failure.
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    budget.bytes += value.length * 2;
    if (budget.bytes > FINGERPRINT_LIMITS.bytes) throw unsafe;
    return value;
  }
  // Native raw-JSON/boxed-primitive slots affect JSON independently of keys
  // and prototype. Reject proxies first; public native brand checks neither
  // coerce values nor invoke user callbacks.
  if (typeof value !== "object" || types.isProxy(value) || nativeRawJSON(value) || boxed(value) || path.has(value))
    throw unsafe;
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (
    (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) ||
    Object.getPrototypeOf(Object.prototype) !== null ||
    Object.getPrototypeOf(Array.prototype) !== Object.prototype ||
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON")
  )
    throw unsafe;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > ENTRY_NODES - budget.nodes) throw unsafe;
  // Internal slots must not trigger inherited numeric setters while recording
  // a shape (sparse/exotic input itself still takes the canonical fallback).
  const keys: string[] = Object.setPrototypeOf([], null);
  const values: Shape[] = Object.setPrototypeOf([], null);
  path.add(value);
  for (const key of ownKeys) {
    if (typeof key !== "string" || key === "toJSON") throw unsafe;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw unsafe;
    if (array && key === "length") {
      if (descriptor.value !== keys.length) throw unsafe; // Native key order puts length after the indices.
      continue;
    }
    if (!descriptor.enumerable || (array && key !== String(keys.length))) throw unsafe;
    budget.bytes += key.length * 2;
    if (budget.bytes > FINGERPRINT_LIMITS.bytes) throw unsafe;
    keys[keys.length] = key;
    values[values.length] = shape(descriptor.value, budget, path, depth + 1);
  }
  path.delete(value);
  return { array, prototype, keys, values };
}

function matches(value: unknown, saved: Shape): boolean {
  if (saved === null || typeof saved !== "object") return Object.is(value, saved);
  if (value === null || typeof value !== "object" || types.isProxy(value) || nativeRawJSON(value) || boxed(value))
    return false;
  const array = Array.isArray(value);
  if (
    array !== saved.array ||
    Object.getPrototypeOf(value) !== saved.prototype ||
    Object.getPrototypeOf(Object.prototype) !== null ||
    Object.getPrototypeOf(Array.prototype) !== Object.prototype ||
    Object.getOwnPropertyDescriptor(Object.prototype, "toJSON") ||
    Object.getOwnPropertyDescriptor(Array.prototype, "toJSON")
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== saved.keys.length + (array ? 1 : 0)) return false;
  for (let i = 0; i < saved.keys.length; i++) {
    if (keys[i] !== saved.keys[i]) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[i]);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !matches(descriptor.value, saved.values[i]))
      return false;
  }
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (keys[keys.length - 1] !== "length" || !length || length.value !== saved.keys.length) return false;
  }
  return true;
}

/** Bounded, value-validated acceleration, NEVER an authority or durability cache.
 * Every hit walks every key (in order), index and leaf value. Weak keys do not
 * retain native history; bounded admission holds only structural value snapshots.
 * Eviction/unsafe values fall back to the original canonical hash, not a proof.
 */
export class Fingerprints {
  private lookup = new WeakMap<object, RecordHash>();
  private readonly records = new Set<RecordHash>();
  private bytes = 0;
  private nodes = 0;
  get usage(): Readonly<{ entries: number; bytes: number; nodes: number }> {
    return { entries: this.records.size, bytes: this.bytes, nodes: this.nodes };
  }
  clear() {
    this.lookup = new WeakMap();
    this.records.clear();
    this.bytes = 0;
    this.nodes = 0;
  }
  /** Only already-cached, freshly value-validated plain data may be reused by
   * a disk scan. A miss never serializes arbitrary abandoned native objects. */
  known(value: unknown): string | undefined {
    if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
    const record = this.lookup.get(value);
    return record && this.records.has(record) && matches(value, record.shape) ? record.hash : undefined;
  }
  hash = (value: unknown): string => {
    if (value === null || typeof value !== "object" || types.isProxy(value)) return fingerprint(value);
    const prior = this.lookup.get(value);
    if (prior && this.records.has(prior)) {
      if (matches(value, prior.shape)) return prior.hash;
      this.remove(prior);
    }
    // Do not churn the whole cache on each history traversal once full. Unknown
    // values still receive the canonical hash; mutation/retirement frees slots.
    if (this.records.size >= FINGERPRINT_LIMITS.entries || this.nodes >= FINGERPRINT_LIMITS.nodes)
      return fingerprint(value);
    const budget = { bytes: 128, nodes: 0 };
    let saved: Shape;
    try {
      saved = shape(value, budget, new Set());
    } catch {
      // Do not probe unsafe objects again or execute any extra user getter.
      return fingerprint(value);
    }
    const hash = fingerprint(value);
    // The safe traversal and canonical serializer cannot call user code. Thus
    // the captured values and hash describe the same synchronous observation.
    if (this.bytes + budget.bytes > FINGERPRINT_LIMITS.bytes || this.nodes + budget.nodes > FINGERPRINT_LIMITS.nodes)
      return hash;
    const record = { key: new WeakRef(value), shape: saved, hash, ...budget };
    this.records.add(record);
    this.lookup.set(value, record);
    this.bytes += budget.bytes;
    this.nodes += budget.nodes;
    return hash;
  };
  private remove(record: RecordHash) {
    const key = record.key.deref();
    if (key) this.lookup.delete(key);
    this.records.delete(record);
    this.bytes -= record.bytes;
    this.nodes -= record.nodes;
  }
}
