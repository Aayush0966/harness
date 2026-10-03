
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'js', 'mjs', 'ts', 'jsx', 'tsx',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
  'css', 'scss', 'less', 'svg', 'csv', 'sh', 'py', 'rb', 'go',
  'rs', 'c', 'cpp', 'h', 'java', 'kt', 'swift', 'sql',
]);

const isText = file =>
  TEXT_EXTS.has(file.name.split('.').pop().toLowerCase());

const readFile = async file => {
  if (isText(file)) {
    return { data: await file.text() };
  }
  const buf = await file.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { data: b64 };
};

const readFolder = async (dirHandle, path = '') => {
  const entries = { folderName: dirHandle.name, path, children: [] };
  for await (const handle of dirHandle.values()) {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const kind = handle.name === 'config.json' ? 'config' : 'file';
      entries.children.push({ kind, filename: handle.name, ...await readFile(file) });
    } else {
      entries.children.push({ kind: 'directory', ...await readFolder(handle, path ? `${path}/${handle.name}` : handle.name) });
    }
  }
  entries.children.sort((a, b) => (a.filename ?? a.folderName).localeCompare(b.filename ?? b.folderName));
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
      const op = JSON.parse(await (await (await entry.getFileHandle('config.json')).getFile()).text());
      taskList.push({ folderName: entry.name, dirHandle: entry, ...op });
    } catch (e) {
      // skip folders without a valid operation.json
    }
  }
  return { taskList };
}

async function writeFolder(dirHandle, folderObj) {
  for (const child of folderObj.children) {
    if (child.kind === 'directory') {
      const subDir = await dirHandle.getDirectoryHandle(child.folderName, { create: true });
      await writeFolder(subDir, child);
    } else {
      const w = await (await dirHandle.getFileHandle(child.filename, { create: true })).createWritable();
      await w.write(child.data);
      await w.close();
    }
  }
}
