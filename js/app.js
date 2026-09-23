import {
  PRIORITIES, DONE_COLUMN_ID, STORAGE_KEY,
  createEmptyState, createSampleState, loadState, saveState, normalizeState, normalizeTags,
  tasksInColumn, getTask, isOverdue, isDueSoon, allTags, allAssignees, matchesFilter, getStats,
  addTask, updateTask, deleteTask, moveTask, addColumn, updateColumn, deleteColumn, isOverWip,
  todayISO,
} from './store.js';
import { ssoProviders, signIn, signOut, handleRedirect, currentSession } from './auth.js';

const storage = (() => {
  try { return window.localStorage; } catch { return null; }
})();

let state = createEmptyState();
// Who is signed in: { id, name, detail, avatarUrl, color, isOwner, canSignOut }
// or null when the app runs without sign-in.
let identity = null;
// Each signed-in person gets their own browser copy of their board.
let storageKey = STORAGE_KEY;
let filter = { query: '', priority: '', assignee: '', tag: '', due: '' };
let editingId = null;

const $ = (sel, root = document) => root.querySelector(sel);
const boardEl = $('#board');
const statsEl = $('#stats');
const dialog = $('#task-dialog');
const form = $('#task-form');

// Small DOM builder: h('div', { class: 'x', onclick }, child, 'text')
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// ---------- state ----------

function commit(next) {
  state = next;
  saveState(storage, state, storageKey);
  queueRemoteWrite();
  render();
}

// ---------- cloud sync ----------
// When the page runs inside a host that provides a shared document store
// (window.claude.use("db")), the board is kept in one document there so it
// follows the user across devices. Otherwise localStorage is the only store.

const claudeUse = (name) => (window.claude?.use
  ? window.claude.use(name).catch(() => null)
  : Promise.resolve(null));

const sync = { ref: null, writing: false, pending: false, readOnly: false };

function setSyncStatus(text, mode = '') {
  const el = $('#sync-status');
  el.textContent = text;
  el.dataset.mode = mode;
}

function queueRemoteWrite() {
  if (!sync.ref || sync.readOnly) return;
  sync.pending = true;
  if (!sync.writing) flushRemote();
}

// One write in flight at a time; a burst of edits collapses into a
// single write of the latest state.
async function flushRemote() {
  sync.writing = true;
  while (sync.pending) {
    sync.pending = false;
    setSyncStatus('Saving…', 'busy');
    try {
      await writeWithRetry(state);
      setSyncStatus('Synced', 'ok');
    } catch (err) {
      if (err?.code === 'invalid_argument') {
        sync.readOnly = true;
        setSyncStatus('Saved in this browser only', 'warn');
        toast('Changes can’t be saved to the shared board, so they stay in this browser.');
      } else if (err?.code === 'revoked') {
        sync.ref = null;
        setSyncStatus('Saved in this browser', '');
      } else {
        setSyncStatus('Not synced, saved in this browser', 'warn');
      }
      break;
    }
  }
  sync.writing = false;
}

async function writeWithRetry(data) {
  try {
    await sync.ref.set(data);
  } catch (err) {
    if (err?.code !== 'unavailable') throw err;
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
    await sync.ref.set(data);
  }
}

// Each person's board lives under their own data/users/<id>/ path, which
// the store keeps private to them (not even the page's owner can read it).
async function connectCloud() {
  if (!identity) return;
  const db = await claudeUse('db');
  if (!db) return;
  setSyncStatus('Connecting…', 'busy');
  sync.ref = db.doc(`data/users/${identity.id}/board`);
  let seeded = false;
  sync.ref.onSnapshot(async (snap) => {
    if (!snap.exists) {
      if (snap.metadata.fromCache || seeded) return;
      seeded = true;
      // First visit. The owner's board used to be shared at boards/main:
      // carry it over so their existing tasks aren't lost.
      if (identity.isOwner && state.tasks.length === 0) {
        try {
          const legacy = await db.doc('boards/main').get();
          if (legacy.exists) {
            state = normalizeState(legacy.data());
            saveState(storage, state, storageKey);
            render();
          }
        } catch { /* nothing to migrate */ }
      }
      queueRemoteWrite();
      return;
    }
    if (snap.metadata.hasPendingWrites || sync.writing || sync.pending) return;
    let incoming;
    try {
      incoming = normalizeState(snap.data());
    } catch {
      return;
    }
    setSyncStatus('Synced', 'ok');
    if (JSON.stringify(incoming) === JSON.stringify(state) || drag.active) return;
    state = incoming;
    saveState(storage, state, storageKey);
    render();
  }, () => {
    sync.ref = null;
    setSyncStatus('Not synced, saved in this browser', 'warn');
  });
}

