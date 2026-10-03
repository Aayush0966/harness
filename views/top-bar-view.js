// views/top-bar-view.js — Sticky toolbar: API key, Pick Folder, Run, and smart-prompt input.
// UIX contract: Rule 1 — constructor knows nothing. Rule 4 — listeners attached in _render(), not update().


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
    this.innerHTML = html`
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
    // Rule 4: event listeners are attached in connectedCallback/_render, not inside update()
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

customElements.define('top-bar-view', TopBarView);
