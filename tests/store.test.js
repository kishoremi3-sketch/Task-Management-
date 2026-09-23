import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyState, createSampleState, addTask, updateTask, deleteTask, moveTask,
  tasksInColumn, getTask, isOverdue, isDueSoon, matchesFilter, getStats,
  addColumn, updateColumn, deleteColumn, isOverWip, normalizeState, normalizeTags,
  loadState, saveState, STORAGE_KEY, assigneeKey, allAssigneeKeys, workload,
} from '../js/store.js';

const titles = (state, col) => tasksInColumn(state, col).map((t) => t.title);

function board(...entries) {
  let s = createEmptyState();
  for (const [status, title, extra = {}] of entries) s = addTask(s, { status, title, ...extra });
  return s;
}

test('addTask appends to the column and defaults invalid fields', () => {
  let s = board(['todo', 'A'], ['todo', 'B']);
  assert.deepEqual(titles(s, 'todo'), ['A', 'B']);
  s = addTask(s, { title: 'C', status: 'nope', priority: 'bogus', dueDate: 'tomorrow', tags: 'X, y,x' });
  const c = s.tasks.find((t) => t.title === 'C');
  assert.equal(c.status, 'backlog');
  assert.equal(c.priority, 'medium');
  assert.equal(c.dueDate, '');
  assert.deepEqual(c.tags, ['x', 'y']);
});

test('addTask does not mutate the previous state', () => {
  const s0 = createEmptyState();
  const s1 = addTask(s0, { title: 'A', status: 'todo' });
  assert.equal(s0.tasks.length, 0);
  assert.equal(s1.tasks.length, 1);
});

test('moveTask reorders within a column', () => {
  let s = board(['todo', 'A'], ['todo', 'B'], ['todo', 'C']);
  const c = s.tasks.find((t) => t.title === 'C');
  s = moveTask(s, c.id, 'todo', 0);
  assert.deepEqual(titles(s, 'todo'), ['C', 'A', 'B']);
  const a = s.tasks.find((t) => t.title === 'A');
  s = moveTask(s, a.id, 'todo', 99);
  assert.deepEqual(titles(s, 'todo'), ['C', 'B', 'A']);
});

test('moveTask across columns keeps both columns densely ordered', () => {
  let s = board(['todo', 'A'], ['todo', 'B'], ['done', 'X']);
  const a = s.tasks.find((t) => t.title === 'A');
  s = moveTask(s, a.id, 'done', 0);
  assert.deepEqual(titles(s, 'todo'), ['B']);
  assert.deepEqual(titles(s, 'done'), ['A', 'X']);
  for (const col of ['todo', 'done']) {
    assert.deepEqual(tasksInColumn(s, col).map((t) => t.order), tasksInColumn(s, col).map((_, i) => i));
  }
});

test('moving into and out of Done sets and clears completedAt', () => {
  let s = board(['todo', 'A']);
  const id = s.tasks[0].id;
  s = moveTask(s, id, 'done');
  assert.ok(getTask(s, id).completedAt);
  s = moveTask(s, id, 'review');
  assert.equal(getTask(s, id).completedAt, null);
});

test('moveTask ignores unknown tasks and columns', () => {
  const s = board(['todo', 'A']);
  assert.equal(moveTask(s, 'missing', 'done'), s);
  assert.equal(moveTask(s, s.tasks[0].id, 'missing'), s);
});

test('updateTask edits fields and moves when status changes', () => {
  let s = board(['todo', 'A'], ['review', 'R']);
  const id = s.tasks[0].id;
  s = updateTask(s, id, { title: 'A2', priority: 'urgent', status: 'review' });
  const t = getTask(s, id);
  assert.equal(t.title, 'A2');
  assert.equal(t.priority, 'urgent');
  assert.deepEqual(titles(s, 'review'), ['R', 'A2']);
  assert.deepEqual(titles(s, 'todo'), []);
});

test('deleteTask removes and reindexes', () => {
  let s = board(['todo', 'A'], ['todo', 'B'], ['todo', 'C']);
  s = deleteTask(s, s.tasks.find((t) => t.title === 'B').id);
  assert.deepEqual(tasksInColumn(s, 'todo').map((t) => [t.title, t.order]), [['A', 0], ['C', 1]]);
});

test('overdue and due-soon ignore completed tasks', () => {
  const today = '2026-09-23';
  assert.equal(isOverdue({ dueDate: '2026-09-22', status: 'todo' }, today), true);
  assert.equal(isOverdue({ dueDate: '2026-09-22', status: 'done' }, today), false);
  assert.equal(isOverdue({ dueDate: '2026-09-23', status: 'todo' }, today), false);
  assert.equal(isOverdue({ dueDate: '', status: 'todo' }, today), false);
  assert.equal(isDueSoon({ dueDate: '2026-09-25', status: 'todo' }, today), true);
  assert.equal(isDueSoon({ dueDate: '2026-09-26', status: 'todo' }, today), false);
  assert.equal(isDueSoon({ dueDate: '2026-09-30', status: 'todo' }, '2026-09-28'), true, 'crosses month boundary');
});

