// transducers.js — extractOutputs, budget/token symbols, PerFolderOps, PerFileOps, ModelPrices
// Depends on: engine.js (llm)
//
// Step 5 — purity constraint (hard rule, not a style preference):
// Every transducer must be pure: no closures over external variables, no DOM bindings.
// A pure function's source text (fn.toString()) fully captures its behaviour — it can be
// eval()'d back and produce identical results, enabling safe localStorage round-tripping.


const budgetMax = Symbol("budgetMax");         // For Dollars
const budgetSpent = Symbol("budgetSpent");
const tokenMaxLimit = Symbol("tokenMaxLimit"); // For Tokens
const tokenSpent = Symbol("tokenSpent");

const ModelPrices = {
  "deepseek/deepseek-chat": 0.14,
  "deepseek/deepseek-r1": 0.55,
  "google/gemini-2.5-flash": 0.30,
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
    const res = await innerCb(outputs_, item, i, inputs);
    console.log("collection res:", res);
    return res;
  },

  inputFiles: (arg = 0) => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const idx = parseInt(arg);
    const raw = outputs_.length > idx
      ? (await outputs_[idx]).outputs.map(data => ({ data, query: item.query, llmOptions: item.llmOptions }))
      : (item.folder.children || [])
          .filter(c => c.kind === 'file' && typeof c.data === 'string')
          .map(f => ({ filename: f.filename, data: f.data, query: item.query, llmOptions: item.llmOptions }));
    const newFiles = raw.map(f => Composite(f, true));
    return innerCb(outputs_, Composite.set(item).files(newFiles), i, files);
  },

  Sample: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const cfg = typeof arg === 'object' ? arg : { count: parseInt(arg) };
    const all = item.files ?? [];
    const n = cfg.ratio != null ? Math.max(1, Math.round(all.length * cfg.ratio)) : (cfg.count ?? all.length);
    const shuffled = all.slice().sort(() => Math.random() - 0.5);
    return innerCb(outputs_, Composite.set(item).files(shuffled.slice(0, n)), i, files);
  },

  Merge: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const all = item.files ?? [];
    const merged = all.map((it, idx) => ({ index: idx, data: it.data }));
    const mergedFile = Composite({ ...(all[0] ?? {}), data: JSON.stringify(merged, null, 2) }, true);
    return innerCb(outputs_, Composite.set(item).files([mergedFile]), i, files);
  },

  _merge: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const rawResults = await innerCb(outputs_, item, i, files);
    const results = (await Promise.all(rawResults)).reverse();
    const sourceFiles = (item.folder.children || []).filter(c => c.kind === 'file' && typeof c.data === 'string');
    const nonFiles = (item.folder.children || []).filter(c => c.kind !== 'file' || typeof c.data !== 'string');
    const updatedFiles = results.map((res, idx) => {
      const base = sourceFiles[idx] ?? { kind: 'file', filename: `output-${idx}.json` };
      const data = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
      return Composite({ ...base, data }, true);
    });
    return Composite.set(item.folder).children([...nonFiles, ...updatedFiles]);
  },
};