// ---------- in-page prompt / confirm ----------

const askDialog = $('#ask-dialog');

// ask({ title, value }) resolves the entered text (or null if cancelled);
// ask({ title, message }) without a value resolves true/false.
function ask({ title, message = '', value = null, okLabel = 'OK', danger = false, inputType = 'text' }) {
  return new Promise((resolve) => {
    const input = $('#ask-input');
    const ok = $('#ask-ok');
    const isPrompt = value !== null;
    $('#ask-title').textContent = title;
    $('#ask-message').textContent = message;
    input.hidden = !isPrompt;
    input.type = inputType;
    input.value = isPrompt ? String(value) : '';
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (askDialog.open) askDialog.close();
      resolve(result);
    };
    $('#ask-form').onsubmit = (e) => {
      e.preventDefault();
      finish(isPrompt ? input.value : true);
    };
    $('#ask-cancel').onclick = () => finish(isPrompt ? null : false);
    askDialog.onclose = () => finish(isPrompt ? null : false);
    askDialog.showModal();
    if (isPrompt) {
      input.focus();
      input.select();
    } else {
      ok.focus();
    }
  });
}

// ---------- rendering ----------

function render() {
  const welcome = $('#welcome');
  welcome.hidden = !(identity && state.tasks.length === 0);
  if (!welcome.hidden) {
    $('#welcome-title').textContent = `Welcome, ${identity.name.split(/\s+/)[0]}`;
  }
  renderStats();
  renderFilters();
  renderBoard();
}

function renderStats() {
  const s = getStats(state);
  const inProgress = s.byColumn['in-progress'] ?? 0;
  const tile = (label, value, sub, mod = '') => h('div', { class: `stat ${mod}` },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    sub ? h('div', { class: 'stat-sub' }, sub) : null);

  const progress = h('div', { class: 'stat stat-wide' },
    h('div', { class: 'stat-label' }, 'Completion'),
    h('div', { class: 'stat-value' }, `${s.completion}%`),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': s.completion, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('div', { class: 'progress-fill', style: `width:${s.completion}%` })),
    h('div', { class: 'stat-sub' }, `${s.done} of ${s.total} tasks done`));

  const distribution = h('div', { class: 'stat stat-wide' },
    h('div', { class: 'stat-label' }, 'Workflow'),
    h('div', { class: 'distribution' },
      state.columns.map((c, i) => {
        const n = s.byColumn[c.id] ?? 0;
        return n ? h('span', {
          class: `seg seg-${i % 6}`,
          style: `flex:${n}`,
          title: `${c.title}: ${n}`,
        }) : null;
      })),
    h('div', { class: 'legend' },
      state.columns.map((c, i) => h('span', {},
        h('i', { class: `dot seg-${i % 6}` }), `${c.title} ${s.byColumn[c.id] ?? 0}`))));

  statsEl.replaceChildren(
    tile('Open tasks', s.open, `${s.total} total`),
    tile('In progress', inProgress, null),
    tile('Overdue', s.overdue, s.overdue ? 'needs attention' : 'all on track', s.overdue ? 'stat-alert' : ''),
    tile('Due soon', s.dueSoon, 'next 2 days', s.dueSoon ? 'stat-warn' : ''),
    progress,
    distribution,
  );
}

