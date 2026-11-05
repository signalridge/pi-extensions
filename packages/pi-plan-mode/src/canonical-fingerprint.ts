import { createHash } from "node:crypto";
import { types } from "node:util";

/** The wire identity is deliberately unchanged, including failures/undefined. */
export function canonicalContentKey(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
}

/** State origins originally reject an undefined serialization instead. */
export function canonicalEntryKey(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) as string)
    .digest("hex");
}

type Scalar = string | number | boolean | null | undefined;
type Snapshot =
  | Scalar
  | {
      prototype: object | null;
      array: boolean;
      unboxed: WeakRef<object>;
      keys: string[];
      enumerable: Record<number, boolean>;
      values: Record<number, Snapshot>;
    };
interface Slot {
  root: WeakRef<object>;
  proof?: { snapshot: Snapshot; hash: string };
  bytes: number;
  nodes: number;
}
interface Limits {
  entries: number;
  bytes: number;
  nodes: number;
  depth: number;
}
const DEFAULT_LIMITS: Limits = { entries: 4096, bytes: 32 * 1024 * 1024, nodes: 131072, depth: 64 };
const unsafe = Symbol("uncacheable JSON");
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const bigintValueOf = BigInt.prototype.valueOf;
const symbolValueOf = Symbol.prototype.valueOf;
// Older runtimes/TypeScript libs may not expose this public native-brand API.
const isRawJSON = (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

function hasNativeSlot(value: object, unbox: () => unknown): boolean {
  try {
    Reflect.apply(unbox, value, []);
    return true;
  } catch {
    return false;
  }
}

// No property reads on raw objects: descriptors avoid executing extra getters.
// Proxies and native JSON/boxed slots must be excluded before reflection.
// Their stringify behavior can differ despite identical prototypes/descriptors.
function shape(value: object, provenUnboxed = false) {
  if (types.isProxy(value)) throw unsafe;
  // Never fold RawJSON into the weak unboxed shortcut: replacement children
  // must pass this classification before either snapshot capture or matching.
  if ((typeof isRawJSON === "function" && isRawJSON(value)) || types.isBoxedPrimitive(value)) throw unsafe;
  // Bun 1.3.14's util.types misses altered-prototype BigInt/Symbol boxes.
  // Intrinsic valueOf probes inspect native slots without raw property reads.
  // Only this immutable brand fact may reuse identity, NEVER a hash/shape.
  if (!provenUnboxed && (hasNativeSlot(value, bigintValueOf) || hasNativeSlot(value, symbolValueOf))) throw unsafe;
  const prototype: object | null = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== arrayPrototype : prototype !== objectPrototype && prototype !== null) throw unsafe;
  if (
    Object.getPrototypeOf(objectPrototype) !== null ||
    Object.getOwnPropertyDescriptor(objectPrototype, "toJSON") ||
    (array &&
      (Object.getPrototypeOf(arrayPrototype) !== objectPrototype ||
        Object.getOwnPropertyDescriptor(arrayPrototype, "toJSON")))
  )
    throw unsafe;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || key === "toJSON")) throw unsafe;
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    // Dense own indices only. Holes can observe inherited getters in stringify.
    if (!length || !Object.hasOwn(length, "value") || keys.length !== length.value + 1) throw unsafe;
    for (let index = 0; index < keys.length - 1; index++) if (keys[index] !== String(index)) throw unsafe;
    if (keys.at(-1) !== "length") throw unsafe;
  }
  return { prototype, array, keys: keys as string[] };
}

/** Bounded memo of canonical hashes, NOT an identity-based authority cache.
 * Every hit proves the complete raw own-data tree again (including order,
 * enumerability and array length). Immutable strings compare by value without
 * serializing/hashing their unchanged bytes. Unsafe values use the old path.
 * Snapshots strongly retain scalar/key data and metadata, never raw child
 * graphs or serialized bodies. Weak root/brand references allow abandoned
 * raw objects to be collected independently.
 */
export class CanonicalFingerprints {
  private lookup = new WeakMap<object, Slot>();
  private lru = new Set<Slot>();
  private bytes = 0;
  private nodes = 0;
  private unsafeReads = 0;
  // At capacity, one admission per run of misses, rearmed by a proven hit.
  // A sequential branch scan larger than the memo must not evict every entry
  // just before its next read (classic LRU scan thrashing).
  private admitOnPressure = true;
  private limits: Limits;

