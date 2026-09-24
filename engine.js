// engine.js — Core engine: llm, parse, Transducer, compileFolder, run

const llm = (model, llmOptions) => fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + document.getElementById('key').value, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, ...llmOptions })
}).then(async r => {
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.json()).error?.message || r.statusText}`);
  return r.json();
});

const parse = t => {
  try { return JSON.parse(t.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?\s*```$/, '')); }
  catch { return t; }
};



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
