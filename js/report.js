// Builds reports from team boards. Pure data in, pure data out, so the
// same report drives the on-screen preview, the Excel file and the PDF.
//
// buildReport({ entries, view, filters, include, nameOf, today }) ->
//   { title, scope, generatedOn, taskCount, sections: [...] }
// where each section is
//   { id, title, kind: 'pairs', rows: [[label, value], ...] }   or
//   { id, title, kind: 'table', columns: [...], rows: [[...], ...] }

import {
  DONE_COLUMN_ID, TASK_TYPES, TASK_TYPE_LABELS, getSprint, tasksInView, isOverdue, isDueSoon,
  sumPoints, sprintLoad, daysLeft, todayISO,
} from './store.js';

export const REPORT_SECTIONS = [
  { id: 'summary', label: 'Summary' },
  { id: 'sprint', label: 'Sprint summary' },
  { id: 'tasks', label: 'Task list' },
  { id: 'people', label: 'By person' },
  { id: 'types', label: 'By type' },
  { id: 'status', label: 'By status' },
];

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
const localDay = (iso) => (iso ? todayISO(new Date(iso)) : '');
const isDone = (t) => t.status === DONE_COLUMN_ID;

export function filterTasks(tasks, { status = 'all', type = '' } = {}) {
  return tasks.filter((t) => {
    if (status === 'open' && isDone(t)) return false;
    if (status === 'done' && !isDone(t)) return false;
    if (type === 'none' && t.type) return false;
    if (type && type !== 'none' && t.type !== type) return false;
    return true;
  });
}

/**
 * entries: [{ teamName, board }] — one entry for a single-team report.
 * view: 'all' | 'backlog' | a sprint id (single team only).
 * nameOf(task): the assignee's display name, or '' when unassigned.
 */
