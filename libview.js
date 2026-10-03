// libview.js — Built-in view components (Custom Elements).
// UIX contract (step 3):
//   Rule 1 — constructor knows nothing; all setup happens in update().
//   Rule 2 — update(folder, transducers, uixComponents) is called repeatedly; skip via === when nothing changed.
//   Rule 3 — request changes by dispatching new-folder / new-transducer / new-uix-component (never write state directly).
//   Rule 4 — update() must never synchronously dispatch any of the three event types.
//
// Step 5 — purity constraint (hard rule):
// Every UIX component class must be pure: no closures over external variables, no bindings to
// specific DOM globals. Its source text must fully capture its behaviour so it can safely
// round-trip through localStorage/eval for custom component loading (step 7).

class DefaultView extends HTMLElement {
  update(history, transducers, uixComponents) {
    this._history = history;
    this.render();
  }

  render() {
    const root = this._history?.[this._history.length - 1];
    if (!root) {
      this.innerHTML = '<p style="color:#666; font-style:italic">Pick a folder to start inspecting.</p>';
      return;
    }
    const step = new URLSearchParams(location.search).get('step');
    const target = step
      ? (root.children?.find(c => c.kind === 'directory' && c.folderName === step) ?? root)
      : root;
    const getFiles = (node, prefix = '') =>
      (node?.children || []).flatMap(c =>
        c.kind === 'file'
          ? [{ ...c, filename: prefix ? `${prefix}/${c.filename}` : c.filename }]
          : getFiles(c, prefix ? `${prefix}/${c.folderName}` : c.folderName)
      );
    const files = getFiles(target);
    this.innerHTML = `
      <div style="font-family:sans-serif; margin-top:1em; border:1px solid #ccc; padding:12px; border-radius:6px">
        <h3 style="margin-top:0">📁 ${target.folderName}</h3>
        <p><strong>Files:</strong> ${files.length}</p>
        <ul>
          ${files.map(f => `<li><strong>${f.filename}</strong>: <code style="background:#f4f4f4; padding:2px 4px">${typeof f.data === 'string' ? f.data.slice(0, 100) : '[binary]'}</code></li>`).join('')}
        </ul>
      </div>
    `;
  }
}

class TopBarView extends HTMLElement {
  // Rule 1: constructor knows nothing.

  update(history, transducers, uixComponents) {
    const folder = history?.[history.length - 1];
    const folderChanged = folder !== this._folder;
    this._folder = folder;
    if (!this._rendered) {
      this._rendered = true;
      this._render();
    }
    // After folder is picked, enable Run + prompt controls and display folder name
    if (folderChanged) {
      const span = this.querySelector('#tb-folder');
      if (span) span.textContent = folder?.folderName || '';
      this._syncEnabled();
    }
  }

  _render() {
    this.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 12px; background:#f8f8f8; border-bottom:1px solid #ddd; flex-wrap:wrap;';
    this.innerHTML = `
      <input id="tb-key" type="password" placeholder="OpenRouter API Key"
             style="padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:13px; width:200px">
      <button id="tb-pick"
              style="padding:4px 10px; border:1px solid #ccc; border-radius:4px; cursor:pointer; font-size:13px">Pick Folder</button>
      <span id="tb-folder" style="font-size:13px; color:#555; min-width:60px"></span>
      <button id="tb-run" disabled
              style="padding:4px 10px; border:1px solid #ccc; border-radius:4px; cursor:pointer; font-size:13px">▶ Run</button>
      <input id="tb-prompt" placeholder="Describe your goal…" disabled
             style="padding:4px 8px; border:1px solid #ccc; border-radius:4px; font-size:13px; flex:1; min-width:200px">
      <button id="tb-go" disabled
              style="padding:4px 10px; border:1px solid #ccc; border-radius:4px; cursor:pointer; font-size:13px">Go</button>
    `;

    // Restore persisted API key
    const savedKey = localStorage.getItem('iverdream_key') || '';
    this.querySelector('#tb-key').value = savedKey;
    this.querySelector('#tb-key').addEventListener('input', e => {
      localStorage.setItem('iverdream_key', e.target.value);
    });

    // Rule 3: dispatch events upward — never touch global state directly.
    // Rule 4: event listeners are attached in connectedCallback/_render, not inside update().
    this.querySelector('#tb-pick').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('pick-folder', { bubbles: true }));
    });

    this.querySelector('#tb-run').addEventListener('click', () => {
      const key = this.querySelector('#tb-key').value;
      this.dispatchEvent(new CustomEvent('run-engine', { bubbles: true, detail: { key } }));
    });

    this.querySelector('#tb-go').addEventListener('click', () => this._firePrompt());
    this.querySelector('#tb-prompt').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._firePrompt();
    });
  }

  _firePrompt() {
    const goal = this.querySelector('#tb-prompt')?.value?.trim();
    if (!goal) return;
    const key = this.querySelector('#tb-key')?.value;
    this.dispatchEvent(new CustomEvent('smart-prompt', { bubbles: true, detail: { goal, key } }));
  }

  // Called after each update() to reflect whether a folder has been loaded.
  _syncEnabled() {
    const hasFolder = !!this._folder;
    const run = this.querySelector('#tb-run');
    const prompt = this.querySelector('#tb-prompt');
    const go = this.querySelector('#tb-go');
    if (run) run.disabled = !hasFolder;
    if (prompt) prompt.disabled = !hasFolder;
    if (go) go.disabled = !hasFolder;
  }
}

customElements.define('default-view', DefaultView);
customElements.define('top-bar-view', TopBarView);

class SideBarView extends HTMLElement {
  update(history, transducers, uixComponents) {
    const folder = history?.[history.length - 1];
    if (folder === this._folder) return; // Rule 2: cheap skip
    this._folder = folder;
    this._render();
  }

  _render() {
    const steps = (this._folder?.children || []).filter(c => c.kind === 'directory');
    const active = new URLSearchParams(location.search).get('step');
    this.style.cssText = 'display:flex; flex-direction:column; gap:4px; padding:8px; border-right:1px solid #ddd; min-width:180px; font-family:sans-serif; font-size:13px;';
    this.innerHTML = steps.length
      ? steps.map(s => `
          <button data-step="${s.folderName}"
            style="text-align:left; padding:6px 8px; border:none; border-radius:4px; cursor:pointer; background:${s.folderName === active ? '#e0e7ff' : 'transparent'}; font-size:13px">
            📁 ${s.folderName}
          </button>`).join('')
      : '<p style="color:#aaa; margin:0">No steps</p>';

    this.querySelectorAll('button[data-step]').forEach(btn =>
      btn.addEventListener('click', () => {
        const p = new URLSearchParams(location.search);
        p.set('step', btn.dataset.step);
        window.history.replaceState(null, '', '?' + p);
        this._render(); // re-render to update active highlight
        this.dispatchEvent(new CustomEvent('step-changed', { bubbles: true, detail: btn.dataset.step }));
      })
    );
  }
}

customElements.define('side-bar-view', SideBarView);