function fillSelect(select, placeholder, values, current) {
  select.replaceChildren(
    h('option', { value: '' }, placeholder),
    ...values.map((v) => h('option', { value: v, selected: v === current }, v)),
  );
  // Drop a stale filter value that no longer exists on the board.
  if (current && !values.includes(current)) {
    filter[select.id.replace('filter-', '')] = '';
  }
}

function renderFilters() {
  fillSelect($('#filter-assignee'), 'All assignees', allAssignees(state), filter.assignee);
  fillSelect($('#filter-tag'), 'All tags', allTags(state), filter.tag);
  $('#assignee-options').replaceChildren(...allAssignees(state).map((a) => h('option', { value: a })));
  const active = Object.values(filter).some(Boolean);
  $('#clear-filters').hidden = !active;
  boardEl.classList.toggle('is-filtered', active);
}

function renderBoard() {
  const scroll = boardEl.scrollLeft;
  // Keep focus (and any half-typed quick-add text) across re-renders,
  // which can be triggered by changes arriving from another device.
  const active = document.activeElement;
  const quick = active?.closest?.('.quick-add')
    ? { column: active.closest('.column').dataset.column, value: active.value, pos: active.selectionStart }
    : null;
  const focusedCard = active?.classList?.contains('card') ? active.dataset.id : null;

  boardEl.replaceChildren(...state.columns.map(renderColumn), renderAddColumn());
  boardEl.scrollLeft = scroll;

  if (quick) {
    const input = boardEl.querySelector(`.column[data-column="${CSS.escape(quick.column)}"] .quick-add input`);
    if (input) {
      input.value = quick.value;
      input.focus();
      input.setSelectionRange(quick.pos, quick.pos);
    }
  } else if (focusedCard) {
    boardEl.querySelector(`.card[data-id="${CSS.escape(focusedCard)}"]`)?.focus();
  }
}

function renderColumn(column, index) {
  const all = tasksInColumn(state, column.id);
  const visible = all.filter((t) => matchesFilter(t, filter));
  const overWip = isOverWip(state, column.id);
  const countText = visible.length === all.length ? `${all.length}` : `${visible.length}/${all.length}`;

  const list = h('div', { class: 'card-list', dataset: { column: column.id } },
    visible.map(renderCard),
    visible.length ? null : h('div', { class: 'empty' }, all.length ? 'No matching tasks' : 'No tasks yet'));

  return h('div', { class: `column accent-${index % 6}${overWip ? ' over-wip' : ''}`, dataset: { column: column.id } },
    h('div', { class: 'column-header' },
      h('h3', { class: 'column-title', title: 'Double-click to rename', ondblclick: () => renameColumn(column) }, column.title),
      h('span', { class: 'count', title: column.wipLimit ? `WIP limit ${column.wipLimit}` : 'Task count' },
        column.wipLimit ? `${countText} / ${column.wipLimit}` : countText),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'icon-btn btn-ghost small', 'aria-label': `Add task to ${column.title}`, title: 'Add task',
        onclick: () => openTaskDialog(null, column.id),
      }, '+'),
      h('button', {
        class: 'icon-btn btn-ghost small', 'aria-label': `${column.title} column options`, title: 'Column options',
        onclick: (e) => { e.stopPropagation(); openColumnMenu(e.currentTarget, column); },
      }, '⋯')),
    list,
    h('form', { class: 'quick-add', onsubmit: (e) => quickAdd(e, column.id) },
      h('input', { name: 'title', placeholder: '+ Add a task', 'aria-label': `Quick add to ${column.title}`, autocomplete: 'off', maxlength: 200 })));
}

