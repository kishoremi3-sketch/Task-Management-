// Pure state logic for the task board. No DOM access here, so it can be
// unit-tested in Node and reused by the UI layer.

export const STORAGE_KEY = 'taskflow.board.v1';

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// A task's type; '' means no type.
export const TASK_TYPES = ['project', 'enhancement', 'defect'];
export const TASK_TYPE_LABELS = { project: 'Project', enhancement: 'Enhancement', defect: 'Defect' };

export const DEFAULT_COLUMNS = [
  { id: 'backlog', title: 'Backlog', wipLimit: 0 },
  { id: 'todo', title: 'To Do', wipLimit: 0 },
  { id: 'in-progress', title: 'In Progress', wipLimit: 3 },
  { id: 'review', title: 'Review', wipLimit: 0 },
  { id: 'done', title: 'Done', wipLimit: 0 },
];

export const DONE_COLUMN_ID = 'done';

export function uid(prefix = 't') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function todayISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return todayISO(new Date(y, m - 1, d + days));
}

export function createEmptyState() {
  return {
    version: 1,
    columns: DEFAULT_COLUMNS.map((c) => ({ ...c })),
    tasks: [],
  };
}

export function createSampleState(today = todayISO()) {
  let state = createEmptyState();
  const samples = [
    ['backlog', 'Research competitor pricing', 'Collect pricing pages for the top 5 competitors.', 'low', 12, ['research'], 'Alex', 'project'],
    ['backlog', 'Plan Q4 roadmap', '', 'medium', 20, ['planning'], '', 'project'],
    ['todo', 'Write onboarding email copy', 'Three-email sequence for new sign-ups.', 'medium', 4, ['marketing'], 'Sam', 'enhancement'],
    ['todo', 'Fix login redirect bug', 'Users land on /404 after logging in from a deep link.', 'urgent', -1, ['frontend'], 'Jordan', 'defect'],
    ['in-progress', 'Design settings page', 'Include profile, notifications and billing tabs.', 'high', 2, ['design'], 'Taylor', 'enhancement'],
    ['in-progress', 'Set up CI pipeline', 'Run lint and tests on every pull request.', 'medium', 5, ['devops'], 'Jordan', 'project'],
    ['review', 'API rate limiting', 'Token bucket, 100 req/min per key.', 'high', 1, ['backend'], 'Alex', 'enhancement'],
    ['done', 'Create project repository', '', 'low', -3, ['devops'], 'Sam', 'project'],
  ];
  for (const [status, title, description, priority, dueOffset, tags, assignee, type] of samples) {
    state = addTask(state, {
      status, title, description, priority, tags, assignee, type,
      dueDate: addDays(today, dueOffset),
    });
  }
  return state;
}

// ---------- persistence ----------

// `key` lets each signed-in user keep a separate board in the same browser.
export function loadState(storage, key = STORAGE_KEY) {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    return normalizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveState(storage, state, key = STORAGE_KEY) {
  try {
    storage?.setItem(key, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

// Validates and repairs a state object (e.g. from an imported file).
// Throws if the input is not recognisably a board.
export function normalizeState(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.tasks)) {
    throw new Error('Invalid board data: missing "tasks" array.');
  }
  const columns = Array.isArray(input.columns) && input.columns.length
    ? input.columns
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => ({
        id: c.id,
        title: String(c.title ?? c.id),
        wipLimit: Math.max(0, Number(c.wipLimit) || 0),
      }))
    : createEmptyState().columns;
  const columnIds = new Set(columns.map((c) => c.id));
  const tasks = input.tasks
    .filter((t) => t && typeof t.title === 'string')
    .map((t) => normalizeTask(t, columnIds.has(t.status) ? t.status : columns[0].id));
  return { version: 1, columns, tasks: reindex(tasks, columns) };
}

function normalizeTask(t, status) {
  const now = new Date().toISOString();
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    title: t.title.trim() || 'Untitled task',
    description: String(t.description ?? ''),
    status,
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
    type: TASK_TYPES.includes(t.type) ? t.type : '',
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate ?? '') ? t.dueDate : '',
    tags: normalizeTags(t.tags),
    // assigneeId is a person's account id (hosted on claude.ai); assignee
    // is a free-text name, used when accounts aren't available.
    assigneeId: String(t.assigneeId ?? '').trim(),
    assignee: String(t.assignee ?? '').trim(),
    order: Number.isFinite(t.order) ? t.order : 0,
    createdAt: t.createdAt || now,
    updatedAt: t.updatedAt || now,
    completedAt: t.completedAt || null,
  };
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw).trim().toLowerCase();
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