test('matchesFilter combines query, priority, tag, assignee and due', () => {
  const task = {
    title: 'Fix login bug', description: 'redirect loop', status: 'todo',
    priority: 'high', tags: ['bug'], assignee: 'Sam', dueDate: '2026-09-01',
  };
  const today = '2026-09-23';
  assert.equal(matchesFilter(task, {}, today), true);
  assert.equal(matchesFilter(task, { query: 'REDIRECT' }, today), true);
  assert.equal(matchesFilter(task, { query: 'sam' }, today), true);
  assert.equal(matchesFilter(task, { query: 'nope' }, today), false);
  assert.equal(matchesFilter(task, { priority: 'low' }, today), false);
  assert.equal(matchesFilter(task, { tag: 'bug', assignee: 'name:Sam', due: 'overdue' }, today), true);
  assert.equal(matchesFilter(task, { due: 'none' }, today), false);
});

test('assignee filters understand accounts, names, me and unassigned', () => {
  const today = '2026-09-23';
  const base = { title: 'T', description: '', status: 'todo', priority: 'low', tags: [], dueDate: '' };
  const byId = { ...base, assigneeId: 'u_1', assignee: '' };
  const byName = { ...base, assigneeId: '', assignee: 'Sam' };
  const nobody = { ...base, assigneeId: '', assignee: '' };
  assert.equal(assigneeKey(byId), 'id:u_1');
  assert.equal(assigneeKey(byName), 'name:Sam');
  assert.equal(assigneeKey(nobody), '');
  const people = { meKeys: ['id:u_1'], nameOf: (t) => (t.assigneeId === 'u_1' ? 'Priya Shah' : t.assignee) };
  assert.equal(matchesFilter(byId, { assignee: 'me' }, today, people), true);
  assert.equal(matchesFilter(byName, { assignee: 'me' }, today, people), false);
  assert.equal(matchesFilter(nobody, { assignee: 'none' }, today, people), true);
  assert.equal(matchesFilter(byId, { assignee: 'none' }, today, people), false);
  assert.equal(matchesFilter(byId, { assignee: 'id:u_1' }, today, people), true);
  assert.equal(matchesFilter(byId, { query: 'priya' }, today, people), true, 'search matches resolved names');
});

test('workload counts open tasks per assignee', () => {
  let s = board(['todo', 'A', { assigneeId: 'u_1' }], ['review', 'B', { assigneeId: 'u_1' }],
    ['todo', 'C', { assignee: 'Sam' }], ['todo', 'D'], ['done', 'E', { assigneeId: 'u_1' }]);
  const w = workload(s);
  assert.equal(w.get('id:u_1'), 2);
  assert.equal(w.get('name:Sam'), 1);
  assert.equal(w.get(''), 1);
  assert.deepEqual(allAssigneeKeys(s).sort(), ['id:u_1', 'name:Sam']);
});

test('getStats summarises the board', () => {
  const s = board(
    ['todo', 'A', { dueDate: '2026-01-01', priority: 'urgent' }],
    ['in-progress', 'B'],
    ['done', 'C', { dueDate: '2026-01-01' }],
    ['done', 'D'],
  );
  const stats = getStats(s, '2026-09-23');
  assert.equal(stats.total, 4);
  assert.equal(stats.done, 2);
  assert.equal(stats.open, 2);
  assert.equal(stats.completion, 50);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.byColumn['in-progress'], 1);
  assert.equal(stats.byPriority.urgent, 1);
  assert.equal(getStats(createEmptyState()).completion, 0);
});

test('columns can be added before Done, renamed, limited and deleted', () => {
  let s = board(['todo', 'A'], ['qa', 'ignored']);
  s = addColumn(s, '  QA  ');
  const qa = s.columns[s.columns.length - 2];
  assert.equal(qa.title, 'QA');
  assert.equal(s.columns.at(-1).id, 'done');
  assert.equal(addColumn(s, '   '), s);

  s = updateColumn(s, 'todo', { title: 'Next', wipLimit: '1' });
  assert.equal(s.columns.find((c) => c.id === 'todo').title, 'Next');
  assert.equal(isOverWip(s, 'todo'), false);
  s = addTask(s, { title: 'B', status: 'todo' });
  assert.equal(isOverWip(s, 'todo'), true);

  s = deleteColumn(s, 'todo');
  assert.ok(!s.columns.some((c) => c.id === 'todo'));
  assert.equal(tasksInColumn(s, 'backlog').length, 3, 'tasks move to first column');
  assert.equal(deleteColumn(s, 'done'), s, 'Done cannot be deleted');
});

test('normalizeState repairs imported data and rejects garbage', () => {
  assert.throws(() => normalizeState(null));
  assert.throws(() => normalizeState({ columns: [] }));
  const s = normalizeState({
    tasks: [
      { title: 'Keep', status: 'unknown', priority: 'x', tags: ['A', 'a'] },
      { nope: true },
    ],
  });
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].status, 'backlog');
  assert.equal(s.tasks[0].priority, 'medium');
  assert.deepEqual(s.tasks[0].tags, ['a']);
  assert.equal(s.columns.length, 5);
});

test('normalizeTags trims, lowercases and dedupes', () => {
  assert.deepEqual(normalizeTags(' Bug, ui ,bug,,'), ['bug', 'ui']);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('save and load round-trip through storage', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const s = createSampleState('2026-09-23');
  assert.equal(saveState(storage, s), true);
  assert.deepEqual(loadState(storage), s);
  mem.set(STORAGE_KEY, '{broken');
  assert.equal(loadState(storage), null);
  assert.equal(loadState(null), null);
});
