// folder.js — File system I/O: createFolders, save, readFolder
// Binary files are base64-encoded. Text files are stored as plain strings.
// Handles reading folder structures and saving processing results.

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
  return Object.freeze(entries);
};

// Returns a new folder object with changes applied, leaving the original untouched.
// Recursively merges nested objects; arrays and primitives are replaced outright.
function deepAssign(target, changes) {
  const result = Array.isArray(target) ? [...target] : { ...target };
  for (const key in changes) {
    const isNestedObject = typeof changes[key] === 'object' && changes[key] !== null
      && typeof target?.[key] === 'object' && target[key] !== null;
    result[key] = isNestedObject ? deepAssign(target[key], changes[key]) : changes[key];
  }
  return result;
}

async function createFolders(rawInputFolder) {
  const taskList = [];
  const folders = [];
  const entries = [];
  for await (const entry of rawInputFolder.values())
    if (entry.kind === 'directory') entries.push(entry);
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    try {
      const op = JSON.parse(await (await (await entry.getFileHandle('operation.json')).getFile()).text());
      taskList.push({ name: entry.name, dirHandle: entry, ...op });
      folders.push({ name: entry.name, dirHandle: entry });
    } catch (e) {
      // skip folders without a valid operation.json
    }
  }
  return { taskList, folders };
}

async function save(res, rawOutputFolder) {
  for (let i = 0; i < res.length; i++) {
    const { folder, outputs } = res[i];
    const stepDir = await rawOutputFolder.getDirectoryHandle(folder.name, { create: true });
    for (let j = 0; j < outputs.length; j++) {
      const w = await (await stepDir.getFileHandle(j + '.json', { create: true })).createWritable();
      await w.write(JSON.stringify(outputs[j], null, 2));
      await w.close();
    }
  }
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
