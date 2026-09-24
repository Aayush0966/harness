// composite.js — Composite: assign (deep immutable merge) and equals (deep equality)
// Plain static-method calls, like Object.assign / Array.from — no wrapping, no proxies.
// Unchanged branches share the same reference, so === checks in update() are meaningful.

const Composite = {
  assign(target, changes) {
    const result = Array.isArray(target) ? [...target] : { ...target };
    for (const key in changes) {
      const isNested = typeof changes[key] === 'object' && changes[key] !== null
        && typeof target?.[key] === 'object' && target[key] !== null;
      result[key] = isNested ? Composite.assign(target[key], changes[key]) : changes[key];
    }
    return result;
  },

  equals(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    const keysA = Object.keys(a), keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(key => Composite.equals(a[key], b[key]));
  }
};