function renderCard(task) {
  const overdue = isOverdue(task);
  const soon = isDueSoon(task);
  const done = task.status === DONE_COLUMN_ID;
  return h('article', {
    class: `card priority-${task.priority}${done ? ' is-done' : ''}`,
    tabindex: 0,
    dataset: { id: task.id },
    'aria-label': `${task.title}, ${task.priority} priority`,
    onkeydown: (e) => onCardKey(e, task),
  },
  h('div', { class: 'card-top' },
    h('span', { class: `badge badge-${task.priority}` }, task.priority),
    task.dueDate ? h('span', {
      class: `due${overdue ? ' due-overdue' : soon ? ' due-soon' : ''}`,
      title: overdue ? 'Overdue' : 'Due date',
    }, formatDue(task.dueDate)) : null),
  h('h4', { class: 'card-title' }, task.title),
  task.description ? h('p', { class: 'card-desc' }, task.description) : null,
  (task.tags.length || task.assignee) ? h('div', { class: 'card-bottom' },
    h('div', { class: 'tags' }, task.tags.map((t) => h('span', { class: 'tag', style: `--hue:${hue(t)}` }, t))),
    task.assignee ? h('span', { class: 'avatar', title: task.assignee, style: `--hue:${hue(task.assignee)}` }, initials(task.assignee)) : null) : null);
}

function renderAddColumn() {
  return h('button', { class: 'add-column', onclick: promptAddColumn }, '+ Add column');
}