// Rewrites `order` so each column's tasks are numbered 0..n-1.
function reindex(tasks, columns) {
  const byColumn = new Map(columns.map((c) => [c.id, []]));
  for (const t of tasks) byColumn.get(t.status)?.push(t);
  const out = [];
  for (const list of byColumn.values()) {
    list.sort((a, b) => a.order - b.order);
    list.forEach((t, i) => out.push({ ...t, order: i }));
  }
  return out;
}

// ---------- queries ----------

export function tasksInColumn(state, columnId) {
  return state.tasks
    .filter((t) => t.status === columnId)
    .sort((a, b) => a.order - b.order);
}

export function getTask(state, id) {
  return state.tasks.find((t) => t.id === id) ?? null;
}

export function isOverdue(task, today = todayISO()) {
  return Boolean(task.dueDate) && task.status !== DONE_COLUMN_ID && task.dueDate < today;
}

export function isDueSoon(task, today = todayISO(), days = 2) {
  return Boolean(task.dueDate)
    && task.status !== DONE_COLUMN_ID
    && task.dueDate >= today
    && task.dueDate <= addDays(today, days);
}

export function allTags(state) {
  return [...new Set(state.tasks.flatMap((t) => t.tags))].sort();
}

// One key per assignee: "id:<account id>" or "name:<free text>".
export function assigneeKey(task) {
  if (task.assigneeId) return `id:${task.assigneeId}`;
  if (task.assignee) return `name:${task.assignee}`;
  return '';
}

export function allAssigneeKeys(state) {
  return [...new Set(state.tasks.map(assigneeKey).filter(Boolean))];
}

