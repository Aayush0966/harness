const HASHTAGS = {
  object: 0,
  array: 1,
  number: 2,
  bigint: 3,
  true: 4,
  false: 5,
  string: 6,
  null: 7,
  undefined: 8,
  symbol: 9,
  objectLiteral: 10,
  property: 11,
  function: 12,
  NaN: 13,
};

function hashString(str, hash = 0x811c9dc5) {
  for (let i = 0; i < str.length; i++)
    hash = Math.imul(hash ^ str.charCodeAt(i), 0x01000193);
  return hash;
}

let i = 0;
const StaticSymbols = new Map(), DynamicSymbols = new WeakMap();
function hashSymbol(s, hash = 0x811c9dc5) {
  let v = StaticSymbols.get(s) ?? DynamicSymbols.get(s);
  if (!v)
    Symbol.keyFor(s) !== undefined ? StaticSymbols.set(s, v = ++i) : DynamicSymbols.set(s, v = ++i);
  return Math.imul(hash ^ v, 0x01000193);
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
function hashNumber(v, hash = 0x811c9dc5) {
  if (Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF && !Object.is(v, -0))
    return Math.imul(hash ^ v, 0x01000193);
  f64[0] = v;
  hash = Math.imul(hash ^ u32[0], 0x01000193);
  return Math.imul(hash ^ u32[1], 0x01000193);
}

function hashPrimitive(v, hash = 0x811c9dc5) {
  if (v === null) return Math.imul(hash ^ HASHTAGS.null, 0x01000193);
  if (v === undefined) return Math.imul(hash ^ HASHTAGS.undefined, 0x01000193);
  if (v === true) return Math.imul(hash ^ HASHTAGS.true, 0x01000193);
  if (v === false) return Math.imul(hash ^ HASHTAGS.false, 0x01000193);
  if (Object.is(v, NaN)) return Math.imul(hash ^ HASHTAGS.NaN, 0x01000193);

  const t = typeof v;
  if (!(t in HASHTAGS)) throw new TypeError("Unsupported type for hashing: " + t + " with value: " + v);
  hash = Math.imul(hash ^ HASHTAGS[t], 0x01000193);
  if (t === 'string') return hashString(v, hash);
  if (t === 'bigint') return hashString(v.toString(), hash);
  if (t === 'number') return hashNumber(v, hash);
  if (t === 'symbol') return hashSymbol(v, hash);
}
function hashPropertyKey(key, hash = 0x811c9dc5) {
  hash = Math.imul(hash ^ HASHTAGS.property, 0x01000193);
  return typeof key === 'string' ? hashString(key, hash) : hashSymbol(key, hash);
}

class WeakHashMap {
  constructor() {
    this.simpleHashToObj = new Map();
    this.objToHash = new WeakMap();
    this.multiHashToObjArray = new Map();
    this.finale = new FinalizationRegistry(hash => this.delete(hash));
  }
  #sameSame(a, b) {
    if (Object.is(a, b))
      return true;
    const ak = Reflect.ownKeys(a);
    const bk = Reflect.ownKeys(b);
    if (ak.length !== bk.length)
      return false;
    for (let i = 0; i < ak.length; i++)
      if (ak[i] !== bk[i] || !Object.is(a[ak[i]], b[bk[i]]))//identical props inside Composite objects must be the same objects.
        return false;
    return Array.isArray(a) !== Array.isArray(b) ? false : true;
  }
  add(hash, obj) {
    const old = this.simpleHashToObj.get(hash)?.deref();
    if (!old) {
      this.simpleHashToObj.set(hash, new WeakRef(obj));
      this.objToHash.set(obj, hash);
      this.finale.register(obj, hash);
      return obj;
    }
    if (this.#sameSame(old, obj))
      return old;
    let ar = this.multiHashToObjArray.get(hash);
    if (!ar) this.multiHashToObjArray.set(hash, ar = []);
    for (let i = 0, o; i < ar.length; i++)
      if (this.#sameSame(o = ar[i].deref(), obj))
        return o;
    ar.push(new WeakRef(obj));
    this.objToHash.set(obj, hash);
    this.finale.register(obj, hash);
    return obj;
  }
  getHash(obj) {
    return this.objToHash.get(obj);
  }
  getObj(hash) {
    const single = this.simpleHashToObj.get(hash)?.deref();
    if (!this.multiHashToObjArray.has(hash))
      return [single];
    return [single, ...this.multiHashToObjArray.get(hash).map(wr => wr.deref()).filter(Boolean)];
  }
  delete(hash) {
    const single = this.simpleHashToObj.get(hash)?.deref();
    if (!single)
      this.simpleHashToObj.delete(hash);
    const ar = this.multiHashToObjArray.get(hash);
    if (!ar) return;
    const ar2 = ar.filter(wr => wr.deref());
    if (!this.simpleHashToObj.has(hash) && ar2.length)
      this.simpleHashToObj.set(hash, ar2.shift());
    if (!ar2.length)
      this.multiHashToObjArray.delete(hash);
    else
      this.multiHashToObjArray.set(hash, ar2);
  }
}

const HASHCACHE = new WeakHashMap();
/**
 * @param {*} obj plain data objects, arrays, primitives or symbols; accessors and proxies are unsupported. 
 * @param {boolean} consume if true, the input objects will be mutated and frozen in place if possible. If false, new objects will be created and frozen.
 *        Typically used as a wrapper around JSON object: Composite(JSON.parse(...), true).
 *        Fails with already frozen, but not composite objects.
 *        If the function errors half way through, the input object may be partially mutated and frozen. 
 *        Use with caution.
 * @returns a deeply immutable version of the input object with a consistent hash.
 */
 function Composite(obj, consume = false) {
  return CompositeImpl(obj, consume);
}

function CompositeImpl(obj, consume = false, seen = new Set()) {
  if (Composite.is(obj)) return obj;
  const proto = Object.getPrototypeOf(obj);
  const isArray = proto === Array.prototype;
  if (!isArray && proto !== Object.prototype && proto !== null)
    throw new TypeError(`Composite: all objects must be {}, [], or Object.create(null), not: ${proto?.constructor?.name ?? "(unknown)"}`);
  const target = consume ? obj : (isArray ? [] : Object.create(proto));
  let hash = Math.imul(0x811c9dc5 ^ isArray, 0x01000193); //isArray is 1 for array, 0 for object

  seen.add(obj);
  for (let k of Reflect.ownKeys(obj)) {
    if (k === '__proto__')
      throw new TypeError(`Composite: Access to __proto__ is not allowed.`);
    const o = obj[k];
    if (seen.has(o))
      throw new TypeError(`Composite: Circular reference detected under key: ${String(k)}.`);
    const v = CompositeImpl(o, consume, seen);
    hash = hashPropertyKey(k, hash);
    hash = (v && typeof v === 'object') ? Math.imul(hash ^ HASHCACHE.getHash(v), 0x01000193) : hashPrimitive(v, hash);
    if (consume && Object.is(v, target[k]))
      continue;
    if (consume && Object.isFrozen(target))
      throw new TypeError("Composite.consume: cannot consume an already frozen object that requires internal updates.");
    target[k] = v;
  }
  seen.delete(obj);
  const result = HASHCACHE.add(hash, target);
  if (result === target) Object.freeze(target);
  return result;
}

Composite.is = function is(v) {
  return v == null || typeof v === 'string' ||
    typeof v === 'number' || typeof v === 'boolean' ||
    typeof v === 'symbol' ||
    typeof v === 'bigint' || HASHCACHE.getHash(v) !== undefined;
}

function getImpl(obj, path, end = path.length) {
  for (let i = 0; obj != null && i < end; i++)
    obj = obj[path[i]];
  return obj;
}

function replaceObjectInsideCompositable(obj, nextKey, reuseNonFrozen) {
  if (obj && typeof obj === "object") {
    if (reuseNonFrozen && !Object.isFrozen(obj))
      return obj;
    const proto = Object.getPrototypeOf(obj);
    const isArray = proto === Array.prototype;
    const res = isArray ? Array(obj.length) : Object.create(proto);
    for (const key of Reflect.ownKeys(obj))
      res[key] = obj[key];
    return res;
  }
  const t = typeof nextKey;
  if (t !== 'string' && t !== 'number')
    return {};
  const n = Number(nextKey);
  if (Number.isInteger(n) && n >= 0 && n < 0xFFFFFFFF && String(nextKey) === String(n))
    return [];
  return {};
}
function setImpl(obj, path, value, consume) {
  let root = obj = replaceObjectInsideCompositable(obj, path[0], consume);
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (key === "__proto__") throw new TypeError("Composite: Access to __proto__ is not allowed.");
    obj = obj[key] = replaceObjectInsideCompositable(obj[key], path[i + 1], consume);
  }
  if (path[path.length - 1] === "__proto__") throw new TypeError("Composite: Access to __proto__ is not allowed.");
  obj[path[path.length - 1]] = value;
  return root;
}

Composite.rawSet = function set(root, path, value, consumeValue = false) {
  if (!Composite.is(root)) throw new TypeError("Composite: Root must be a composite.");
  if (!Array.isArray(path) || path.length < 1 || path.some(k => String(k) === "__proto__")) throw new TypeError("Composite: Path must be a non-empty array.");
  return Composite(setImpl(root, path, Composite(value, consumeValue), true));
};

Composite.rawDelete = function rawDelete(root, path) {
  if (!Composite.is(root)) throw new TypeError("Composite: Root must be a composite.");
  if (!Array.isArray(path) || path.length < 1 || path.some(k => String(k) === "__proto__")) throw new TypeError("Composite: Path must be a non-empty array.");
  const parent = path.length > 1 ? getImpl(root, path, path.length - 1) : root;
  const key = path[path.length - 1];
  if (parent == null || typeof parent !== "object" || !Object.hasOwn(parent, key))
    return root;
  const clone = replaceObjectInsideCompositable(parent, "ignore", false);
  delete clone[key];
  if (path.length === 1)
    return Composite(clone, true);
  return Composite.rawSet(root, path.slice(0, -1), clone, true);
};

const Lense = (FN, skip) => function (root, consumeValue = false) {
  if (!Composite.is(root)) throw new TypeError("Composite: Root must be a composite in Composite.operations.");
  let spent = false;
  function proxy(path = []) {
    return new Proxy(() => { }, {
      get(_, key) {
        if (spent) throw new Error("Proxy already consumed");
        return proxy([...path, key]);
      },
      apply(_, __, args) {
        if (spent) throw new Error("Proxy already consumed");
        spent = true;
        if (skip)
          return FN(root, path, args);
        return Composite.rawSet(root, path, FN(root, path, args), consumeValue);
      }
    });
  }
  return proxy();
}

Composite.set = Lense((root, path, args) => {
  if (args.length !== 1) throw new TypeError("Composite.set: Only one argument is allowed.");
  return args[0]
});
Composite.delete = Lense((root, path, args) => {
  if (args.length !== 0) throw new TypeError("Composite.delete: No arguments are allowed.");
  return Composite.rawDelete(root, path);
}, true);
Composite.transform = Lense((root, path, args) => {
  if (args.length !== 1) throw new TypeError("Composite.transform: Only one argument is allowed.");
  return args[0](getImpl(root, path));
});
const PureArrayFns = ["map", "reduce", "flatMap", "filter", "reduceRight"];
for (const name of PureArrayFns) {
  Composite[name] = Lense((root, path, args) => {
    const arr = getImpl(root, path);
    if (!Array.isArray(arr)) throw new TypeError("Composite: Target must be an array in Composite.operations.");
    return Array.prototype[name].call(arr, ...args);
  });
}
const DirtyArrayFns = ["sort", "reverse", "fill", "copyWithin", "push", "pop", "shift", "unshift", "splice"];
for (const name of DirtyArrayFns) {
  Composite[name] = Lense((root, path, args) => {
    const arr = getImpl(root, path);
    if (!Array.isArray(arr)) throw new TypeError("Composite: Target must be an array in Composite.operations.");
    const copy = replaceObjectInsideCompositable(arr, "ignore", false);
    Array.prototype[name].call(copy, ...args);
    return copy;
  });
}