function formatDue(iso) {
  const today = todayISO();
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((date - new Date(`${today}T00:00:00`)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const sameYear = y === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

function hue(text) {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

// ---------- task dialog ----------

function openTaskDialog(id = null, columnId = null) {
  const task = id ? getTask(state, id) : null;
  editingId = task?.id ?? null;
  form.reset();
  form.status.replaceChildren(...state.columns.map((c) => h('option', { value: c.id }, c.title)));
  form.title.value = task?.title ?? '';
  form.description.value = task?.description ?? '';
  form.status.value = task?.status ?? columnId ?? state.columns[0].id;
  form.priority.value = task?.priority ?? 'medium';
  form.dueDate.value = task?.dueDate ?? '';
  form.assignee.value = task?.assignee ?? '';
  form.tags.value = task?.tags.join(', ') ?? '';
  $('#task-dialog-title').textContent = task ? 'Edit task' : 'New task';
  $('#save-task-btn').textContent = task ? 'Save changes' : 'Create task';
  $('#delete-task-btn').hidden = !task;
  $('#task-meta').textContent = task
    ? `Created ${new Date(task.createdAt).toLocaleString()} · Updated ${new Date(task.updatedAt).toLocaleString()}`
      + (task.completedAt ? ` · Completed ${new Date(task.completedAt).toLocaleString()}` : '')
    : '';
  dialog.showModal();
  form.title.focus();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const fields = {
    title: form.title.value.trim(),
    description: form.description.value.trim(),
    status: form.status.value,
    priority: PRIORITIES.includes(form.priority.value) ? form.priority.value : 'medium',
    dueDate: form.dueDate.value,
    assignee: form.assignee.value.trim(),
    tags: normalizeTags(form.tags.value),
  };
  if (!fields.title) {
    form.title.focus();
    return;
  }
  commit(editingId ? updateTask(state, editingId, fields) : addTask(state, fields));
  toast(editingId ? 'Task updated' : 'Task created');
  dialog.close();
});

dialog.addEventListener('click', (e) => {
  if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
});

$('#delete-task-btn').addEventListener('click', () => {
  if (!editingId) return;
  removeTask(editingId);
  dialog.close();
});

function removeTask(id) {
  const before = state;
  const task = getTask(state, id);
  commit(deleteTask(state, id));
  toast(`Deleted “${task.title}”`, { label: 'Undo', run: () => commit(before) });
}

function quickAdd(e, columnId) {
  e.preventDefault();
  const input = e.currentTarget.elements.title;
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  commit(addTask(state, { title, status: columnId }));
}

// Keyboard support for cards: Enter to edit, Delete to remove,
// Alt+←/→ to move between columns, Alt+↑/↓ to reorder.
function onCardKey(e, task) {
  if (e.key === 'Enter') {
    openTaskDialog(task.id);
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeTask(task.id);
    return;
  }
  if (!e.altKey) return;
  const colIndex = state.columns.findIndex((c) => c.id === task.status);
  const siblings = tasksInColumn(state, task.status);
  const pos = siblings.findIndex((t) => t.id === task.id);
  let next = null;
  if (e.key === 'ArrowLeft' && colIndex > 0) next = moveTask(state, task.id, state.columns[colIndex - 1].id);
  if (e.key === 'ArrowRight' && colIndex < state.columns.length - 1) next = moveTask(state, task.id, state.columns[colIndex + 1].id);
  if (e.key === 'ArrowUp' && pos > 0) next = moveTask(state, task.id, task.status, pos - 1);
  if (e.key === 'ArrowDown' && pos < siblings.length - 1) next = moveTask(state, task.id, task.status, pos + 1);
  if (next) {
    e.preventDefault();
    commit(next);
    boardEl.querySelector(`.card[data-id="${CSS.escape(task.id)}"]`)?.focus();
  }
}

// ---------- columns ----------

async function promptAddColumn() {
  const title = await ask({ title: 'Add column', message: 'New columns are placed before Done.', value: '', okLabel: 'Add column' });
  if (title?.trim()) commit(addColumn(state, title));
}

async function renameColumn(column) {
  const title = await ask({ title: 'Rename column', value: column.title, okLabel: 'Rename' });
  if (title?.trim()) commit(updateColumn(state, column.id, { title }));
}

function openColumnMenu(anchor, column) {
  closePopups();
  const items = [
    ['Rename', () => renameColumn(column)],
    ['Set WIP limit…', async () => {
      const value = await ask({
        title: `WIP limit for ${column.title}`,
        message: 'Maximum number of tasks in this column. Use 0 for no limit.',
        value: String(column.wipLimit || 0),
        inputType: 'number',
        okLabel: 'Save',
      });
      if (value !== null) commit(updateColumn(state, column.id, { wipLimit: value }));
    }],
  ];
  if (column.id !== DONE_COLUMN_ID && state.columns.length > 1) {
    items.push(['Delete column', async () => {
      const n = tasksInColumn(state, column.id).length;
      const fallback = state.columns.find((c) => c.id !== column.id).title;
      const ok = await ask({
        title: `Delete “${column.title}”?`,
        message: n ? `Its ${n} task(s) will move to “${fallback}”.` : 'This column has no tasks.',
        okLabel: 'Delete column',
        danger: true,
      });
      if (!ok) return;
      const before = state;
      commit(deleteColumn(state, column.id));
      toast(`Deleted column “${column.title}”`, { label: 'Undo', run: () => commit(before) });
    }, 'danger']);
  }
  const menu = h('div', { class: 'menu-list popup', role: 'menu' },
    items.map(([label, run, cls]) => h('button', {
      role: 'menuitem', class: cls,
      onclick: () => { closePopups(); run(); },
    }, label)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + window.scrollX}px`;
  menu.querySelector('button')?.focus();
}

function closePopups() {
  document.querySelectorAll('.popup').forEach((p) => p.remove());
  $('#menu-list').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  $('#account-menu').hidden = true;
  $('#account-btn').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.popup, .menu')) closePopups();
});

// ---------- drag & drop (pointer events: mouse, pen and touch) ----------

const drag = {
  pending: null, // { card, id, startX, startY, pointerId, timer }
  active: null, // { card, id, ghost, placeholder, offsetX, offsetY }
};

boardEl.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  if (!card || e.button !== 0) return;
  const pending = { card, id: card.dataset.id, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, ready: e.pointerType !== 'touch' };
  // On touch, require a short press so normal swipes still scroll the board.
  if (e.pointerType === 'touch') {
    pending.timer = setTimeout(() => {
      pending.ready = true;
      startDrag(pending, pending.startX, pending.startY);
    }, 250);
  }
  drag.pending = pending;
});

window.addEventListener('pointermove', (e) => {
  const p = drag.pending;
  if (p && !drag.active && e.pointerId === p.pointerId) {
    const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
    if (!p.ready && moved > 8) {
      // Touch moved before the long-press fired: treat it as a scroll.
      clearTimeout(p.timer);
      drag.pending = null;
      return;
    }
    if (p.ready && moved > 5) startDrag(p, e.clientX, e.clientY);
  }
  if (drag.active) {
    e.preventDefault();
    updateDrag(e.clientX, e.clientY);
  }
});

// Needed so a touch drag doesn't also scroll the page.
window.addEventListener('touchmove', (e) => {
  if (drag.active) e.preventDefault();
}, { passive: false });

window.addEventListener('pointerup', (e) => {
  const p = drag.pending;
  if (drag.active) {
    finishDrag(true);
  } else if (p && e.pointerId === p.pointerId && e.target.closest('.card') === p.card) {
    // A click (no drag) opens the task.
    clearTimeout(p.timer);
    openTaskDialog(p.id);
  }
  if (p) clearTimeout(p.timer);
  drag.pending = null;
});

window.addEventListener('pointercancel', () => {
  if (drag.pending) clearTimeout(drag.pending.timer);
  drag.pending = null;
  if (drag.active) finishDrag(false);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drag.active) finishDrag(false);
});

function startDrag(p, x, y) {
  if (drag.active || !p.card.isConnected) return;
  const rect = p.card.getBoundingClientRect();
  const ghost = p.card.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);

  const placeholder = h('div', { class: 'drop-placeholder' });
  placeholder.style.height = `${rect.height}px`;
  p.card.after(placeholder);
  p.card.classList.add('is-dragging');

  drag.active = { card: p.card, id: p.id, ghost, placeholder, offsetX: x - rect.left, offsetY: y - rect.top, x, y };
  document.body.classList.add('dragging');
  if (navigator.vibrate) navigator.vibrate(10);
  updateDrag(x, y);
  autoScroll();
}

function updateDrag(x, y) {
  const a = drag.active;
  a.x = x;
  a.y = y;
  a.ghost.style.transform = `translate(${x - a.offsetX}px, ${y - a.offsetY}px) rotate(2deg)`;

  const under = document.elementFromPoint(x, y);
  const column = under?.closest('.column');
  if (!column) return;
  const list = column.querySelector('.card-list');
  const cards = [...list.querySelectorAll('.card:not(.is-dragging)')];
  const before = cards.find((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  list.querySelector('.empty')?.remove();
  if (before) before.before(a.placeholder);
  else list.append(a.placeholder);
}

function finishDrag(drop) {
  const a = drag.active;
  drag.active = null;
  document.body.classList.remove('dragging');
  a.ghost.remove();

  if (drop && a.placeholder.isConnected) {
    const list = a.placeholder.closest('.card-list');
    const columnId = list.dataset.column;
    // Translate the visible position into an index in the full column,
    // since filters may be hiding some cards.
    const full = tasksInColumn(state, columnId).filter((t) => t.id !== a.id).map((t) => t.id);
    const nextCard = nextMatching(a.placeholder, '.card:not(.is-dragging)');
    let index = full.length;
    if (nextCard) index = full.indexOf(nextCard.dataset.id);
    const task = getTask(state, a.id);
    const columnTitle = state.columns.find((c) => c.id === columnId)?.title;
    a.placeholder.remove();
    const next = moveTask(state, a.id, columnId, index === -1 ? full.length : index);
    commit(next);
    if (task && task.status !== columnId) toast(`Moved to ${columnTitle}`);
  } else {
    a.placeholder.remove();
    render();
  }
}

function nextMatching(el, selector) {
  let n = el.nextElementSibling;
  while (n && !n.matches(selector)) n = n.nextElementSibling;
  return n;
}

// Scroll the board / page while dragging near an edge.
function autoScroll() {
  const a = drag.active;
  if (!a) return;
  const edge = 60;
  const speed = 14;
  const r = boardEl.getBoundingClientRect();
  if (a.x < r.left + edge) boardEl.scrollLeft -= speed;
  else if (a.x > r.right - edge) boardEl.scrollLeft += speed;
  if (a.y < edge) window.scrollBy(0, -speed);
  else if (a.y > window.innerHeight - edge) window.scrollBy(0, speed);
  updateDrag(a.x, a.y);
  requestAnimationFrame(autoScroll);
}

// ---------- toolbar & menu ----------

$('#new-task-btn').addEventListener('click', () => openTaskDialog());

$('#search').addEventListener('input', (e) => {
  filter.query = e.target.value;
  render();
});

for (const key of ['priority', 'assignee', 'tag', 'due']) {
  $(`#filter-${key}`).addEventListener('change', (e) => {
    filter[key] = e.target.value;
    render();
  });
}

$('#clear-filters').addEventListener('click', () => {
  filter = { query: '', priority: '', assignee: '', tag: '', due: '' };
  $('#search').value = '';
  $('#filter-priority').value = '';
  $('#filter-due').value = '';
  render();
});

$('#menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const list = $('#menu-list');
  const open = list.hidden;
  closePopups();
  list.hidden = !open;
  $('#menu-btn').setAttribute('aria-expanded', String(open));
});

$('#menu-list').addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  closePopups();
  menuActions[action]?.();
});