export function buildReport({
  entries, view = 'all', filters = {}, include = REPORT_SECTIONS.map((s) => s.id),
  nameOf = (t) => t.assignee, today = todayISO(),
}) {
  const multi = entries.length > 1;
  const single = entries[0];
  const sprint = !multi && single ? getSprint(single.board, view) : null;
  const effectiveView = multi ? 'all' : view;

  // Every task in scope, remembering which board it came from.
  const rows = entries.flatMap(({ teamName, board }) => filterTasks(tasksInView(board, effectiveView), filters)
    .map((task) => ({ task, teamName, board })));
  const tasks = rows.map((r) => r.task);
  const done = tasks.filter(isDone);
  const open = tasks.filter((t) => !isDone(t));

  const scopeParts = [multi ? `${entries.length} teams` : single?.teamName ?? 'No team'];
  if (!multi) scopeParts.push(sprint ? sprint.name : view === 'backlog' ? 'Backlog' : 'All tasks');
  if (filters.status === 'open') scopeParts.push('Open tasks only');
  if (filters.status === 'done') scopeParts.push('Done tasks only');
  if (filters.type) scopeParts.push(filters.type === 'none' ? 'No type' : TASK_TYPE_LABELS[filters.type]);

  const sections = [];
  const want = new Set(include);

  if (want.has('summary')) {
    sections.push({
      id: 'summary',
      title: 'Summary',
      kind: 'pairs',
      rows: [
        ...(multi ? [['Teams', entries.length]] : []),
        ['Tasks', tasks.length],
        ['Open', open.length],
        ['Done', done.length],
        ['Completion (%)', pct(done.length, tasks.length)],
        ['Overdue', tasks.filter((t) => isOverdue(t, today)).length],
        ['Due in the next 2 days', tasks.filter((t) => isDueSoon(t, today)).length],
        ['Unassigned open tasks', open.filter((t) => !nameOf(t)).length],
        ['Story points (total)', sumPoints(tasks)],
        ['Story points open', sumPoints(open)],
        ['Story points done', sumPoints(done)],
      ],
    });
  }

  if (want.has('sprint') && sprint) {
    const all = tasksInView(single.board, sprint.id);
    const load = sprintLoad(single.board, sprint.id);
    const left = daysLeft(sprint, today);
    sections.push({
      id: 'sprint',
      title: 'Sprint summary',
      kind: 'pairs',
      rows: [
        ['Sprint', sprint.name],
        ['Status', sprint.status[0].toUpperCase() + sprint.status.slice(1)],
        ['Dates', `${sprint.startDate} to ${sprint.endDate}`],
        ['Goal', sprint.goal || '–'],
        ['Tasks done', `${all.filter(isDone).length} of ${all.length}`],
        ['Points done', `${sumPoints(all.filter(isDone))} of ${load.planned}`],
        ['Point limit', load.capacity ?? 'No limit'],
        ['Over limit by', load.capacity ? load.over : '–'],
        ['Days left', sprint.status === 'completed' ? 'Completed' : left === null ? '–' : Math.max(0, left)],
      ],
    });
  }

  if (want.has('tasks')) {
    const columnTitle = (board, id) => board.columns.find((c) => c.id === id)?.title ?? id;
    const sprintName = (board, id) => (id ? getSprint(board, id)?.name ?? '' : '');
    sections.push({
      id: 'tasks',
      title: 'Task list',
      kind: 'table',
      columns: [
        ...(multi ? ['Team'] : []),
        'Task', 'Type', 'Priority', 'Status', 'Assignee', 'Sprint', 'Story points', 'Due date', 'Tags', 'Created', 'Completed',
      ],
      rows: rows.map(({ task: t, teamName, board }) => [
        ...(multi ? [teamName] : []),
        t.title,
        TASK_TYPE_LABELS[t.type] ?? '',
        t.priority[0].toUpperCase() + t.priority.slice(1),
        columnTitle(board, t.status),
        nameOf(t) || 'Unassigned',
        sprintName(board, t.sprintId),
        t.points ?? '',
        t.dueDate,
        t.tags.join(', '),
        localDay(t.createdAt),
        isDone(t) ? localDay(t.completedAt) : '',
      ]),
    });
  }

  if (want.has('people')) {
    const byPerson = new Map();
    for (const t of tasks) {
      const name = nameOf(t) || 'Unassigned';
      const row = byPerson.get(name) ?? { open: 0, done: 0, openPoints: 0, points: 0 };
      if (isDone(t)) row.done += 1;
      else {
        row.open += 1;
        row.openPoints += t.points ?? 0;
      }
      row.points += t.points ?? 0;
      byPerson.set(name, row);
    }
    sections.push({
      id: 'people',
      title: 'By person',
      kind: 'table',
      columns: ['Person', 'Open tasks', 'Done tasks', 'Open points', 'Total points'],
      rows: [...byPerson]
        .sort((a, b) => b[1].open - a[1].open || a[0].localeCompare(b[0]))
        .map(([name, r]) => [name, r.open, r.done, r.openPoints, r.points]),
    });
  }

  if (want.has('types')) {
    sections.push({
      id: 'types',
      title: 'By type',
      kind: 'table',
      columns: ['Type', 'Open tasks', 'Done tasks', 'Story points'],
      rows: [...TASK_TYPES, ''].map((type) => {
        const list = tasks.filter((t) => t.type === type);
        return [type ? TASK_TYPE_LABELS[type] : 'No type', list.filter((t) => !isDone(t)).length, list.filter(isDone).length, sumPoints(list)];
      }).filter((r) => r[1] || r[2]),
    });
  }

  if (want.has('status')) {
    const byStatus = new Map();
    for (const { task, board } of rows) {
      const title = board.columns.find((c) => c.id === task.status)?.title ?? task.status;
      const row = byStatus.get(title) ?? { tasks: 0, points: 0 };
      row.tasks += 1;
      row.points += task.points ?? 0;
      byStatus.set(title, row);
    }
    // Keep the board's column order (the first board's, for multi-team).
    const order = entries.flatMap((e) => e.board.columns.map((c) => c.title));
    sections.push({
      id: 'status',
      title: 'By status',
      kind: 'table',
      columns: ['Status', 'Tasks', 'Story points', 'Share of tasks (%)'],
      rows: [...byStatus]
        .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
        .map(([title, r]) => [title, r.tasks, r.points, pct(r.tasks, tasks.length)]),
    });
  }

  return {
    title: 'TaskFlow report',
    scope: scopeParts.join(' · '),
    generatedOn: today,
    taskCount: tasks.length,
    sections,
  };
}

// The report as spreadsheet sheets for buildXlsx: summary-style sections
// share the first sheet; each table gets its own.
export function reportToSheets(report) {
  const pairs = report.sections.filter((s) => s.kind === 'pairs');
  const tables = report.sections.filter((s) => s.kind === 'table');
  const overview = {
    name: 'Summary',
    title: `${report.title}: ${report.scope}`,
    columns: ['Item', 'Value'],
    rows: [
      ['Generated on', report.generatedOn],
      ...pairs.flatMap((s, i) => [...(i || pairs.length > 1 ? [['', ''], [s.title, '']] : []), ...s.rows]),
    ],
    widths: [28, 50],
    filter: false,
  };
  return [overview, ...tables.map((s) => ({ name: s.title, columns: s.columns, rows: s.rows }))];
}

export function reportFileName(report, ext) {
  const safe = report.scope.replace(/ · /g, ' - ').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  return `TaskFlow report - ${safe} - ${report.generatedOn}.${ext}`;
}
