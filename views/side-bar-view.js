// views/side-bar-view.js — Step navigator: renders one button per step subfolder.
// UIX contract: Rule 2 — cheap skip when folder reference unchanged.


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
      ? steps.map(s => html`
          <button data-step="${s.folderName}"
            style="text-align:left; padding:6px 8px; border:none; border-radius:4px; cursor:pointer; background:${s.folderName === active ? '#e0e7ff' : 'transparent'}; font-size:13px">
            📁 ${s.folderName}
          </button>`).join('')
      : html`<p style="color:#aaa; margin:0">No steps</p>`;

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
