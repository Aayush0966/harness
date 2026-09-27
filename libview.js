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

class TestView extends HTMLElement {
  // Rule 1: constructor stays empty of state.

  update(folder, transducers, uixComponents) {
    if (folder === this._folder) return; // Rule 2: cheap skip via reference equality
    this._folder = folder;
    this.render();
  }

  render() {
    this.textContent = `Folder: ${this._folder?.name ?? '(none)'}`;
  }

  connectedCallback() {
    // Rule 3: request a change by dispatching — never by writing folder state directly.
    // Rule 4: this click handler is not inside update(), so dispatching here is safe.
    this.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('new-folder', {
        bubbles: true, detail: { touched: true }
      }));
    });
  }
}
class DefaultView extends HTMLElement {
  update(folder, transducers, uixComponents) {
    if (folder === this._folder) return;
    this._folder = folder;
    this.render();
  }

  render() {
    if (!this._folder) {
      this.innerHTML = '<p style="color:#666; font-style:italic">Pick a folder to start inspecting.</p>';
      return;
    }
    const files = (this._folder.children || []).filter(c => c.kind === 'file');
    this.innerHTML = `
      <div style="font-family:sans-serif; margin-top:1em; border:1px solid #ccc; padding:12px; border-radius:6px">
        <h3 style="margin-top:0">📁 ${this._folder.name}</h3>
        <p><strong>Files:</strong> ${files.length}</p>
        <ul>
          ${files.map(f => `<li><strong>${f.name}</strong> (${f.type}): <code style="background:#f4f4f4; padding:2px 4px">${typeof f.content === 'string' ? f.content.slice(0, 100) : '[binary]'}</code></li>`).join('')}
        </ul>
      </div>
    `;
  }
}

customElements.define('test-view', TestView);
customElements.define('default-view', DefaultView);
