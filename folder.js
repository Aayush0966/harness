
const TEXT_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/markdown',
  'application/json', 'application/xml', 'application/javascript',
]);
const TEXT_EXTS  = new Set([
  'txt', 'md', 'markdown', 'js', 'mjs', 'ts', 'jsx', 'tsx',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
  'css', 'scss', 'less', 'svg', 'csv', 'sh', 'py', 'rb', 'go',
  'rs', 'c', 'cpp', 'h', 'java', 'kt', 'swift', 'sql',
]);

const isText = file =>
  TEXT_TYPES.has(file.type) ||
  TEXT_EXTS.has(file.name.split('.').pop().toLowerCase());

const readFile = async file => {
  if (isText(file)) {
    return { type: 'text', content: await file.text() };
  }
  const buf = await file.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { type: 'base64', content: b64, mime: file.type || 'application/octet-stream' };
};

const readFolder = async (dirHandle, path = '') => {
  const entries = { name: dirHandle.name, path, children: [] };
  for await (const handle of dirHandle.values()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      entries.children.push({ kind: 'file', name: handle.name, ...await readFile(file) });
    } else {
      entries.children.push({ kind: 'directory', ...await readFolder(handle, path ? `${path}/${handle.name}` : handle.name) });
    }
  }
  entries.children.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
};

async function createFolders(rawInputFolder) {
  const taskList = [];
  const entries = [];
  for await (const entry of rawInputFolder.values())
    if (entry.kind === 'directory') entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    try {
      const op = JSON.parse(await (await (await entry.getFileHandle('operation.json')).getFile()).text());
      taskList.push({ name: entry.name, dirHandle: entry, ...op });
    } catch (e) {
      // skip folders without a valid operation.json
    }
  }
  return { taskList };
}

async function writeFolder(dirHandle, folderObj) {
  for (const child of folderObj.children) {
    if (child.kind === 'directory') {
      const subDir = await dirHandle.getDirectoryHandle(child.name, { create: true });
      await writeFolder(subDir, child);
    } else {
      const w = await (await dirHandle.getFileHandle(child.name, { create: true })).createWritable();
      if (child.type === 'base64') {
        const binary = atob(child.content);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        await w.write(bytes);
      } else {
        await w.write(child.content);
      }
      await w.close();
    }
  }
}

function applyOutputs(topFolder, outputs) {
  const { folder: stepFolder, outputs: finalOutputs } = outputs[outputs.length - 1];
  const files = stepFolder.children.filter(c => c.kind === 'file' && c.type === 'text');
  const nonFiles = stepFolder.children.filter(c => c.kind !== 'file' || c.type !== 'text');
  const updatedFiles = finalOutputs.map((out, i) => {
    const base = files[i] ?? { kind: 'file', name: `output-${i}.json`, type: 'text' };
    const content = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    return { ...base, content };
  });
  const updatedStepFolder = Composite.set(stepFolder).children([...nonFiles, ...updatedFiles]);
  const updatedChildren = topFolder.children.map(c =>
    c.kind === 'directory' && c.name === stepFolder.name ? updatedStepFolder : c
  );
  return Composite.set(topFolder).children(updatedChildren);
}