const menuActions = {
  'add-column': promptAddColumn,
  async export() {
    const json = JSON.stringify(state, null, 2);
    const filename = `taskflow-board-${todayISO()}.json`;
    const downloads = await claudeUse('downloads');
    if (downloads) {
      try {
        await downloads.save({ filename, data: json });
        toast('Board exported');
      } catch (err) {
        if (err?.code !== 'declined') toast(`Export failed: ${err?.message ?? 'unknown error'}`);
      }
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  import() {
    $('#import-input').click();
  },
  async sample() {
    if (state.tasks.length && !await ask({
      title: 'Load sample data?',
      message: 'This replaces the tasks and columns on your board. You can undo it right after.',
      okLabel: 'Replace board',
      danger: true,
    })) return;
    const before = state;
    commit(createSampleState());
    toast('Sample data loaded', { label: 'Undo', run: () => commit(before) });
  },
  'clear-done': () => {
    const n = tasksInColumn(state, DONE_COLUMN_ID).length;
    if (!n) return toast('No completed tasks to clear');
    const before = state;
    commit({ ...state, tasks: state.tasks.filter((t) => t.status !== DONE_COLUMN_ID) });
    toast(`Cleared ${n} completed task(s)`, { label: 'Undo', run: () => commit(before) });
  },
  async reset() {
    if (!await ask({
      title: 'Delete all tasks?',
      message: 'Every task is removed and the columns are reset. You can undo it right after.',
      okLabel: 'Delete all',
      danger: true,
    })) return;
    const before = state;
    commit(createEmptyState());
    toast('Board cleared', { label: 'Undo', run: () => commit(before) });
  },
};

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const imported = normalizeState(JSON.parse(await file.text()));
    const before = state;
    commit(imported);
    toast(`Imported ${imported.tasks.length} task(s)`, { label: 'Undo', run: () => commit(before) });
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
});

