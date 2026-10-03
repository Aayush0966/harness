// views/default-view.js — Folder inspector: lists all files in the selected step (or root).
// UIX contract: Rule 1 — constructor knows nothing. Rule 2 — update() is cheap-skippable.


class DefaultView extends HTMLElement {
  update(history, transducers, uixComponents) {
    this._history = history;
    this.render();
  }

  render() {
    const root = this._history?.[this._history.length - 1];
    if (!root) {
      this.innerHTML = html`<p style="color:#666; font-style:italic">Pick a folder to start inspecting.</p>`;
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
    this.innerHTML = html`
      <div style="font-family:sans-serif; margin-top:1em; border:1px solid #ccc; padding:12px; border-radius:6px">
        <h3 style="margin-top:0">📁 ${target.folderName}</h3>
        <p><strong>Files:</strong> ${files.length}</p>
        <ul>
          ${files.map(f => html`<li><strong>${f.filename}</strong>: <code style="background:#f4f4f4; padding:2px 4px">${typeof f.data === 'string' ? f.data.slice(0, 100) : '[binary]'}</code></li>`).join('')}
        </ul>
      </div>
    `;
  }
}

customElements.define('default-view', DefaultView);
