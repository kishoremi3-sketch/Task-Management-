import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, addTask, addSprint, moveTask, todayISO } from '../js/store.js';
import { buildReport, reportToSheets, reportFileName, filterTasks } from '../js/report.js';

function makeBoard() {
  let b = createEmptyState();
  b = addSprint(b, { name: 'Sprint 7', startDate: '2026-09-21', endDate: '2026-10-04', capacity: 10 });
  const sid = b.sprints[0].id;
  b = addTask(b, { title: 'Fix crash', status: 'todo', type: 'defect', points: 3, assignee: 'Sam', sprintId: sid, dueDate: '2026-09-20' });
  b = addTask(b, { title: 'Faster triage', status: 'in-progress', type: 'service', points: 5, assignee: 'Ana', sprintId: sid });
  b = addTask(b, { title: 'Dark mode', status: 'todo', type: 'enhancement', points: 8, sprintId: sid });
  b = addTask(b, { title: 'Roadmap', status: 'backlog', type: 'project' });
  b = moveTask(b, b.tasks.find((t) => t.title === 'Faster triage').id, 'done');
  return { board: b, sid };
}

const today = '2026-09-24';

test('single-team sprint report: summary, sprint, tasks and breakdowns', () => {
  const { board, sid } = makeBoard();
  const r = buildReport({ entries: [{ teamName: 'Design', board }], view: sid, today });
  assert.equal(r.scope, 'Design · Sprint 7');
  assert.equal(r.taskCount, 3);
  const get = (id) => r.sections.find((s) => s.id === id);
  const summary = Object.fromEntries(get('summary').rows);
  assert.equal(summary.Tasks, 3);
  assert.equal(summary.Done, 1);
  assert.equal(summary['Completion (%)'], 33);
  assert.equal(summary.Overdue, 1);
  assert.equal(summary['Unassigned open tasks'], 1);
  assert.equal(summary['Story points open'], 11);
  const sprint = Object.fromEntries(get('sprint').rows);
  assert.equal(sprint['Points done'], '5 of 16');
  assert.equal(sprint['Over limit by'], 6);
  assert.equal(sprint['Days left'], 11);
  const tasks = get('tasks');
  assert.equal(tasks.columns[0], 'Task', 'no team column for one team');
  const triage = tasks.rows.find((row) => row[0] === 'Faster triage');
  assert.deepEqual(triage.slice(0, 7), ['Faster triage', 'Service improvement item', 'Medium', 'Done', 'Ana', 'Sprint 7', 5]);
  assert.equal(triage[11], todayISO(), 'completed on the real day it was moved to Done');
  assert.deepEqual(get('people').rows[0], ['Sam', 1, 0, 3, 3]);
  assert.deepEqual(get('types').rows.map((row) => row[0]), ['Enhancement', 'Defect', 'Service improvement item']);
  assert.deepEqual(get('status').rows.map((row) => row[0]), ['To Do', 'Done']);
});

test('filters, section choice and multi-team reports', () => {
  const { board } = makeBoard();
  const other = addTask(createEmptyState(), { title: 'Ops task', status: 'todo', type: 'service' });
  const r = buildReport({
    entries: [{ teamName: 'Design', board }, { teamName: 'Ops', board: other }],
    filters: { status: 'open', type: 'service' },
    include: ['summary', 'tasks'],
    today,
  });
  assert.equal(r.scope, '2 teams · Open tasks only · Service improvement item');
  assert.deepEqual(r.sections.map((s) => s.id), ['summary', 'tasks']);
  assert.deepEqual(r.sections[1].rows.map((row) => [row[0], row[1]]), [['Ops', 'Ops task']], 'team column first');
  assert.equal(Object.fromEntries(r.sections[0].rows).Teams, 2);
  assert.equal(filterTasks(board.tasks, { type: 'none' }).length, 0);
});

test('report converts to sheets and a safe file name', () => {
  const { board, sid } = makeBoard();
  const r = buildReport({ entries: [{ teamName: 'Design/UX', board }], view: sid, today });
  const sheets = reportToSheets(r);
  assert.deepEqual(sheets.map((s) => s.name), ['Summary', 'Task list', 'By person', 'By type', 'By status']);
  assert.ok(sheets[0].rows.some((row) => row[0] === 'Sprint summary'), 'sprint summary shares the first sheet');
  assert.equal(reportFileName(r, 'xlsx'), 'TaskFlow report - Design-UX - Sprint 7 - 2026-09-24.xlsx');
});

test('team tags: filter by team name, By team section and shared counts', async () => {
  const { addTeamTag } = await import('../js/store.js');
  let b = createEmptyState();
  b = addTeamTag(addTeamTag(addTeamTag(b, 'Networks'), 'Cybersecurity'), 'Digital Hub');
  const [net, cyber] = b.teamTags.map((t) => t.id);
  b = addTask(b, { title: 'Firewall', status: 'todo', points: 5, teams: [net, cyber], assignees: ['name:Priya', 'name:Ana'],
    checklist: [{ text: 'Open port', done: true }, { text: 'Review' }] });
  b = addTask(b, { title: 'Switch swap', status: 'todo', points: 3, teams: [net], assignees: ['name:Priya'] });
  b = addTask(b, { title: 'Loose end', status: 'todo' });
  const all = buildReport({ entries: [{ teamName: 'DX', board: b }], today });
  const get = (r, id) => r.sections.find((s) => s.id === id);
  const tasks = get(all, 'tasks');
  assert.deepEqual(tasks.columns.slice(0, 3), ['Task', 'Type', 'Teams']);
  const fw = tasks.rows.find((r) => r[0] === 'Firewall');
  assert.equal(fw[2], 'Networks, Cybersecurity');
  assert.equal(fw[5], 'Priya, Ana');
  assert.equal(fw[tasks.columns.indexOf('Checklist')], '1/2');
  assert.deepEqual(get(all, 'teams').rows, [
    ['Networks', 2, 0, 8, 1],
    ['Cybersecurity', 1, 0, 5, 1],
    ['Digital Hub', 0, 0, 0, 0],
    ['No team', 1, 0, 0, 0],
  ]);
  assert.deepEqual(get(all, 'people').rows.slice(0, 2), [['Priya', 2, 0, 8, 8], ['Ana', 1, 0, 5, 5]], 'shared tasks count for each person');
  assert.equal(Object.fromEntries(get(all, 'summary').rows)['Tasks shared by several teams'], 1);

  const cyberOnly = buildReport({ entries: [{ teamName: 'DX', board: b }], filters: { team: 'cybersecurity' }, today });
  assert.equal(cyberOnly.taskCount, 1);
  assert.match(cyberOnly.scope, /cybersecurity/);
  const none = buildReport({ entries: [{ teamName: 'DX', board: b }], filters: { team: 'none' }, today });
  assert.deepEqual(get(none, 'tasks').rows.map((r) => r[0]), ['Loose end']);
});
