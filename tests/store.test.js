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

test('task types: validated, filterable, searchable and counted', () => {
  let s = board(
    ['todo', 'Crash on save', { type: 'defect' }],
    ['todo', 'Dark mode', { type: 'enhancement' }],
    ['todo', 'Website relaunch', { type: 'project' }],
    ['done', 'Old crash', { type: 'defect' }],
    ['todo', 'Misc', { type: 'bogus' }],
  );
  const byTitle = (t) => s.tasks.find((x) => x.title === t);
  assert.equal(byTitle('Misc').type, '', 'unknown types are dropped');
  const today = '2026-09-23';
  const titles = (f) => s.tasks.filter((t) => matchesFilter(t, f, today)).map((t) => t.title).sort();
  assert.deepEqual(titles({ type: 'defect' }), ['Crash on save', 'Old crash']);
  assert.deepEqual(titles({ type: 'none' }), ['Misc']);
  assert.deepEqual(titles({ query: 'enhancement' }), ['Dark mode']);
  assert.deepEqual(getStats(s, today).byType, { project: 1, enhancement: 1, defect: 1 }, 'open tasks only');
  s = updateTask(s, byTitle('Misc').id, { type: 'project' });
  assert.equal(byTitle('Misc').type, 'project');
});

test('sprints: defaults, lifecycle, planning and completion', async () => {
  const { addSprint, startSprint, completeSprint, deleteSprint, setSprintTasks, tasksInView,
    activeSprint, nextSprintDefaults, daysLeft, updateSprint } = await import('../js/store.js');
  const today = '2026-09-23';
  let s = board(['todo', 'A'], ['todo', 'B'], ['in-progress', 'C'], ['done', 'D']);
  const id = (title) => s.tasks.find((t) => t.title === title).id;

  assert.deepEqual(nextSprintDefaults(s, today), { name: 'Sprint 1', startDate: today, endDate: '2026-10-06', goal: '' });
  s = addSprint(s, { ...nextSprintDefaults(s, today), goal: 'Ship login' });
  const s1 = s.sprints[0];
  assert.equal(s1.status, 'planned');
  assert.deepEqual(nextSprintDefaults(s, today), { name: 'Sprint 2', startDate: '2026-10-07', endDate: '2026-10-20', goal: '' });
  s = addSprint(s, nextSprintDefaults(s, today));
  const s2 = s.sprints[1];

  s = setSprintTasks(s, s1.id, [id('A'), id('C'), id('D')]);
  assert.deepEqual(tasksInView(s, s1.id).map((t) => t.title).sort(), ['A', 'C', 'D']);
  assert.deepEqual(tasksInView(s, 'backlog').map((t) => t.title), ['B']);
  s = setSprintTasks(s, s1.id, [id('A'), id('C'), id('D'), id('B')].filter((x) => x !== id('A')));
  assert.equal(s.tasks.find((t) => t.title === 'A').sprintId, '', 'unchecked tasks return to the backlog');

  s = startSprint(s, s1.id);
  assert.equal(activeSprint(s).id, s1.id);
  assert.equal(startSprint(s, s2.id), s, 'only one active sprint at a time');
  assert.equal(daysLeft(activeSprint(s), today), 14);
  assert.equal(daysLeft(activeSprint(s), '2026-10-06'), 1);

  s = completeSprint(s, s1.id, s2.id);
  assert.equal(s.sprints.find((sp) => sp.id === s1.id).status, 'completed');
  assert.deepEqual(tasksInView(s, s2.id).map((t) => t.title).sort(), ['B', 'C'], 'unfinished tasks roll over');
  assert.deepEqual(tasksInView(s, s1.id).map((t) => t.title), ['D'], 'done tasks stay as a record');

  s = updateSprint(s, s2.id, { name: 'Sprint 2 — polish', endDate: '2026-10-01' });
  assert.equal(s.sprints.find((sp) => sp.id === s2.id).endDate, '2026-10-07', 'end date can’t precede start');
  s = deleteSprint(s, s2.id);
  assert.deepEqual(tasksInView(s, 'backlog').map((t) => t.title).sort(), ['A', 'B', 'C']);
});

test('normalizeState keeps sprints and drops links to missing ones', () => {
  const s = normalizeState({
    sprints: [{ id: 's1', name: 'Sprint 1', startDate: '2026-09-01', endDate: '2026-09-14', status: 'weird' }],
    tasks: [{ title: 'In sprint', sprintId: 's1' }, { title: 'Orphan', sprintId: 'gone' }],
  });
  assert.equal(s.sprints[0].status, 'planned');
  assert.deepEqual(s.tasks.map((t) => t.sprintId), ['s1', '']);
  assert.deepEqual(normalizeState({ tasks: [] }).sprints, []);
});

test('burndown: snapshots, carry-forward, estimates, ideal line and completion', async () => {
  const { addSprint, startSprint, completeSprint, setSprintTasks, recordBurndown, burndownSeries } = await import('../js/store.js');
  let s = board(['todo', 'A'], ['todo', 'B'], ['todo', 'C'], ['todo', 'D']);
  s = addSprint(s, { name: 'Sprint 1', startDate: '2026-09-21', endDate: '2026-09-25' });
  const sid = s.sprints[0].id;
  s = setSprintTasks(s, sid, s.tasks.map((t) => t.id));
  s = startSprint(s, sid, '2026-09-21');
  assert.deepEqual(s.sprints[0].burndown, { '2026-09-21': { remaining: 4, total: 4 } }, 'snapshot on start');

  // Day 2: one task done. Day 3: no activity. Day 4 (today): a task added.
  const id = (title) => s.tasks.find((t) => t.title === title).id;
  s = recordBurndown(moveTask(s, id('A'), 'done'), '2026-09-22');
  assert.equal(recordBurndown(s, '2026-09-22'), s, 'no rewrite when nothing changed');
  s = addTask(s, { title: 'E', status: 'todo', sprintId: sid });
  s = recordBurndown(s, '2026-09-24');

  const pts = burndownSeries(s, sid, '2026-09-24');
  assert.deepEqual(pts.map((p) => p.date), ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25']);
  assert.deepEqual(pts.map((p) => p.remaining), [4, 3, 3, 4, null], 'carry forward, scope change, future is null');
  assert.deepEqual(pts.map((p) => p.total), [4, 4, 4, 5, null]);
  assert.deepEqual(pts.map((p) => p.ideal), [4, 3, 2, 1, 0], 'ideal runs from starting scope to zero');
  assert.ok(pts.every((p) => !p.estimated));

  // Completing records the final count before unfinished tasks move out.
  s = completeSprint(s, sid, '', '2026-09-25');
  const done = burndownSeries(s, sid, '2026-09-30');
  assert.equal(done.at(-1).date, '2026-09-25');
  assert.equal(done.at(-1).remaining, 4);
});

test('burndown estimates days before any snapshot from completion dates', async () => {
  const { burndownSeries } = await import('../js/store.js');
  const day = (iso) => new Date(`${iso}T12:00:00`).toISOString();
  const s = normalizeState({
    sprints: [{ id: 's1', name: 'Old', startDate: '2026-09-01', endDate: '2026-09-03', status: 'active' }],
    tasks: [
      { title: 'A', status: 'done', sprintId: 's1', completedAt: day('2026-09-02') },
      { title: 'B', status: 'todo', sprintId: 's1' },
    ],
  });
  const pts = burndownSeries(s, 's1', '2026-09-03');
  assert.deepEqual(pts.map((p) => [p.remaining, p.estimated]), [[2, true], [1, true], [1, false]], 'today is live, earlier days estimated');
});
