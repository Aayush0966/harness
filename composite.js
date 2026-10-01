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
 * @returns a deeply immutable version of the input object with a consistent hash.
 */
function Composite(obj) {
  return CompositeImpl(obj);
}

/**
 * Typically used as a wrapper around JSON object: Composite.consume(JSON.parse(...)).
 * Runs in overwrite/mutate mode. Reuse, mutates and freezes all objects to avoid creating new objects.
 * Fails with already frozen, but not composite objects.
 * If the function errors half way through, the input object may be partially mutated and frozen. 
 * Use with caution.
 * @param {*} obj plain data objects, arrays, primitives or symbols; accessors and proxies are unsupported. 
 * @returns a deeply immutable version of the input object with a consistent hash.
 */
Composite.consume = function consume(obj) {
  return CompositeImpl(obj, true);
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

function replaceObjectInsideCompositable(obj, key, reuseNonFrozen) {
  if (obj && typeof obj === "object") {
    if (reuseNonFrozen && !Object.isFrozen(obj))
      return obj;
    const proto = Object.getPrototypeOf(obj);
    const isArray = proto === Array.prototype;
    return Object.assign(isArray ? Array(obj.length) : Object.create(proto), obj);
  }
  const t = typeof key;
  if (t !== 'string' && t !== 'number')
    return {};
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && n < 0xFFFFFFFF && key === String(n))
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

Composite.set = function set(root, path, value) {
  if (!Composite.is(root)) throw new TypeError("Composite.set: Root must be a composite.");
  if (!Array.isArray(path) || path.length < 1) throw new TypeError("Composite.set: Path must be a non-empty array.");
  return Composite.consume(setImpl(root, path, Composite(value), false));
};

function getImpl(obj, path) {
  for (let i = 0; obj != null && i < path.length; i++)
    obj = obj[path[i]];
  return obj;
}
function deleteImpl(obj, path, consume) {
  let root = obj = replaceObjectInsideCompositable(obj, path[0], consume);
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (key === "__proto__") throw new TypeError("Composite: Access to __proto__ is not allowed.");
    obj = obj[key] = replaceObjectInsideCompositable(obj[key], path[i + 1], consume);
  }
  if (path[path.length - 1] === "__proto__") throw new TypeError("Composite: Access to __proto__ is not allowed.");
  delete obj[path[path.length - 1]];
  return root;
}

function placeTrace(skip = 0, SKIPS = []) {
  const stack = new Error().stack.split("\n").map(line => line.split("(")[0].trim().split(" ").pop());
  for (let i = skip + 1; i < stack.length - 1; i++) {
    const name = stack[i];
    if (!SKIPS.includes(name))
      return name;
  }
  return stack.at(-1);
}
const { register, unregister, getHistory, log } = (function () {

  const history = new Map();
  function log(oldObj, obj, path) {
    if (oldObj === obj) return;
    const tail = history.get(oldObj);
    if (!tail) return;
    const caller = placeTrace(2, ["rawSet", "rawDelete", "Object.apply", "Composite.rawSet", "Composite.rawDelete", "anonymous"]);
    tail.unshift({ obj, path, caller, time: performance.now() });
    history.set(obj, tail);
    history.delete(oldObj);
  }
  function register(obj) {
    if (history.has(obj)) throw new Error("an identical root already exists");
    history.set(obj, [{ obj, path: [], caller: placeTrace(2, ["register", "anonymous"]), time: performance.now() }]);
  }
  function unregister(now) {
    history.delete(now);
  }

  function getHistory(root) {
    return history.get(root).slice();
  }
  return { register, unregister, getHistory, log };
})();

const rawSetOg = setImpl;
const rawDeleteOg = deleteImpl;
let skipLog;

setImpl = function (root, path, value, consume) {
  const newRoot = rawSetOg(root, path, value, consume);
  !skipLog && log(root, newRoot, path);
  return newRoot;
};

deleteImpl = function (root, path, consume) {
  skipLog = true;
  const newRoot = rawDeleteOg(root, path, consume);
  skipLog = false;
  log(root, newRoot, path);
  return newRoot;
};

Object.assign(Composite, { register, unregister, getHistory });

const Lense = FN => function (root) {
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
        return Composite(FN(root, path, args));
      }
    });
  }
  return proxy();
}