// PerFileOps transducer shape: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, inputs) => result
// _root is the innermost call (not a transducer) — it has no (innerCb, rootCtx, groupCtx) wrapper.
// Soft rule: on conflict between two transducers, outermost wins on output, innermost wins on input.
const PerFileOps = {
  _root: async (outputs_, item, i, files) => {
    const res = await llm(item.llmOptions);
    return Composite({
      data: res.choices[0].message.content, // always raw string — no guessing, ever
      tokens: res.usage?.total_tokens || 0,
      model: item.llmOptions.model,
      filename: item.filename
    }, true);
  },

  log: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    console.log("item: ", item);
    const res = await innerCb(outputs_, item, i, files);
    console.log("item res:", res);
    return res;
  },

  FillQuery: arg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const q = item.query;
    const body = typeof item.data === 'string' ? item.data : JSON.stringify(item.data, null, 2);
    const query = (q.prefix ? q.prefix + '\n\n' : '') + (q.text || '') + '\n\n' + body + (q.postface ? '\n\n' + q.postface : '');
    const llmOptions = { ...item.llmOptions, messages: [{ role: 'user', content: query }] };
    item = Composite.set(item).query(query);
    item = Composite.set(item).llmOptions(llmOptions);
    return innerCb(outputs_, item, i, files);
  },

  Json: schema => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const llmOptions = { ...item.llmOptions, response_format: { type: "json_schema", json_schema: schema } };
    item = Composite.set(item).llmOptions(llmOptions);
    const res = await innerCb(outputs_, item, i, files);
    return Composite.set(res).data(JSON.parse(res.data)); // Json is the only one who knows structured output was requested
  },

  Boolean: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const schema = { name: "boolean_result", strict: true, schema: {
      type: "object", properties: { value: { type: "boolean" } }, required: ["value"], additionalProperties: false
    }};
    const llmOptions = { ...item.llmOptions, response_format: { type: "json_schema", json_schema: schema } };
    item = Composite.set(item).llmOptions(llmOptions);
    const res = await innerCb(outputs_, item, i, files);
    return Composite.set(res).data(JSON.parse(res.data).value);
  },

  Tagging: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const schema = { name: "tagging_result", strict: true, schema: {
      type: "object", properties: { tags: { type: "array", items: { type: "string" } } }, required: ["tags"], additionalProperties: false
    }};
    const llmOptions = { ...item.llmOptions, response_format: { type: "json_schema", json_schema: schema } };
    item = Composite.set(item).llmOptions(llmOptions);
    const res = await innerCb(outputs_, item, i, files);
    const tags = JSON.parse(res.data).tags;
    return Composite.set(res).data(config?.allowedTags ? tags.filter(t => config.allowedTags.includes(t)) : tags);
  },

  Scoring: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const schema = { name: "scoring_result", strict: true, schema: {
      type: "object", properties: { score: { type: "number" } }, required: ["score"], additionalProperties: false
    }};
    const llmOptions = { ...item.llmOptions, response_format: { type: "json_schema", json_schema: schema } };
    item = Composite.set(item).llmOptions(llmOptions);
    const res = await innerCb(outputs_, item, i, files);
    const score = JSON.parse(res.data).score;
    if (score < 0 || score > 1) throw new Error(`Scoring: model returned out-of-range score: ${score}`);
    return Composite.set(res).data(score);
  },

  Spread: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const schema = { name: "spread_result", strict: true, schema: {
      type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false
    }};
    const llmOptions = { ...item.llmOptions, response_format: { type: "json_schema", json_schema: schema } };
    item = Composite.set(item).llmOptions(llmOptions);
    const res = await innerCb(outputs_, item, i, files);
    return Composite.set(res).data(JSON.parse(res.data).items);
  },

  Budget: strArg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    rootCtx[budgetMax] ??= Number(strArg);
    rootCtx[budgetSpent] ??= 0;
    if (rootCtx[budgetSpent] >= rootCtx[budgetMax])
      throw new Error(`Dollar Budget exceeded: $${rootCtx[budgetSpent].toFixed(4)} >= $${rootCtx[budgetMax]}`);
    const res = await innerCb(outputs_, item, i, files);
    try {
      const pricePerMillion = ModelPrices[res.model] ?? ModelPrices["default"];
      rootCtx[budgetSpent] += (res.tokens / 1_000_000) * pricePerMillion;
      return res;
    } catch (err) {
      err.data = res;
      throw err;
    }
  },

  TokenMax: strArg => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    rootCtx[tokenMaxLimit] ??= Number(strArg);
    rootCtx[tokenSpent] ??= 0;
    if (rootCtx[tokenSpent] >= rootCtx[tokenMaxLimit])
      throw new Error(`Token limit exceeded: ${rootCtx[tokenSpent]} >= ${rootCtx[tokenMaxLimit]}`);
    const res = await innerCb(outputs_, item, i, files);
    try {
      rootCtx[tokenSpent] += res.tokens;
      return res;
    } catch (err) {
      err.data = res;
      throw err;
    }
  },

  Reduce: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const acc = outputs_.length ? (await outputs_[0]).data : (config.seed ?? null);
    const data = JSON.stringify({ accumulator: acc, item: item.data }, null, 2); // item.data used as-is — works for strings, numbers, objects, arrays
    return innerCb(outputs_, Composite.set(item).data(data), i, files);
  },

  MultiSearch: config => (innerCb, rootCtx, groupCtx) => async (outputs_, item, i, files) => {
    const candidates = await Promise.all(
      config.searchModels.map(model =>
        innerCb(outputs_, Composite.set(item).llmOptions({ ...item.llmOptions, model }), i, files)
      )
    );
    const judgeContent = JSON.stringify(candidates.map((r, ci) => ({
      candidate: ci, model: config.searchModels[ci], data: r.data
    })), null, 2);
    let judgeItem = Composite.set(item).data(judgeContent);
    judgeItem = Composite.set(judgeItem).query(config.judgeQuery);
    judgeItem = Composite.set(judgeItem).llmOptions({ ...item.llmOptions, model: config.judgeModel || item.llmOptions.model });
    const verdict = await innerCb(outputs_, judgeItem, i, files);
    try {
      const winnerIdx = (typeof verdict.data === 'object' && typeof verdict.data.winner === 'number')
        ? verdict.data.winner : 0;
      const winner = candidates[Math.min(winnerIdx, candidates.length - 1)];
      const totalTokens = candidates.reduce((s, r) => s + (r.tokens || 0), 0) + (verdict.tokens || 0);
      let result = Composite.set(winner).tokens(totalTokens);
      result = Composite.set(result).chosenTokens(winner.tokens);
      return result;
    } catch (err) {
      err.data = { candidates, verdict };
      throw err;
    }
  },
};
