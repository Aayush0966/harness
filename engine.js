// engine.js — Core engine: llm, parse, Transducer, compileFolder, run, runEngineOnJson

const llm = (model, llmOptions) => fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + document.getElementById('key').value, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, ...llmOptions })
}).then(async r => {
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.json()).error?.message || r.statusText}`);
  return r.json();
});

const Transducer = (name, arg, dict) => {
  if (name in dict)
    return dict[name](arg);
  throw new ReferenceError(`Unknown transducer: ${name}`);
};

const histoReduce = reducer => (_, { inputs }) =>
  inputs.reduce((acc, item, i, inputs) => [reducer(acc, item, i, inputs), ...acc], []);

function compileFolder(taskList, innerMostCall, rootCtx = {}, groupCtx = {}) {
  groupCtx.id ??= taskList.name;
  const { perFileOps, perFolderOps } = taskList;

  const perFileTransducers = perFileOps.map(({ name, arg }) => Transducer(name, arg, PerFileOps));
  const perFileReducer = perFileTransducers.reduceRight((reducer, transducer) => transducer(reducer, rootCtx, groupCtx), innerMostCall);
  const filesHistoReduce = histoReduce(perFileReducer);

  const perFolderTransducers = perFolderOps.map(({ name, arg }) => Transducer(name, arg, PerFolderOps));
  const perFolderReducer = perFolderTransducers.reduceRight((reducer, transducer) => transducer(reducer, rootCtx, groupCtx), filesHistoReduce);

  return perFolderReducer;
}


async function run(taskList, folders, rootCtx = {}) {
  const outputs_ = [];
  for (let i = 0; i < taskList.length; i++) {
    const folderReducer = compileFolder(taskList[i], PerFileOps._root, rootCtx);
    const rawResults = await folderReducer(outputs_, { ...taskList[i], folder: folders[i], folders }, i, taskList);
    const results = (await Promise.all(rawResults)).reverse();
    outputs_.push({ folder: folders[i], outputs: extractOutputs(taskList[i].operation, results) });
  }
  return outputs_;
}

// Bridge between the in-memory JSON architecture and the engine.
// Feeds folder.children directly into the transducer pipeline (no dirHandle needed).
// inputFiles reads from folder.children; all other transducers are unchanged.
// Returns a new immutable folder with outputs merged in via Composite.assign —
// the original folder is never mutated.
async function runEngineOnJson(folder, taskList, rootCtx = {}) {
  if (!taskList.length) return folder;
  const outputs_ = [];
  for (let i = 0; i < taskList.length; i++) {
    const folderReducer = compileFolder(taskList[i], PerFileOps._root, rootCtx);
    // Pass the JSON folder directly — inputFiles reads folder.children, not dirHandle.
    const rawResults = await folderReducer(outputs_, { ...taskList[i], folder }, i, taskList);
    const results = (await Promise.all(rawResults)).reverse();
    outputs_.push({ folder, outputs: extractOutputs(taskList[i].operation, results) });
  }
  // Merge the last step's outputs back into the folder as updated file contents.
  // Composite.assign produces a new object — unchanged branches stay === identical.
  const finalOutputs = outputs_[outputs_.length - 1].outputs;
  const files = (folder.children || []).filter(c => c.kind === 'file' && c.type === 'text');
  const updatedFiles = finalOutputs.map((out, i) => {
    const base = files[i] ?? { kind: 'file', name: `output-${i}.json`, type: 'text' };
    const content = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    return Composite.assign(base, { content });
  });
  const nonFiles = (folder.children || []).filter(c => c.kind !== 'file' || c.type !== 'text');
  return Composite.assign(folder, { children: [...nonFiles, ...updatedFiles] });
}
