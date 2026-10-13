
const llm = (llmOptions) => fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + localStorage.getItem('iverdream_key'), 'Content-Type': 'application/json' },
  body: JSON.stringify(llmOptions)
}).then(async r => {
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.json()).error?.message || r.statusText}`);
  return r.json();
});

const toOps = ops => (ops ?? []).map(op => typeof op === 'string' ? { name: op } : op);

function llmdMedium(strings, ...values) {
  const parts = [strings[0]];
  for (let i = 0; i < values.length; i++) {
    parts.push(print(values[i]), strings[i + 1]);
  }
  return parts;

  function print(v) {
    if (v instanceof Promise) return v;
    if (Array.isArray(v)) return v.map(print);
    if (!v) return '';
    if (typeof v === 'object') throw new Error('llmdMedium: cannot print object');
    return String(v);
  }
}

const compileLlmd = (body, tag = llmdMedium) =>
  new Function('tag', '$', 'return tag`' + body.replace(/[`\\]/g, '\\$&') + '`').bind(null, tag);

async function pick(cell, i) {
  cell = await cell;
  if (!Array.isArray(cell)) return cell;
  return cell.length ? await cell[Math.min(i, cell.length - 1)] : '';
}

async function align(values) {
  values = await Promise.all(values);
  for (const v of values) {
    if (Array.isArray(v) || v === null || typeof v !== 'object') continue;
    throw new Error('align: expected primitive or array');
  }
  return values.some(Array.isArray) ? flatten(values) : [values];
}

async function flatten(cells) {
  cells = await Promise.all(cells);
  const n = Math.max(1, ...cells.filter(Array.isArray).map(a => a.length));
  const rows = await Promise.all(
    Array.from({ length: n }, (_, i) => Promise.all(cells.map(c => pick(c, i))).then(align))
  );
  return rows.flat();
}

const make$ = (...objects) => Object.assign({ llmOptions: { model: 'openrouter/auto' }, oneByOne: x => x }, ...objects);

async function callRow($, parts) {
  const prompt = parts.join('');
  const res = await llm({ ...$.llmOptions, messages: [{ role: 'user', content: prompt }] });
  const message = res.choices?.[0]?.message ?? {};
  return { result: { prompt, message } };
}

async function run(task, data) {
  const medium = compileLlmd(task.body);
  let $ = make$(data, { _previous: '' });
  medium($);                                        // render first — sets $.options, $.llmOptions, etc.
  if ($.options?.locked) return null;               // locked — keep existing files
  const acc = [];
  let i = 0;
  let previous = '';
  while (true) {
    $ = make$(data, { _previous: previous });
    const rows = await flatten(medium($));
    if (i >= rows.length) break;                    // no more rows — done
    const out = await callRow($, rows[i]);
    acc.push(out);
    previous = out.result.message.content ?? '';
    i++;
  }
  return acc;
}

const Transducer = (name, arg, dict) => {
  if (name in dict) return dict[name](arg);
  throw new ReferenceError(`Unknown transducer: ${name}`);
};

const histoReduce = reducer => (_, { files }) =>
  files.reduce((acc, item, i, files) => [reducer(acc, item, i, files), ...acc], []);

function compileFolder(taskList, innerMostCall, rootCtx = {}, groupCtx = {}) {
  groupCtx.id ??= taskList.folderName;
  groupCtx.template ??= taskList.template;

  const perFileTransducers = toOps(taskList._perFileOps).map(({ name, arg }) => Transducer(name, arg, PerFileOps));
  const perFileReducer = perFileTransducers.reduceRight((reducer, transducer) => transducer(reducer, rootCtx, groupCtx), innerMostCall);

  const mergeStep = PerFolderOps._merge(null);
  const perFolderTransducers = toOps(taskList._perFolderOps).map(({ name, arg }) => Transducer(name, arg, PerFolderOps));
  const perFolderReducer = perFolderTransducers.reduceRight(
    (reducer, transducer) => transducer(reducer, rootCtx, groupCtx),
    mergeStep(histoReduce(perFileReducer), rootCtx, groupCtx)
  );

  return perFolderReducer;
}

const folderVars = folder =>
  (folder.children ?? []).filter(c => c.kind === 'directory').reduce((acc, sub) => {
    const texts = (sub.children ?? []).filter(c => c.kind === 'file' && !c.isBinary).map(c => c.data ?? '');
    const key = sub.folderName.replace(/[^a-zA-Z0-9_$]/g, '_');
    return { ...acc, [key]: texts };
  }, {});

async function runEngineOnJson(folder, taskList, rootCtx = {}) {
  for (const task of taskList) {
    const stepFolder = folder.children?.find(c => c.kind === 'directory' && c.folderName === task.folderName) ?? folder;
    const results = await run(task, { ...folderVars(folder), ...rootCtx, ...task, folder: stepFolder });
    if (results === null) continue;                    // locked — leave existing files untouched
    const kept = (stepFolder.children ?? []).filter(c => !isOutput(c));
    const outFiles = results.map((r, i) =>
      Composite({ kind: 'file', filename: `output_${i}.txt`, data: r.result.message.content ?? '', result: r.result }, true));
    const updatedStep = Composite.set(stepFolder).children([...kept, ...outFiles]);
    folder = Composite.set(folder).children(
      (folder.children ?? []).map(c => c.kind === 'directory' && c.folderName === task.folderName ? updatedStep : c));
  }
  return folder;
}