'use strict';
// board.js — Board tab shim. Implementation lives in kanban.js (Workstream H,
// loaded via index.html) and exposes window.KanbanBoard. This keeps the
// bootstrap module-loader contract (MODULES.board.render) without duplicating code.
MODULES.board = {
  render(el) {
    if (window.KanbanBoard && typeof window.KanbanBoard.render === 'function') return window.KanbanBoard.render(el);
    el.innerHTML = '<div class="card muted">kanban module failed to load (kanban.js)</div>';
  },
};