// ---------- theme ----------

$('#theme-btn').addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme
    ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('taskflow.theme', next); } catch { /* ignore */ }
});

// ---------- global shortcuts ----------

document.addEventListener('keydown', (e) => {
  if (document.body.dataset.view !== 'app') return;
  if (dialog.open || askDialog.open || e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if (e.key === 'Escape') closePopups();
  if (typing) return;
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    openTaskDialog();
  } else if (e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  }
});

// Keep "Today"/"Overdue" labels correct if the tab stays open past midnight.
let renderedDay = todayISO();
setInterval(() => {
  if (todayISO() !== renderedDay && !drag.active) {
    renderedDay = todayISO();
    render();
  }
}, 60000);

// Sync changes made in another tab.
window.addEventListener('storage', (e) => {
  if (e.storageArea !== storage || e.key !== storageKey) return;
  const next = loadState(storage, storageKey);
  if (next && !drag.active) {
    state = next;
    render();
  }
});

// ---------- toast ----------

let toastTimer;
function toast(message, action) {
  const el = $('#toast');
  el.replaceChildren(h('span', {}, message));
  if (action) {
    el.append(h('button', {
      class: 'toast-action',
      onclick: () => { action.run(); el.classList.remove('show'); },
    }, action.label));
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2500);
}

// ---------- account & start-up ----------

