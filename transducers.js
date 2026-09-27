// transducers.js — extractOutputs, budget/token symbols, PerFolderOps, PerFileOps, ModelPrices
// Depends on: engine.js (llm, parse)
//
// Step 5 — purity constraint (hard rule, not a style preference):
// Every transducer must be pure: no closures over external variables, no DOM bindings.
// A pure function's source text (fn.toString()) fully captures its behaviour — it can be
// eval()'d back and produce identical results, enabling safe localStorage round-tripping.

const extractOutputs = (operation, results) =>
  operation === 'reduce' ? [results[results.length - 1].output]
    : operation === 'flatMap' ? results.flatMap(r => Array.isArray(r.output) ? r.output : [r.output])
      : results.map(r => r.output);

const budgetMax = Symbol("budgetMax");         // For Dollars
const budgetSpent = Symbol("budgetSpent");
const tokenMaxLimit = Symbol("tokenMaxLimit"); // For Tokens
const tokenSpent = Symbol("tokenSpent");

const ModelPrices = {
  "deepseek/deepseek-chat": 0.14,
  "deepseek/deepseek-r1": 0.55,
  "google/gemini-2.0-flash-001": 0.10,
  "openai/gpt-4o-mini": 0.15,
  "openai/gpt-4o": 5.00,
  "anthropic/claude-3.5-sonnet": 3.00,
  "default": 0.20 // fallback price per 1 million tokens
};

// PerFolderOps transducer shape: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => result
const PerFolderOps = {
  log: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    console.log("collection: ", item);
    const res = await innerCb(outputs_, { ...item }, i, inputs);
    console.log("collection res:", res);
    return res;
  },

  inputFiles: (arg = 0) => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const idx = parseInt(arg);
    if (outputs_.length > idx) {
      // Chain: pull outputs from a previous step — pure, no FS, unchanged.
      item.inputs = (await outputs_[idx]).outputs.map(content => ({ content, query: item.query, model: item.model }));
    } else {
      // Fallback: read text files directly from the in-memory JSON folder.
      // folder.children replaces dirHandle.values() — no filesystem touch needed.
      item.inputs = (item.folder.children || [])
        .filter(c => c.kind === 'file' && c.type === 'text')
        .map(f => ({ content: f.content, query: item.query, model: item.model }));
    }
    return innerCb(outputs_, { ...item }, i, inputs);
  },

  Sample: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const cfg = typeof arg === 'object' ? arg : { count: parseInt(arg) };
    const all = item.inputs ?? [];
    const n = cfg.ratio != null ? Math.max(1, Math.round(all.length * cfg.ratio)) : (cfg.count ?? all.length);
    const shuffled = all.slice().sort(() => Math.random() - 0.5);
    return innerCb(outputs_, { ...item, inputs: shuffled.slice(0, n) }, i, inputs);
  },

  Merge: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const all = item.inputs ?? [];
    const merged = all.map((it, idx) => ({ index: idx, content: it.content }));
    const first = all[0] ?? item;
    return innerCb(outputs_, { ...first, inputs: [{ ...first, content: JSON.stringify(merged, null, 2) }] }, i, inputs);
  },
};

