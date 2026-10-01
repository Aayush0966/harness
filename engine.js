
const llm = (llmOptions) => fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + document.getElementById('key').value, 'Content-Type': 'application/json' },
  body: JSON.stringify(llmOptions)
}).then(async r => {
  if (!r.ok) throw new Error(`API ${r.status}: ${(await r.json()).error?.message || r.statusText}`);
  return r.json();
});

const Transducer = (name, arg, dict) => {
  if (name in dict)
    return dict[name](arg);
  throw new ReferenceError(`Unknown transducer: ${name}`);
};

const histoReduce = reducer => (_, { files }) =>
  files.reduce((acc, item, i, files) => [reducer(acc, item, i, files), ...acc], []);

function compileFolder(taskList, innerMostCall, rootCtx = {}, groupCtx = {}) {
  groupCtx.id ??= taskList.folderName;
  const { perFileOps, perFolderOps } = taskList;

  const perFileTransducers = perFileOps.map(({ name, arg }) => Transducer(name, arg, PerFileOps));
  const perFileReducer = perFileTransducers.reduceRight((reducer, transducer) => transducer(reducer, rootCtx, groupCtx), innerMostCall);
  const filesHistoReduce = histoReduce(perFileReducer);

  const mergeStep = PerFolderOps._merge(null);
  const perFolderTransducers = perFolderOps.map(({ name, arg }) => Transducer(name, arg, PerFolderOps));
  const perFolderReducer = perFolderTransducers.reduceRight(
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
  if (!taskList.length) return folder;
  let currentFolder = folder;
  for (let i = 0; i < taskList.length; i++) {
    const stepFolder = currentFolder.children?.find(c => c.kind === 'directory' && c.name === taskList[i].folderName) ?? currentFolder;
    const folderReducer = compileFolder(taskList[i], PerFileOps._root, rootCtx);
    const updatedStepFolder = await folderReducer([], { ...taskList[i], folder: stepFolder }, i, taskList);
    const updatedChildren = currentFolder.children
      ? currentFolder.children.map(c => c.kind === 'directory' && c.name === taskList[i].folderName ? updatedStepFolder : c)
      : currentFolder.children;
    currentFolder = Composite.set(currentFolder).children(updatedChildren ?? currentFolder.children);
  }
  return currentFolder;
}