function renderAccount() {
  const account = $('#account');
  account.hidden = !identity;
  if (!identity) return;
  const avatar = $('#account-avatar');
  if (identity.avatarUrl) {
    avatar.replaceChildren(h('img', { src: identity.avatarUrl, alt: '' }));
  } else {
    avatar.replaceChildren(initials(identity.name) || '?');
  }
  avatar.style.setProperty('--avatar-bg', identity.color || `hsl(${hue(identity.name)} 55% 45%)`);
  $('#account-name').textContent = identity.name;
  $('#account-btn').setAttribute('aria-label', `Account: ${identity.name}`);
  $('#account-btn').title = identity.name;
  $('#account-menu-name').textContent = identity.name;
  $('#account-menu-detail').textContent = identity.detail;
  $('#sign-out-btn').hidden = !identity.canSignOut;
}

$('#account-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#account-menu');
  const open = menu.hidden;
  closePopups();
  menu.hidden = !open;
  $('#account-btn').setAttribute('aria-expanded', String(open));
});

$('#sign-out-btn').addEventListener('click', () => signOut());

$('#welcome-sample').addEventListener('click', () => commit(createSampleState()));

function showSignIn(error = '') {
  document.body.dataset.view = 'signin';
  $('#signin-options').replaceChildren(...ssoProviders().map((p) => h('button', {
    class: 'btn',
    onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      button.textContent = `Redirecting to ${p.label ?? p.id}…`;
      try {
        await signIn(p.id);
      } catch (err) {
        button.disabled = false;
        button.textContent = `Continue with ${p.label ?? p.id}`;
        showSignInError(err.message);
      }
    },
  }, `Continue with ${p.label ?? p.id}`)));
  showSignInError(error);
}

function showSignInError(message) {
  const el = $('#signin-error');
  el.textContent = message;
  el.hidden = !message;
}

// Works out who is using the app, then loads that person's board.
// - Hosted on claude.ai: the viewer's claude.ai account (their company SSO
//   when their organization uses one). Boards sync through the page's db.
// - Self-hosted with SSO_PROVIDERS configured: OpenID Connect sign-in.
// - Otherwise: no sign-in, one board per browser.
async function boot() {
  const hosted = Boolean(window.claude?.use);
  if (!hosted && ssoProviders().length) {
    let session;
    try {
      session = (await handleRedirect()) ?? currentSession();
    } catch (err) {
      showSignIn(err.message);
      return;
    }
    if (!session) {
      showSignIn();
      return;
    }
    identity = {
      id: `${session.providerId}:${session.sub}`,
      name: session.name,
      detail: [session.email, `Signed in with ${session.providerLabel}`].filter(Boolean).join(' · '),
      avatarUrl: null,
      color: null,
      isOwner: false,
      canSignOut: true,
    };
  } else if (hosted) {
    const user = await claudeUse('user');
    const me = user ? await user.me() : null;
    if (me?.id) {
      identity = {
        id: me.id,
        name: me.name || 'You',
        detail: 'Signed in with your Claude account',
        avatarUrl: me.avatarUrl,
        color: me.color,
        isOwner: me.isOwner,
        canSignOut: false,
      };
    }
  }

  storageKey = identity ? `${STORAGE_KEY}:${identity.id}` : STORAGE_KEY;
  state = loadState(storage, storageKey) ?? (identity ? createEmptyState() : createSampleState());
  saveState(storage, state, storageKey);
  document.body.dataset.view = 'app';
  renderAccount();
  render();
  if (hosted) connectCloud();
}

boot();
