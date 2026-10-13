
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'llmd', 'js', 'mjs', 'ts', 'jsx', 'tsx',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
  'css', 'scss', 'less', 'svg', 'csv', 'sh', 'py', 'rb', 'go',
  'rs', 'c', 'cpp', 'h', 'java', 'kt', 'swift', 'sql',
]);

const isText = file => TEXT_EXTS.has(file.name.split('.').pop().toLowerCase());

const isOutput = c => c.kind === 'file' && /^output_\d+\.txt$/.test(c.filename ?? '');

const readFile = async file => {
  if (isText(file)) return { data: await file.text() };
  const buf = await file.arrayBuffer();
  return { data: btoa(String.fromCharCode(...new Uint8Array(buf))), isBinary: true };
};

const readFolder = async (dirHandle, path = '') => {
  const entries = { folderName: dirHandle.name, path, children: [] };
  for await (const handle of dirHandle.values()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const kind = handle.name === 'query.llmd' ? 'config' : 'file';
      entries.children.push({ kind, filename: handle.name, ...await readFile(file) });
    } else {
      entries.children.push({ kind: 'directory', ...await readFolder(handle, path ? `${path}/${handle.name}` : handle.name) });
    }
  }
  entries.children.sort((a, b) => (a.filename ?? a.folderName).localeCompare(b.filename ?? b.folderName, undefined, { numeric: true }));
  return entries;
};

async function createFolders(rawInputFolder) {
  const entries = [];
  for await (const entry of rawInputFolder.values())
    if (entry.kind === 'directory') entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const taskList = (await Promise.all(entries.map(async entry => {
    try {
      const body = await (await (await entry.getFileHandle('query.llmd')).getFile()).text();
      return { folderName: entry.name, body, medium: compileLlmd(body) };
    } catch { return null; }
  }))).filter(Boolean);

  return { taskList };
}

const removeStale = async (dirHandle, children) => {
  const kept = new Set((children ?? []).map(c => c.filename ?? c.folderName));
  const toRemove = [];
  for await (const handle of dirHandle.values())
    if (!kept.has(handle.name) && (handle.kind !== 'file' || isOutput({ kind: 'file', filename: handle.name })))
      toRemove.push(handle.name);
  await Promise.all(toRemove.map(name => dirHandle.removeEntry(name, { recursive: true })));
};

const writeText = async (dir, name, text) => {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
};

async function writeFolder(dirHandle, folderObj) {
  await removeStale(dirHandle, folderObj.children);
  for (const child of folderObj.children) {
    if (child.kind === 'directory') {
      await writeFolder(await dirHandle.getDirectoryHandle(child.folderName, { create: true }), child);
    } else if (child.filename && child.data != null && !child.isBinary) {
      await writeText(dirHandle, child.filename, child.data);
    }
  }
}