// PerFileOps transducer shape: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => result
// _root is the innermost call (not a transducer) — it has no (innerCb, rootCtx, groupCtx) wrapper.
// Soft rule: on conflict between two transducers, outermost wins on output, innermost wins on input.
const PerFileOps = {
  _root: async (outputs_, item, i, inputs) => {
    const res = await llm(item.model, item.llmOptions);
    return {
      output: parse(res.choices[0].message.content),
      tokens: res.usage?.total_tokens || 0,
      model: item.model
    };
  },

  log: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    console.log("item: ", item);
    const res = await innerCb(outputs_, { ...item }, i, inputs);
    console.log("item res:", res);
    return res;
  },

  FillQuery: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const messages = [
      { role: 'system', content: item.query.prefix },
      {
        role: 'user', content: item.query.text + '\n\n'
          + (typeof item.content === 'string' ? item.content : JSON.stringify(item.content, null, 2))
          + '\n\n' + item.query.postface
      }
    ];
    return innerCb(outputs_, { ...item, llmOptions: { messages } }, i, inputs);
  },

  Json: schema => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const llmOptions = { ...item.llmOptions, response_format: { type: "json_schema", json_schema: schema } };
    return innerCb(outputs_, { ...item, llmOptions }, i, inputs);
  },

  Boolean: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const schema = {
      name: "boolean_result", strict: true, schema: {
        type: "object", properties: { value: { type: "boolean" } }, required: ["value"], additionalProperties: false
      }
    };
    const res = await PerFileOps.Json(schema)(innerCb, rootCtx, groupCtx)(outputs_, item, i, inputs);
    return { ...res, output: res.output.value };
  },

  Tagging: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const schema = {
      name: "tagging_result", strict: true, schema: {
        type: "object", properties: { tags: { type: "array", items: { type: "string" } } }, required: ["tags"], additionalProperties: false
      }
    };
    const res = await PerFileOps.Json(schema)(innerCb, rootCtx, groupCtx)(outputs_, item, i, inputs);
    const tags = config?.allowedTags ? res.output.tags.filter(t => config.allowedTags.includes(t)) : res.output.tags;
    return { ...res, output: tags };
  },

  Scoring: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const schema = {
      name: "scoring_result", strict: true, schema: {
        type: "object", properties: { score: { type: "number" } }, required: ["score"], additionalProperties: false
      }
    };
    const res = await PerFileOps.Json(schema)(innerCb, rootCtx, groupCtx)(outputs_, item, i, inputs);
    const score = res.output.score;
    if (score < 0 || score > 1) throw new Error(`Scoring: model returned out-of-range score: ${score}`);
    return { ...res, output: score };
  },

  Spread: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const schema = {
      name: "spread_result", strict: true, schema: {
        type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false
      }
    };
    const res = await PerFileOps.Json(schema)(innerCb, rootCtx, groupCtx)(outputs_, item, i, inputs);
    return { ...res, output: res.output.items };
  },

  Budget: strArg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    rootCtx[budgetMax] ??= Number(strArg);
    rootCtx[budgetSpent] ??= 0;
    if (rootCtx[budgetSpent] >= rootCtx[budgetMax])
      throw new Error(`Dollar Budget exceeded: $${rootCtx[budgetSpent].toFixed(4)} >= $${rootCtx[budgetMax]}`);
    const res = await innerCb(outputs_, item, i, inputs);
    try {
      const pricePerMillion = ModelPrices[res.model] ?? ModelPrices["default"];
      rootCtx[budgetSpent] += (res.tokens / 1_000_000) * pricePerMillion;
      return res;
    } catch (err) {
      err.output = res;
      throw err;
    }
  },

  TokenMax: strArg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    rootCtx[tokenMaxLimit] ??= Number(strArg);
    rootCtx[tokenSpent] ??= 0;
    if (rootCtx[tokenSpent] >= rootCtx[tokenMaxLimit])
      throw new Error(`Token limit exceeded: ${rootCtx[tokenSpent]} >= ${rootCtx[tokenMaxLimit]}`);
    const res = await innerCb(outputs_, item, i, inputs);
    try {
      rootCtx[tokenSpent] += res.tokens;
      return res;
    } catch (err) {
      err.output = res;
      throw err;
    }
  },

  Reduce: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const acc = outputs_.length ? (await outputs_[0]).output : (config.seed ?? null);
    const content = JSON.stringify({ accumulator: acc, item: JSON.parse(item.content) }, null, 2);
    return innerCb(outputs_, { ...item, content }, i, inputs);
  },

  MultiSearch: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => {
    const candidates = await Promise.all(
      config.searchModels.map(model => innerCb(outputs_, { ...item, model }, i, inputs))
    );
    const judgeContent = JSON.stringify(candidates.map((r, ci) => ({
      candidate: ci, model: config.searchModels[ci], output: r.output
    })), null, 2);
    const verdict = await innerCb(outputs_, {
      ...item, content: judgeContent, query: config.judgeQuery, model: config.judgeModel || item.model
    }, i, inputs);
    try {
      const winnerIdx = (typeof verdict.output === 'object' && typeof verdict.output.winner === 'number')
        ? verdict.output.winner : 0;
      const winner = candidates[Math.min(winnerIdx, candidates.length - 1)];
      const totalTokens = candidates.reduce((s, r) => s + (r.tokens || 0), 0) + (verdict.tokens || 0);
      return { ...winner, tokens: totalTokens, chosenTokens: winner.tokens };
    } catch (err) {
      err.output = { candidates, verdict };
      throw err;
    }
  },
};
