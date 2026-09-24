// libview.js — Built-in view components (Custom Elements).
// Each view receives a folder object via its .folder property setter (not an HTML attribute —
// attributes can't hold objects). Views communicate changes back by dispatching Custom Events.
//
// Open decision: the event detail shape for real folder-change events is not yet settled.
// Options: { path, changes } (path into tree + partial delta), or full new folder object, or changed subtree only.
// TestView uses a placeholder shape — finalise before building real views in step 5.

class TestView extends HTMLElement {
  set folder(value) { this._folder = value; this.render(); }
  render() {
    this.textContent = `Folder: ${this._folder?.name ?? '(none)'}`;
  }
  connectedCallback() {
    this.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('folder-change', {
        bubbles: true, detail: { path: [], changes: { touched: true } }
      }));
    });
  }
}
customElements.define('test-view', TestView);
