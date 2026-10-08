
const llm = (llmOptions) => fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + localStorage.getItem('iverdream_key'), 'Content-Type': 'application/json' },
  body: JSON.stringify(llmOptions)
}).then(async r => {
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.json()).error?.message || r.statusText}`);
  return r.json();
});
const toOps = ops => (ops ?? []).map(op => typeof op === 'string' ? { name: op } : op);

const llmd = (strings, ...values) =>
  strings.reduce((acc, str, i) =>
    acc + (['string', 'number', 'boolean', 'bigint'].includes(typeof values[i - 1]) ? values[i - 1] : '') + str);

const compileLlmd = body =>
  new Function('llmd', '$', 'return llmd`' + body.replace(/[`\\]/g, '\\$&') + '`').bind(null, llmd);

// $ for one render pass: $.oneByOne(array) records the array and returns array[index].
// Anything else (reads, `$.llmOptions = ...` assignments) hits the plain state object.
const make$ = (data, index = 0, previous) => {
  const state = { ...data, _previous: previous };
  return new Proxy(state, {
    get: (t, p) => p === 'oneByOne' ? array => (t._array ??= array)[index] : t[p],
  });
};

// Probes the template once to find the oneByOne array, then renders and calls the LLM once per item.
// Returns null if the template doesn't use $.oneByOne().
async function runOneByOne(template, data) {
  const probe = make$(data);
  template(probe);
  const items = probe._array;
  if (!items) return null;

  const results = [];
  let previous;
  for (let i = 0; i < items.length; i++) {
    const prompt = template(make$(data, i, previous));
    const res = await llm({ ...probe.llmOptions, messages: [{ role: 'user', content: prompt }] });
    previous = res.choices?.[0]?.message?.content ?? '';
    results.push({ item: items[i], prompt, response: previous });
  }
  return results;
}

const Transducer = (name, arg, dict) => {
  if (name in dict)
    return dict[name](arg);
  throw new ReferenceError(`Unknown transducer: ${name}`);
};

const histoReduce = reducer => (_, { files }) =>
  files.reduce((acc, item, i, files) => [reducer(acc, item, i, files), ...acc], []);

function compileFolder(taskList, innerMostCall, rootCtx = {}, groupCtx = {}) {
  groupCtx.id ??= taskList.folderName;
  groupCtx.template ??= taskList.template;

  const perFileTransducers = toOps(taskList._perFileOps).map(({ name, arg }) => Transducer(name, arg, PerFileOps));
  const perFileReducer = perFileTransducers.reduceRight((reducer, transducer) => transducer(reducer, rootCtx, groupCtx), innerMostCall);
  const filesHistoReduce = histoReduce(perFileReducer);

  const mergeStep = PerFolderOps._merge(null);
  const perFolderTransducers = toOps(taskList._perFolderOps).map(({ name, arg }) => Transducer(name, arg, PerFolderOps)); const perFolderReducer = perFolderTransducers.reduceRight(
    (reducer, transducer) => transducer(reducer, rootCtx, groupCtx),
    mergeStep(filesHistoReduce, rootCtx, groupCtx)
  );

  return perFolderReducer;
}


// async function run(taskList, folders, rootCtx = {}) {
//   const outputs_ = [];
//   for (let i = 0; i < taskList.length; i++) {
//     const folderReducer = compileFolder(taskList[i], PerFileOps._root, rootCtx);
//     const rawResults = await folderReducer(outputs_, { ...taskList[i], folder: folders[i], folders }, i, taskList);
//     const results = (await Promise.all(rawResults)).reverse();
//     outputs_.push({ folder: folders[i], outputs: extractOutputs(taskList[i].operation, results) });
//   }
//   return outputs_;
// }

async function runEngineOnJson(folder, taskList, rootCtx = {}) {
  for (const task of taskList) {
    const stepFolder = folder.children?.find(c => c.kind === 'directory' && c.folderName === task.folderName) ?? folder;
    const results = await runOneByOne(task.template, { ...rootCtx, ...task, folder: stepFolder });
    const updatedChildren = (stepFolder.children ?? []).map(child => {
      if (child.kind !== 'file') return child;
      const r = results.find(r => r.item.filename === child.filename);
      return r ? Composite.set(child).data(r.response) : child;
    });
    const updatedStep = Composite.set(stepFolder).children(updatedChildren);
    folder = Composite.set(folder).children((folder.children ?? []).map(c =>
      c.kind === 'directory' && c.folderName === task.folderName ? updatedStep : c));
  }
  return folder;
}