  constructor(
    limits: Partial<Limits> = {},
    private hash: (value: unknown) => string = canonicalContentKey,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get retention() {
    // A conservative accounting bound, not an engine-specific heap estimate:
    // UTF-16 payloads/keys plus charged node/slot/edge metadata (duplicates count).
    return { entries: this.lru.size, bytes: this.bytes, nodes: this.nodes };
  }
  get fallbacks() {
    return this.unsafeReads;
  }

  key(value: unknown, fallback = this.hash): string {
    if (value === null || typeof value !== "object") {
      this.unsafeReads++;
      return fallback(value);
    }
    const previous = this.lookup.get(value);
    if (previous) {
      // A bounded negative hint may skip inspection, NEVER canonical hashing.
      // It remains safe if the raw object later becomes cacheable again.
      if (!previous.proof) {
        this.unsafeReads++;
        return fallback(value);
      }
      try {
        if (this.matches(value, previous.proof.snapshot)) {
          this.lru.delete(previous);
          this.lru.add(previous);
          this.admitOnPressure = true;
          return previous.proof.hash;
        }
      } catch {
        // Inspection never invokes raw callbacks; original stringify owns them.
      }
      this.remove(previous);
    }
    if (this.lru.size >= this.limits.entries && !this.admitOnPressure) {
      this.unsafeReads++;
      return fallback(value);
    }
    const budget = { bytes: 256, nodes: 0 };
    let snapshot: Snapshot;
    try {
      snapshot = this.snapshot(value, budget, new WeakSet(), 0);
      if (this.limits.entries < 1) throw unsafe;
    } catch {
      this.remember(value, undefined, { bytes: 256, nodes: 0 });
      this.unsafeReads++;
      return fallback(value);
    }
    // Safe own-data trees cannot run user code between snapshot and hashing.
    const hash = this.hash(value);
    this.remember(value, { snapshot, hash }, budget);
    return hash;
  }

  private remember(value: object, proof: Slot["proof"], budget: { bytes: number; nodes: number }) {
    if (this.limits.entries < 1 || budget.bytes > this.limits.bytes || budget.nodes > this.limits.nodes) return;
    const pressure =
      this.lru.size >= this.limits.entries ||
      this.bytes + budget.bytes > this.limits.bytes ||
      this.nodes + budget.nodes > this.limits.nodes;
    if (pressure && !this.admitOnPressure) return;
    if (pressure) this.admitOnPressure = false;
    while (
      this.lru.size >= this.limits.entries ||
      this.bytes + budget.bytes > this.limits.bytes ||
      this.nodes + budget.nodes > this.limits.nodes
    ) {
      const oldest = this.lru.values().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
    const slot = { root: new WeakRef(value), proof, ...budget };
    this.lookup.set(value, slot);
    this.lru.add(slot);
    this.bytes += slot.bytes;
    this.nodes += slot.nodes;
  }

  clear() {
    this.lookup = new WeakMap();
    this.lru.clear();
    this.bytes = 0;
    this.nodes = 0;
    this.admitOnPressure = true;
  }

  private remove(slot: Slot) {
    const root = slot.root.deref();
    if (root) this.lookup.delete(root);
    this.lru.delete(slot);
    this.bytes -= slot.bytes;
    this.nodes -= slot.nodes;
  }

  private snapshot(
    value: unknown,
    budget: { bytes: number; nodes: number },
    path: WeakSet<object>,
    depth: number,
  ): Snapshot {
    budget.nodes++;
    budget.bytes += 64 + (typeof value === "string" ? value.length * 2 : 0);
    if (depth > this.limits.depth || budget.nodes > this.limits.nodes || budget.bytes > this.limits.bytes) throw unsafe;
    if (value === null || ["undefined", "string", "number", "boolean"].includes(typeof value)) return value as Scalar;
    if (typeof value !== "object" || path.has(value)) throw unsafe;
    const { prototype, array, keys } = shape(value);
    budget.bytes += 64 + keys.reduce((bytes, key) => bytes + key.length * 2 + 32, 0); // includes weak brand reference
    if (budget.bytes > this.limits.bytes) throw unsafe;
    path.add(value);
    // No inherited numeric setters/getters may run between descriptor reads
    // and canonical hashing. Reflect.ownKeys creates dense own indices; our
    // growing metadata uses null-prototype records, never ordinary [].push.
    const enumerable: Record<number, boolean> = Object.create(null);
    const values: Record<number, Snapshot> = Object.create(null);
    for (let index = 0; index < keys.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw unsafe;
      enumerable[index] = Boolean(descriptor.enumerable);
      values[index] = this.snapshot(descriptor.value, budget, path, depth + 1);
    }
    path.delete(value);
    return { prototype, array, unboxed: new WeakRef(value), keys, enumerable, values };
  }

  private matches(value: unknown, snapshot: Snapshot): boolean {
    if (snapshot === null || typeof snapshot !== "object") return Object.is(value, snapshot);
    if (value === null || typeof value !== "object") return false;
    const provenUnboxed = snapshot.unboxed.deref() === value;
    const { prototype, array, keys } = shape(value, provenUnboxed);
    if (prototype !== snapshot.prototype || array !== snapshot.array || keys.length !== snapshot.keys.length)
      return false;
    for (let index = 0; index < keys.length; index++) {
      if (keys[index] !== snapshot.keys[index]) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        Boolean(descriptor.enumerable) !== snapshot.enumerable[index] ||
        !this.matches(descriptor.value, snapshot.values[index])
      )
        return false;
    }
    // Structurally equal replacements may reuse the native-brand proof next
    // time. Weak references do not keep raw child graphs alive after eviction.
    if (!provenUnboxed) snapshot.unboxed = new WeakRef(value);
    return true;
  }
}