const { map, reduce, flatMap } = Array.prototype;
Composite.set = Lense((root, path, [value]) => setImpl(root, path, value));
Composite.delete = Lense((root, path) => deleteImpl(root, path));
Composite.map = Lense((root, path, args) => setImpl(root, path, map.call(getImpl(root, path), ...args)));
Composite.flatMap = Lense((root, path, args) => setImpl(root, path, flatMap.call(getImpl(root, path), ...args)));
Composite.mapEntries = Lense((root, path, args) => setImpl(root, path, Object.fromEntries(map.call(Object.entries(getImpl(root, path)), ...args))));
// same as: args.length > 1 ? reduce.call(actual, args[0], args[1]) : reduce.call(actual, args[0]);
Composite.reduce = Lense((root, path, args) => setImpl(root, path, reduce.call(getImpl(root, path), ...args)));

// Composite.from = function from(root) {
//   if (!Composite.is(root)) throw new TypeError("Composite.from: Root must be a composite.");
//   const at = path => new Proxy(() => { }, {
//     get: (_, key) => at([...path, key]),
//     apply: (_, __, [value]) => (root = Composite.set(root, path, value)),
//   });
//   return at([]);
// }

// function resolvePath(obj, path, skips = 0) {
//   for (let i = 0, stop = path.length - skips; obj && i < stop; i++)
//     obj = obj[path[i]];
//   return typeof obj === 'object' ? obj : undefined;
// }

// const mutators = new Set(["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);

// function doApply(root, path, args) {
//   //draft() means to return the root object. cannot contain any arguments.
//   if (!path.length && args.length)
//     throw new TypeError("Composite.open: const $ = Composite.open(root); $.some.ops(value); $() will close the root. You cannot pass arguments to this call.");
//   if (!path.length)
//     return root;

//   const key = path.at(-1);
//   const method = Array.prototype.getOwnPropertyDescriptor(key);
//   if (method) {
//     let target1, target2;
//     target1 = target2 =  resolvePath(root, path, 1);
//     if (mutators.has(key) && Object.isFrozen(target1))
//       target2 = replaceObjectInsideCompositable(target1, 1, true);
//     let result;
//     if (method.value && typeof method.value === "function") {
//       result = method.value.apply(target1, args);
//     } else if (!args.length) {
//       result = method.get.apply(target1);
//     } else if (args.length === 1) {
//       result = method.set.apply(target1, args);
//     } else {
//       throw new TypeError("Composite.open: Two or more arguments is only allowed for Array.prototype methods. All other properties can be read with no arguments or set with one argument.");
//     }
//     if(target1 === target2)
//       return root;
//     return root = setImpl(root, path.slice(0,-1), target2, true);
//   }
// }

// Composite.open = function open(root) {
//   if (!Composite.is(root)) throw new TypeError("Composite.open: Root must be a composite.");

//   const at = path => new Proxy(() => { }, {
//     get: (_, key) => key === "then" ? undefined : at([...path, key]),  //i still don't understand why then is necessary here as we only work with composites?
//     apply: (_, __, args) => {
//       //if there is no path and args, then we are closing the root and returning it? This is the only way to get the root back?
//       //this is also the only allowed time to have empty arguments? Maybe, I am not sure.
//       //I think that this pattern is a little problematic.
//       if (!path.length)
//         throw new TypeError("Composite.open: Invalid call on root.");

//       const method = Array.prototype.getOwnPropertyDescriptor(path.at(-1));        //all these names should be preserved
//       if (method) {
//         const key = path.pop();
//         const isArrayMethod = Array.prototype.hasOwnProperty(key);
//         let res, home = resolvePath(root, path) ?? (isArrayMethod ? [] : {});
//         if (mutators.has(key))
//           home = replaceObjectInsideCompositable(home, "", true);
//         if (method.value && typeof method.value === "function")
//           res = method.value.apply(home, args);
//         else if (!args.length)
//           res = home[key];
//         else if (args.length === 1)
//           res = home[key] = args[0];
//         else
//           throw new TypeError("Composite.open: Invalid call.");
//         root = setImpl(root, path, home, true);
//         return res;
//       }
//       if (!args.length) return get(path);
//       if (args.length === 1) return root = setImpl(root, path, args[0], true);
//       throw new TypeError("Composite.open: Invalid call.");
//     },
//     deleteProperty: (_, key) => {
//       const clone = replaceObjectInsideCompositable(resolvePath(root, path), "", true); //test that this can never be null
//       delete clone[key];
//       root = setImpl(root, path, clone, true);
//       return true;
//     },
//   });

//   return at([]);
// };