// Open (not done) task counts per assignee key; '' counts unassigned.
export function workload(state) {
  const counts = new Map();
  for (const t of state.tasks) {
    if (t.status === DONE_COLUMN_ID) continue;
    const key = assigneeKey(t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// filter.assignee: '' (anyone), 'me', 'none', or an assigneeKey.
// people.meKeys lists the keys that mean "me"; people.nameOf(task) gives
// the assignee's display name so search can match it.
export function matchesFilter(task, filter = {}, today = todayISO(), people = {}) {
  const { query = '', priority = '', type = '', tag = '', assignee = '', due = '' } = filter;
  const { meKeys = [], nameOf = (t) => t.assignee } = people;
  if (priority && task.priority !== priority) return false;
  if (type === 'none' && task.type) return false;
  if (type && type !== 'none' && task.type !== type) return false;
  if (tag && !task.tags.includes(tag)) return false;
  const key = assigneeKey(task);
  if (assignee === 'none' && key) return false;
  if (assignee === 'me' && !meKeys.includes(key)) return false;
  if (assignee && assignee !== 'none' && assignee !== 'me' && key !== assignee) return false;
  if (due === 'overdue' && !isOverdue(task, today)) return false;
  if (due === 'soon' && !isDueSoon(task, today)) return false;
  if (due === 'none' && task.dueDate) return false;
  const q = query.trim().toLowerCase();
  if (q) {
    const haystack = [task.title, task.description, nameOf(task), TASK_TYPE_LABELS[task.type] ?? '', ...task.tags]
      .join(' ').toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export function getStats(state, today = todayISO()) {
  const total = state.tasks.length;
  const done = state.tasks.filter((t) => t.status === DONE_COLUMN_ID).length;
  const overdue = state.tasks.filter((t) => isOverdue(t, today)).length;
  const dueSoon = state.tasks.filter((t) => isDueSoon(t, today)).length;
  const byColumn = Object.fromEntries(
    state.columns.map((c) => [c.id, state.tasks.filter((t) => t.status === c.id).length]),
  );
  const byType = Object.fromEntries(
    TASK_TYPES.map((k) => [k, state.tasks.filter((t) => t.type === k && t.status !== DONE_COLUMN_ID).length]),
  );
  const byPriority = Object.fromEntries(
    PRIORITIES.map((p) => [p, state.tasks.filter((t) => t.priority === p && t.status !== DONE_COLUMN_ID).length]),
  );
  return {
    total,
    done,
    open: total - done,
    overdue,
    dueSoon,
    completion: total ? Math.round((done / total) * 100) : 0,
    byColumn,
    byPriority,
    byType,
  };
}

// ---------- task mutations (return a new state) ----------

export function addTask(state, fields) {
  const status = state.columns.some((c) => c.id === fields.status) ? fields.status : state.columns[0].id;
  const now = new Date().toISOString();
  const task = normalizeTask({
    ...fields,
    id: uid(),
    order: tasksInColumn(state, status).length,
    createdAt: now,
    updatedAt: now,
    completedAt: status === DONE_COLUMN_ID ? now : null,
  }, status);
  return { ...state, tasks: [...state.tasks, task] };
}

export function updateTask(state, id, fields) {
  const existing = getTask(state, id);
  if (!existing) return state;
  const { status, ...rest } = fields;
  let next = {
    ...state,
    tasks: state.tasks.map((t) => (t.id === id
      ? normalizeTask({ ...t, ...rest, id, updatedAt: new Date().toISOString() }, t.status)
      : t)),
  };
  if (status && status !== existing.status) {
    next = moveTask(next, id, status, tasksInColumn(next, status).length);
  }
  return next;
}

export function deleteTask(state, id) {
  const task = getTask(state, id);
  if (!task) return state;
  return { ...state, tasks: reindex(state.tasks.filter((t) => t.id !== id), state.columns) };
}

// Moves a task to `toColumn` at position `toIndex` (index among that
// column's tasks *excluding* the moved task).
export function moveTask(state, id, toColumn, toIndex = Infinity) {
  const task = getTask(state, id);
  if (!task || !state.columns.some((c) => c.id === toColumn)) return state;

  const target = tasksInColumn(state, toColumn).filter((t) => t.id !== id);
  const index = Math.max(0, Math.min(toIndex, target.length));
  const now = new Date().toISOString();
  const statusChanged = task.status !== toColumn;
  const moved = {
    ...task,
    status: toColumn,
    updatedAt: statusChanged ? now : task.updatedAt,
    completedAt: toColumn === DONE_COLUMN_ID ? (task.completedAt ?? now) : null,
  };
  target.splice(index, 0, moved);
  const newOrder = new Map(target.map((t, i) => [t.id, i]));

  const tasks = state.tasks.map((t) => {
    if (t.id === id) return { ...moved, order: newOrder.get(id) };
    if (newOrder.has(t.id)) return { ...t, order: newOrder.get(t.id) };
    return t;
  });
  return { ...state, tasks: reindex(tasks, state.columns) };
}

// ---------- column mutations ----------

export function addColumn(state, title) {
  const clean = String(title ?? '').trim();
  if (!clean) return state;
  const column = { id: uid('c'), title: clean, wipLimit: 0 };
  // Keep "Done" as the last column so it stays the terminal state.
  const doneIndex = state.columns.findIndex((c) => c.id === DONE_COLUMN_ID);
  const columns = [...state.columns];
  columns.splice(doneIndex === -1 ? columns.length : doneIndex, 0, column);
  return { ...state, columns };
}

export function updateColumn(state, id, fields) {
  return {
    ...state,
    columns: state.columns.map((c) => (c.id === id
      ? {
        ...c,
        title: fields.title !== undefined ? (String(fields.title).trim() || c.title) : c.title,
        wipLimit: fields.wipLimit !== undefined ? Math.max(0, Number(fields.wipLimit) || 0) : c.wipLimit,
      }
      : c)),
  };
}

// Removes a column; its tasks move to the first remaining column.
// The last column and the Done column cannot be removed.
export function deleteColumn(state, id) {
  if (id === DONE_COLUMN_ID || state.columns.length <= 1) return state;
  const columns = state.columns.filter((c) => c.id !== id);
  if (columns.length === state.columns.length) return state;
  const fallback = columns[0].id;
  const offset = tasksInColumn(state, fallback).length;
  const tasks = state.tasks.map((t) => (t.status === id ? { ...t, status: fallback, order: offset + t.order } : t));
  return { ...state, columns, tasks: reindex(tasks, columns) };
}

export function isOverWip(state, columnId) {
  const column = state.columns.find((c) => c.id === columnId);
  return Boolean(column?.wipLimit) && tasksInColumn(state, columnId).length > column.wipLimit;
}
