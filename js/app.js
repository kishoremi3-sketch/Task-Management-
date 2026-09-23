import {
  PRIORITIES, DONE_COLUMN_ID, TASK_TYPES, TASK_TYPE_LABELS,
  createEmptyState, createSampleState, normalizeState, normalizeTags,
  tasksInColumn, getTask, isOverdue, isDueSoon, allTags, matchesFilter, getStats,
  assigneeKey, allAssigneeKeys, workload,
  sprintsOf, getSprint, activeSprint, nextSprintDefaults, addSprint, updateSprint, startSprint,
  completeSprint, deleteSprint, setSprintTasks, tasksInView, daysLeft,
  addTask, updateTask, deleteTask, moveTask, addColumn, updateColumn, deleteColumn, isOverWip,
  todayISO,
} from './store.js';
import { ssoProviders, signIn, signOut, handleRedirect, currentSession } from './auth.js';
import {
  createLocalBackend, createCloudBackend, cleanTeamName, cleanMembers, visibleTeams,
} from './backend.js';

const storage = (() => {
  try { return window.localStorage; } catch { return null; }
})();

// The selected team's board.
let state = createEmptyState();
// Who is signed in: { id, name, detail, avatarUrl, color, canSignOut }, or
// null when the app runs without sign-in. `id` is a claude.ai account id
// when hosted there, which is what tasks store as assigneeId.
let identity = null;
// Where teams and boards are stored (see backend.js).
let backend = null;
// Every team, and the ones this person is shown (their teams, or all of
// them for people who manage teams).
let allTeams = [];
let teams = [];
let teamsLoaded = false;
let teamId = null;
let closeBoard = null;
let canManageTeams = false;
// The `user` capability when hosted on claude.ai: resolves account ids to
// names and avatars, and powers the assignee search.
let userApi = null;
const people = new Map(); // account id -> { name, avatarUrl, color }

// Which sprint the board shows: the person's choice for this team
// ('all', 'backlog' or a sprint id), or null for "the active sprint".
let sprintChoice = null;

const EMPTY_FILTER = { query: '', priority: '', type: '', assignee: '', tag: '', due: '' };
let filter = { ...EMPTY_FILTER };
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

// Like el.replaceChildren, but skips null/false children (replaceChildren
// would render them as the text "null").
function setChildren(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

// ---------- state ----------

function commit(next) {
  if (!teamId) return;
  state = next;
  backend.saveBoard(teamId, state);
  render();
}

const claudeUse = (name) => (window.claude?.use
  ? window.claude.use(name).catch(() => null)
  : Promise.resolve(null));

function setSyncStatus(text, mode = '') {
  const el = $('#sync-status');
  el.textContent = text;
  el.dataset.mode = mode;
}

let warnedWrite = false;
function onWriteError(err) {
  if (warnedWrite) return;
  warnedWrite = true;
  toast(err?.code === 'invalid_argument'
    ? 'You can view this board but not change it. Ask the owner for edit access.'
    : 'Your last change couldn’t be saved to the shared board. Reload the page to try again.');
}

// ---------- people ----------

// Display info for an assignee key ("id:<account>" or "name:<text>").
function personFor(key) {
  if (key.startsWith('id:')) {
    const id = key.slice(3);
    const p = people.get(id);
    const isMe = identity?.id === id;
    return {
      name: p?.name || (isMe ? identity.name : '') || 'Someone',
      avatarUrl: p?.avatarUrl || (isMe ? identity.avatarUrl : null),
      color: p?.color || (isMe ? identity.color : null),
      isMe,
    };
  }
  const name = key.slice(5);
  return { name, avatarUrl: null, color: null, isMe: Boolean(identity && !identity.id && identity.name === name) };
}

function avatarEl(person, cls = 'avatar') {
  if (person.avatarUrl) return h('span', { class: cls }, h('img', { src: person.avatarUrl, alt: '' }));
  const el = h('span', { class: cls, style: `--hue:${hue(person.name)}` }, initials(person.name) || '?');
  if (person.color) el.style.background = person.color;
  return el;
}

function shortName(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : name;
}

function meKeys() {
  if (!identity) return [];
  return identity.id && backend?.kind === 'cloud' ? [`id:${identity.id}`] : [`name:${identity.name}`];
}

const peopleContext = () => ({
  meKeys: meKeys(),
  nameOf: (t) => {
    const key = assigneeKey(t);
    return key ? personFor(key).name : '';
  },
});

// Resolve names/avatars for the accounts on the board; re-render if any
// changed. The platform caches these, so calling it on every render is cheap.
function refreshPeople() {
  if (!userApi) return;
  const ids = [...new Set([
    ...state.tasks.map((t) => t.assigneeId).filter(Boolean),
    ...teamMembers(currentTeam()),
  ])];
  if (!ids.length) return;
  userApi.profiles(ids).then((profiles) => {
    let changed = false;
    for (const id of ids) {
      const p = profiles[id];
      if (!p) continue;
      const prev = people.get(id);
      if (!prev || prev.name !== p.name || prev.avatarUrl !== p.avatarUrl) {
        people.set(id, { name: p.name, avatarUrl: p.avatarUrl, color: p.color });
        changed = true;
      }
    }
    if (changed) {
      renderTeams();
      render();
    }
  });
}

// ---------- teams ----------

const TEAM_PREF_KEY = 'taskflow.team';
let createdTeamId = null;

function preferredTeam() {
  try { return localStorage.getItem(TEAM_PREF_KEY); } catch { return null; }
}

// Team membership needs real accounts, so it's only offered where the
// page can look people up (hosted on claude.ai).
const membersEnabled = () => Boolean(userApi) && backend?.kind === 'cloud';
const teamMembers = (team) => cleanMembers(team?.members);

function onTeams(list) {
  allTeams = list;
  teams = visibleTeams(list, { userId: identity?.id, canManage: canManageTeams });
  teamsLoaded = true;
  // A team we just created may not be in the list for a moment; once it
  // shows up, treat it like any other team.
  if (teams.some((t) => t.id === createdTeamId)) createdTeamId = null;
  if (teamId && teamId === createdTeamId) {
    renderTeams();
    return;
  }
  if (!teams.some((t) => t.id === teamId)) {
    const pref = preferredTeam();
    selectTeam(teams.find((t) => t.id === pref)?.id ?? teams[0]?.id ?? null);
  } else {
    renderTeams();
  }
}

function selectTeam(id) {
  closeBoard?.();
  closeBoard = null;
  teamId = id;
  filter = { ...EMPTY_FILTER };
  $('#search').value = '';
  $('#filter-priority').value = '';
  $('#filter-type').value = '';
  $('#filter-due').value = '';
  sprintChoice = null;
  if (id) {
    try {
      localStorage.setItem(TEAM_PREF_KEY, id);
      sprintChoice = localStorage.getItem(`taskflow.sprint:${id}`);
    } catch { /* ignore */ }
    state = backend.cachedBoard(id) ?? createEmptyState();
    closeBoard = backend.openBoard(id, (board) => {
      if (JSON.stringify(board) === JSON.stringify(state) || drag.active) return;
      state = board;
      render();
    });
  } else {
    state = createEmptyState();
  }
  renderTeams();
  render();
}

function currentTeam() {
  return teams.find((t) => t.id === teamId) ?? null;
}

async function promptNewTeam() {
  const name = cleanTeamName(await ask({
    title: 'New team',
    message: 'Each team gets its own shared board.',
    value: '',
    okLabel: 'Create team',
  }));
  if (!name) return;
  try {
    // The creator starts as the team's first member.
    const members = membersEnabled() && identity?.id ? [identity.id] : [];
    const id = await backend.createTeam(name, members);
    createdTeamId = id;
    if (!teams.some((t) => t.id === id)) teams = [...teams, { id, name, members }];
    selectTeam(id);
    toast(`Created team “${name}”`);
  } catch (err) {
    toast(`Couldn’t create the team: ${err?.message ?? 'unknown error'}`);
  }
}

function openTeamMenu(anchor, team) {
  showPopupMenu(anchor, [
    ...(membersEnabled() ? [['Manage members…', () => openMembersDialog(team)]] : []),
    ['Rename team', async () => {
      const name = cleanTeamName(await ask({ title: 'Rename team', value: team.name, okLabel: 'Rename' }));
      if (!name || name === team.name) return;
      try {
        await backend.renameTeam(team.id, name);
        if (backend.kind === 'cloud') {
          teams = teams.map((t) => (t.id === team.id ? { ...t, name } : t));
          renderTeams();
        }
      } catch (err) {
        toast(`Couldn’t rename the team: ${err?.message ?? 'unknown error'}`);
      }
    }],
    ['Delete team', async () => {
      const n = team.id === teamId ? state.tasks.length : null;
      const ok = await ask({
        title: `Delete “${team.name}”?`,
        message: `${n === null ? 'Its board' : `Its board and ${n} task(s)`} will be deleted for everyone. This can’t be undone.`,
        okLabel: 'Delete team',
        danger: true,
      });
      if (!ok) return;
      try {
        if (createdTeamId === team.id) createdTeamId = null;
        await backend.deleteTeam(team.id);
        toast(`Deleted team “${team.name}”`);
      } catch (err) {
        toast(`Couldn’t delete the team: ${err?.message ?? 'unknown error'}`);
      }
    }, 'danger'],
  ]);
}

// Faces of the current team's members, beside the tabs.
function renderMembersStrip() {
  const team = currentTeam();
  if (!team || !membersEnabled()) return null;
  const members = teamMembers(team);
  const shown = members.slice(0, 5);
  const label = members.length
    ? `${members.length} member${members.length === 1 ? '' : 's'}: ${members.map((id) => personFor(`id:${id}`).name).join(', ')}`
    : 'No members yet';
  const faces = h('span', { class: 'member-faces', title: label },
    shown.map((id) => avatarEl(personFor(`id:${id}`), 'avatar small')),
    members.length > shown.length ? h('span', { class: 'avatar small is-none' }, `+${members.length - shown.length}`) : null,
    members.length ? null : h('span', { class: 'member-none' }, 'No members'));
  return h('div', { class: 'team-members' },
    canManageTeams
      ? h('button', { class: 'members-btn', 'aria-label': `Manage members. ${label}`, onclick: () => openMembersDialog(team) }, faces, 'Members')
      : h('span', { class: 'members-btn is-static', 'aria-label': label }, faces));
}

// ---------- team members dialog ----------

const membersDialog = $('#members-dialog');
let membersTeam = null;
let draftMembers = [];
let memberResults = [];
let activeMember = 0;

function openMembersDialog(team) {
  membersTeam = team;
  draftMembers = teamMembers(team);
  memberResults = [];
  $('#members-title').textContent = `${team.name} members`;
  $('#member-input').value = '';
  renderMemberList();
  renderMemberResults();
  membersDialog.showModal();
  $('#member-input').focus();
  if (draftMembers.length) {
    userApi.profiles(draftMembers).then((profiles) => {
      for (const [id, p] of Object.entries(profiles)) people.set(id, { name: p.name, avatarUrl: p.avatarUrl, color: p.color });
      renderMemberList();
    });
  }
}

function renderMemberList() {
  const list = $('#member-list');
  list.replaceChildren(...draftMembers.map((id) => {
    const person = personFor(`id:${id}`);
    return h('li', { class: 'member-row' },
      avatarEl(person, 'avatar small'),
      h('span', { class: 'member-name' }, person.isMe ? `${person.name} (you)` : person.name),
      h('button', {
        type: 'button',
        class: 'chip-clear',
        'aria-label': `Remove ${person.name}`,
        onclick: () => {
          draftMembers = draftMembers.filter((m) => m !== id);
          renderMemberList();
        },
      }, '✕'));
  }));
  $('#member-empty').hidden = draftMembers.length > 0;
  $('#member-add-me').hidden = !identity?.id || draftMembers.includes(identity.id);
}

async function updateMemberResults() {
  const input = $('#member-input');
  const query = input.value.trim();
  const hits = await userApi.search(query);
  if (input.value.trim() !== query) return;
  for (const hit of hits) people.set(hit.id, { name: hit.name, avatarUrl: hit.avatarUrl, color: hit.color });
  memberResults = hits.filter((hit) => !draftMembers.includes(hit.id)).map((hit) => hit.id);
  activeMember = 0;
  renderMemberResults();
}

function renderMemberResults() {
  const input = $('#member-input');
  const box = $('#member-results');
  const open = document.activeElement === input && memberResults.length > 0;
  box.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  box.replaceChildren(...memberResults.map((id, i) => {
    const person = personFor(`id:${id}`);
    return h('button', {
      type: 'button',
      role: 'option',
      class: `result${i === activeMember ? ' is-active' : ''}`,
      'aria-selected': String(i === activeMember),
      onmousedown: (e) => e.preventDefault(),
      onclick: () => addMember(id),
    }, avatarEl(person, 'avatar small'), person.isMe ? `${person.name} (you)` : person.name);
  }));
}

function addMember(id) {
  if (!draftMembers.includes(id)) draftMembers = [...draftMembers, id];
  $('#member-input').value = '';
  memberResults = [];
  renderMemberResults();
  renderMemberList();
}

$('#member-input').addEventListener('focus', updateMemberResults);
$('#member-input').addEventListener('input', updateMemberResults);
$('#member-input').addEventListener('blur', () => setTimeout(renderMemberResults));
$('#member-input').addEventListener('keydown', (e) => {
  const open = !$('#member-results').hidden;
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && memberResults.length) {
    e.preventDefault();
    activeMember = (activeMember + (e.key === 'ArrowDown' ? 1 : -1) + memberResults.length) % memberResults.length;
    renderMemberResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && memberResults[activeMember]) addMember(memberResults[activeMember]);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    memberResults = [];
    renderMemberResults();
  }
});

$('#member-add-me').addEventListener('click', () => addMember(identity.id));

$('#members-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const team = membersTeam;
  const before = teamMembers(team);
  const after = cleanMembers(draftMembers);
  membersDialog.close();
  if (before.join() === after.join()) return;
  try {
    await backend.setMembers(team.id, after);
    toast(`Saved members of ${team.name}`);
  } catch (err) {
    toast(`Couldn’t save members: ${err?.message ?? 'unknown error'}`);
  }
});

membersDialog.addEventListener('click', (e) => {
  if (e.target === membersDialog || e.target.closest('[data-close-members]')) membersDialog.close();
});

function renderTeams() {
  const showCounts = membersEnabled() && canManageTeams;
  setChildren($('#teams'),
    ...teams.map((t) => {
      const active = t.id === teamId;
      const count = teamMembers(t).length;
      return h('div', { class: `team-tab${active ? ' is-active' : ''}` },
        h('button', {
          class: 'team-name',
          'aria-current': active ? 'true' : false,
          onclick: () => { if (!active) selectTeam(t.id); },
        }, t.name || 'Untitled team',
        showCounts ? h('span', {
          class: `team-count${count ? '' : ' is-empty'}`,
          title: count ? `${count} member(s)` : 'No members yet: only people who can edit this page see it',
        }, count ? String(count) : 'no members') : null),
        canManageTeams && active ? h('button', {
          class: 'icon-btn btn-ghost small',
          'aria-label': `${t.name} team options`,
          title: 'Team options',
          onclick: (e) => { e.stopPropagation(); openTeamMenu(e.currentTarget, t); },
        }, '⋯') : null);
    }),
    canManageTeams && teams.length ? h('button', { class: 'team-add', onclick: promptNewTeam }, '+ New team') : null,
    renderMembersStrip(),
  );
  const hasTeam = Boolean(teamId);
  $('#team-view').hidden = !hasTeam;
  $('#new-task-btn').hidden = !hasTeam;
  $('#board-menu').hidden = !hasTeam;
  $('#no-teams').hidden = hasTeam;
  const notOnATeam = teamsLoaded && !canManageTeams && allTeams.length > 0;
  $('#no-teams-title').textContent = !teamsLoaded ? 'Loading teams…'
    : notOnATeam ? 'You’re not on a team yet' : 'No teams yet';
  $('#no-teams-text').textContent = !teamsLoaded ? ''
    : canManageTeams ? 'Create a team to get a shared board. You can add as many teams as you need.'
      : notOnATeam ? 'You’ll see a team’s board here once the owner of this page adds you to it.'
        : 'Ask the owner of this page to create a team.';
  $('#no-teams-create').hidden = !(teamsLoaded && canManageTeams);
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

// ---------- sprints ----------

// The view in effect: the person's choice if it still exists, otherwise
// the active sprint, otherwise everything.
function currentView() {
  if (sprintChoice === 'all' || sprintChoice === 'backlog') return sprintChoice;
  if (sprintChoice && getSprint(state, sprintChoice)) return sprintChoice;
  return activeSprint(state)?.id ?? 'all';
}

function viewState() {
  return { ...state, tasks: tasksInView(state, currentView()) };
}

function chooseSprintView(view) {
  sprintChoice = view;
  try { if (teamId) localStorage.setItem(`taskflow.sprint:${teamId}`, view); } catch { /* ignore */ }
  render();
}

// New tasks join the sprint being viewed, unless it's already completed.
function defaultSprintForNewTask() {
  const sprint = getSprint(state, currentView());
  return sprint && sprint.status !== 'completed' ? sprint.id : '';
}

const STATUS_LABEL = { planned: 'Planned', active: 'Active', completed: 'Completed' };

function formatDay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: y === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function daysText(sprint) {
  const today = todayISO();
  if (sprint.status === 'completed') return { text: `Completed ${formatDay(sprint.completedAt?.slice(0, 10))}`, late: false };
  if (sprint.status === 'planned' && sprint.startDate > today) {
    const n = daysLeft({ endDate: sprint.startDate }, today) - 1;
    return { text: n === 1 ? 'Starts tomorrow' : `Starts in ${n} days`, late: false };
  }
  const left = daysLeft(sprint, today);
  if (left === null) return { text: '', late: false };
  if (left > 1) return { text: `${left} days left`, late: false };
  if (left === 1) return { text: 'Last day', late: false };
  return { text: `Ended ${-left + 1} day${-left + 1 === 1 ? '' : 's'} ago`, late: true };
}

function renderSprintBar() {
  const view = currentView();
  const sprints = sprintsOf(state);
  const open = sprints.filter((sp) => sp.status !== 'completed');
  const done = sprints.filter((sp) => sp.status === 'completed');
  const backlogCount = tasksInView(state, 'backlog').length;
  const option = (value, label) => h('option', { value, selected: value === view }, label);
  setChildren($('#sprint-view'),
    option('all', `All tasks (${state.tasks.length})`),
    option('backlog', `Backlog: not in a sprint (${backlogCount})`),
    open.length ? h('optgroup', { label: 'Sprints' },
      open.map((sp) => option(sp.id, `${sp.name} · ${STATUS_LABEL[sp.status]}`))) : null,
    done.length ? h('optgroup', { label: 'Completed sprints' },
      done.slice().reverse().map((sp) => option(sp.id, sp.name))) : null,
  );

  const sprint = getSprint(state, view);
  const info = $('#sprint-info');
  const actions = [];
  if (sprint) {
    const tasks = tasksInView(state, sprint.id);
    const finished = tasks.filter((t) => t.status === DONE_COLUMN_ID).length;
    const pct = tasks.length ? Math.round((finished / tasks.length) * 100) : 0;
    const days = daysText(sprint);
    setChildren(info,
      h('span', { class: `sprint-status is-${sprint.status}` }, STATUS_LABEL[sprint.status]),
      h('span', {}, `${formatDay(sprint.startDate)} – ${formatDay(sprint.endDate)}`),
      days.text ? h('span', { class: `sprint-days${days.late ? ' is-late' : ''}` }, days.text) : null,
      h('span', { class: 'sprint-progress' },
        h('span', { class: 'progress', role: 'progressbar', 'aria-label': 'Sprint progress', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('span', { class: 'progress-fill', style: `width:${pct}%` })),
        `${finished} of ${tasks.length} done`),
      sprint.goal ? h('span', { class: 'sprint-goal' }, `Goal: ${sprint.goal}`) : null);
    const other = activeSprint(state);
    if (sprint.status !== 'completed') actions.push(h('button', { class: 'btn', onclick: () => openPlanDialog(sprint) }, 'Plan sprint'));
    if (sprint.status === 'planned') {
      actions.push(h('button', {
        class: 'btn btn-primary',
        disabled: Boolean(other),
        title: other ? `Complete ${other.name} first` : 'Start this sprint',
        onclick: () => {
          commit(startSprint(state, sprint.id));
          toast(`${sprint.name} started`);
        },
      }, 'Start sprint'));
    }
    if (sprint.status === 'active') actions.push(h('button', { class: 'btn btn-primary', onclick: () => openCompleteDialog(sprint) }, 'Complete sprint'));
    actions.push(h('button', { class: 'btn', onclick: () => openSprintDialog(sprint) }, 'Edit'));
  } else if (view === 'backlog') {
    info.replaceChildren(h('span', {}, backlogCount
      ? `${backlogCount} task${backlogCount === 1 ? '' : 's'} not in any sprint. Open a sprint and use Plan sprint to pull them in.`
      : 'Every task is in a sprint.'));
  } else {
    info.replaceChildren(h('span', {}, sprints.length
      ? 'Every task on this team’s board, in all sprints and the backlog.'
      : 'Group this team’s tasks into sprints to focus on a few weeks of work at a time.'));
  }
  actions.push(h('button', { class: `btn${sprints.length ? '' : ' btn-primary'}`, onclick: () => openSprintDialog(null) }, '+ New sprint'));
  $('#sprint-actions').replaceChildren(...actions);
}

$('#sprint-view').addEventListener('change', (e) => chooseSprintView(e.target.value));

// Close buttons and backdrop clicks for the sprint dialogs.
for (const id of ['#sprint-dialog', '#plan-dialog', '#complete-dialog']) {
  $(id).addEventListener('click', (e) => {
    if (e.target === $(id) || e.target.closest('[data-close]')) $(id).close();
  });
}

// Create (sprint = null) or edit a sprint.
let editingSprintId = null;
function openSprintDialog(sprint) {
  editingSprintId = sprint?.id ?? null;
  const values = sprint ?? nextSprintDefaults(state);
  $('#sprint-dialog-title').textContent = sprint ? `Edit ${sprint.name}` : 'New sprint';
  $('#sprint-save').textContent = sprint ? 'Save changes' : 'Create sprint';
  $('#sprint-name').value = values.name;
  $('#sprint-start').value = values.startDate;
  $('#sprint-end').value = values.endDate;
  $('#sprint-goal').value = values.goal ?? '';
  $('#sprint-delete').hidden = !sprint;
  $('#sprint-error').hidden = true;
  $('#sprint-dialog').showModal();
  $('#sprint-name').focus();
}

$('#sprint-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const fields = {
    name: $('#sprint-name').value.trim(),
    startDate: $('#sprint-start').value,
    endDate: $('#sprint-end').value,
    goal: $('#sprint-goal').value.trim(),
  };
  if (fields.endDate < fields.startDate) {
    $('#sprint-error').textContent = 'The end date must be on or after the start date.';
    $('#sprint-error').hidden = false;
    return;
  }
  $('#sprint-dialog').close();
  if (editingSprintId) {
    commit(updateSprint(state, editingSprintId, fields));
    toast('Sprint updated');
    return;
  }
  const before = new Set(sprintsOf(state).map((sp) => sp.id));
  const next = addSprint(state, fields);
  const created = sprintsOf(next).find((sp) => !before.has(sp.id));
  commit(next);
  chooseSprintView(created.id);
  toast(`${created.name} created. Use Plan sprint to add tasks.`);
});

$('#sprint-delete').addEventListener('click', async () => {
  const sprint = getSprint(state, editingSprintId);
  if (!sprint) return;
  $('#sprint-dialog').close();
  const n = tasksInView(state, sprint.id).length;
  const ok = await ask({
    title: `Delete ${sprint.name}?`,
    message: n ? `Its ${n} task(s) aren’t deleted; they go back to the backlog.` : 'It has no tasks.',
    okLabel: 'Delete sprint',
    danger: true,
  });
  if (!ok) return;
  const before = state;
  commit(deleteSprint(state, sprint.id));
  toast(`Deleted ${sprint.name}`, { label: 'Undo', run: () => commit(before) });
});

// Sprint planning: tick the tasks that belong in the sprint.
let planningSprintId = null;
function openPlanDialog(sprint) {
  planningSprintId = sprint.id;
  $('#plan-title').textContent = `Plan ${sprint.name}`;
  $('#plan-search').value = '';
  const columnName = (id) => state.columns.find((c) => c.id === id)?.title ?? '';
  const row = (task, checked) => {
    const key = assigneeKey(task);
    return h('li', { dataset: { search: `${task.title} ${task.tags.join(' ')} ${key ? personFor(key).name : ''}`.toLowerCase() } },
      h('label', { class: 'plan-row' },
        h('input', { type: 'checkbox', value: task.id, checked, onchange: updatePlanCount }),
        task.type ? h('span', { class: `type-badge type-${task.type}` }, TASK_TYPE_LABELS[task.type]) : h('span'),
        h('span', { class: 'plan-title' }, task.title),
        h('span', { class: 'plan-meta' }, [columnName(task.status), key ? shortName(personFor(key).name) : null].filter(Boolean).join(' · '))));
  };
  const inSprint = state.tasks.filter((t) => t.sprintId === sprint.id);
  const backlog = state.tasks.filter((t) => !t.sprintId && t.status !== DONE_COLUMN_ID);
  const elsewhere = state.tasks.filter((t) => t.sprintId && t.sprintId !== sprint.id
    && t.status !== DONE_COLUMN_ID && getSprint(state, t.sprintId)?.status !== 'completed');
  const group = (title, tasks, checked) => (tasks.length
    ? h('section', { class: 'plan-group' }, h('h3', {}, `${title} (${tasks.length})`), h('ul', {}, tasks.map((t) => row(t, checked))))
    : null);
  const groups = [
    group(`In ${sprint.name}`, inSprint, true),
    group('Backlog', backlog, false),
    ...sprintsOf(state).filter((sp) => sp.id !== sprint.id)
      .map((sp) => group(`In ${sp.name}`, elsewhere.filter((t) => t.sprintId === sp.id), false)),
  ].filter(Boolean);
  $('#plan-list').replaceChildren(...(groups.length ? groups
    : [h('p', { class: 'plan-empty' }, 'There are no open tasks to plan. Add tasks to the board first.')]));
  updatePlanCount();
  $('#plan-dialog').showModal();
  $('#plan-search').focus();
}

function updatePlanCount() {
  const n = $('#plan-list').querySelectorAll('input:checked').length;
  $('#plan-count').textContent = `${n} task${n === 1 ? '' : 's'} in this sprint`;
}

$('#plan-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  for (const li of $('#plan-list').querySelectorAll('li')) li.hidden = Boolean(q) && !li.dataset.search.includes(q);
});

$('#plan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ids = [...$('#plan-list').querySelectorAll('input:checked')].map((i) => i.value);
  $('#plan-dialog').close();
  const before = state;
  commit(setSprintTasks(state, planningSprintId, ids));
  toast(`Saved plan for ${getSprint(state, planningSprintId)?.name}`, { label: 'Undo', run: () => commit(before) });
});

// Completing: choose where unfinished tasks go.
let completingSprintId = null;
function openCompleteDialog(sprint) {
  completingSprintId = sprint.id;
  const tasks = tasksInView(state, sprint.id);
  const unfinished = tasks.filter((t) => t.status !== DONE_COLUMN_ID).length;
  $('#complete-title').textContent = `Complete ${sprint.name}?`;
  $('#complete-summary').textContent = unfinished
    ? `${tasks.length - unfinished} of ${tasks.length} tasks are done. Finished tasks stay in this sprint as a record.`
    : `All ${tasks.length} tasks are done.`;
  $('#complete-move-field').hidden = !unfinished;
  $('#complete-move-field span').textContent = `Move ${unfinished} unfinished task${unfinished === 1 ? '' : 's'} to`;
  const planned = sprintsOf(state).filter((sp) => sp.status === 'planned');
  $('#complete-move').replaceChildren(
    ...planned.map((sp) => h('option', { value: sp.id }, sp.name)),
    h('option', { value: '__new' }, `A new sprint (${nextSprintDefaults(state).name})`),
    h('option', { value: '' }, 'The backlog'),
  );
  $('#complete-dialog').showModal();
}

$('#complete-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#complete-dialog').close();
  const sprint = getSprint(state, completingSprintId);
  if (!sprint) return;
  let next = state;
  let moveTo = $('#complete-move-field').hidden ? '' : $('#complete-move').value;
  if (moveTo === '__new') {
    const before = new Set(sprintsOf(next).map((sp) => sp.id));
    next = addSprint(next, nextSprintDefaults(next));
    moveTo = sprintsOf(next).find((sp) => !before.has(sp.id)).id;
  }
  const moved = tasksInView(next, sprint.id).filter((t) => t.status !== DONE_COLUMN_ID).length;
  const previous = state;
  commit(completeSprint(next, sprint.id, moveTo));
  const target = getSprint(state, moveTo);
  toast(`${sprint.name} completed${moved ? `. ${moved} unfinished task(s) moved to ${target ? target.name : 'the backlog'}` : ''}`,
    { label: 'Undo', run: () => commit(previous) });
  if (target) chooseSprintView(target.id);
});

// ---------- rendering ----------

function render() {
  const welcome = $('#welcome');
  welcome.hidden = !(teamId && state.tasks.length === 0);
  if (!welcome.hidden) {
    $('#welcome-title').textContent = `${currentTeam()?.name ?? 'This team'} has no tasks yet`;
  }
  renderSprintBar();
  renderStats();
  renderFilters();
  renderBoard();
  refreshPeople();
}

function renderStats() {
  const s = getStats(viewState());
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
    h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, 'Open tasks'),
      h('div', { class: 'stat-value' }, s.open),
      h('div', { class: 'stat-sub' }, `${inProgress} in progress`),
      h('div', { class: 'type-counts' },
        TASK_TYPES.map((type) => h('span', {
          class: `type-${type}`,
          title: `Open ${TASK_TYPE_LABELS[type].toLowerCase()} tasks`,
        }, `${s.byType[type]} ${TASK_TYPE_LABELS[type].toLowerCase()}${s.byType[type] === 1 ? '' : 's'}`)))),
    tile('Overdue', s.overdue, s.overdue ? 'needs attention' : 'all on track', s.overdue ? 'stat-alert' : ''),
    tile('Due soon', s.dueSoon, 'next 2 days', s.dueSoon ? 'stat-warn' : ''),
    progress,
    distribution,
    renderPeopleStat(),
  );
}

// Open tasks per person; clicking a row filters the board to them.
function renderPeopleStat() {
  const load = workload(viewState());
  const unassigned = load.get('') ?? 0;
  const rows = [...load].filter(([key]) => key).sort((a, b) => b[1] - a[1]);
  const shown = rows.slice(0, 4);
  const max = Math.max(1, ...rows.map(([, n]) => n), unassigned);
  const row = (key, person, n) => {
    const active = filter.assignee === key;
    return h('li', {},
      h('button', {
        class: `person-row${active ? ' is-active' : ''}`,
        'aria-pressed': String(active),
        title: active ? 'Show everyone' : `Show only ${person ? person.name : 'unassigned'} tasks`,
        onclick: () => {
          filter.assignee = active ? '' : key;
          render();
        },
      },
      person ? avatarEl(person, 'avatar small') : h('span', { class: 'avatar small is-none' }, '–'),
      h('span', { class: 'person-name' }, person ? (person.isMe ? `${person.name} (you)` : person.name) : 'Unassigned'),
      h('span', { class: 'person-bar' }, h('i', { style: `width:${Math.round((n / max) * 100)}%` })),
      h('span', { class: 'person-count' }, n)));
  };
  return h('div', { class: 'stat stat-wide stat-people' },
    h('div', { class: 'stat-label' }, 'Open tasks by person'),
    rows.length || unassigned
      ? h('ul', { class: 'people-list' },
        shown.map(([key, n]) => row(key, personFor(key), n)),
        unassigned ? row('none', null, unassigned) : null)
      : h('div', { class: 'stat-sub' }, 'No open tasks'),
    rows.length > shown.length ? h('div', { class: 'stat-sub' }, `+${rows.length - shown.length} more in the filter above`) : null);
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
  const options = [
    ['', 'Everyone'],
    ...(identity ? [['me', 'Assigned to me']] : []),
    ['none', 'Unassigned'],
    ...allAssigneeKeys(state)
      .map((key) => [key, personFor(key).name])
      .sort((a, b) => a[1].localeCompare(b[1])),
  ];
  if (!options.some(([v]) => v === filter.assignee)) filter.assignee = '';
  $('#filter-assignee').replaceChildren(...options.map(([value, label]) => h('option', { value, selected: value === filter.assignee }, label)));
  fillSelect($('#filter-tag'), 'All tags', allTags(state), filter.tag);
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
  const all = tasksInColumn(viewState(), column.id);
  const ctx = peopleContext();
  const visible = all.filter((t) => matchesFilter(t, filter, undefined, ctx));
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
    'aria-label': `${task.title}, ${task.type ? `${TASK_TYPE_LABELS[task.type]}, ` : ''}${task.priority} priority, ${assigneeKey(task) ? `assigned to ${personFor(assigneeKey(task)).name}` : 'unassigned'}`,
    onkeydown: (e) => onCardKey(e, task),
  },
  h('div', { class: 'card-top' },
    h('span', { class: 'card-badges' },
      task.type ? h('span', { class: `type-badge type-${task.type}` }, TASK_TYPE_LABELS[task.type]) : null,
      h('span', { class: `badge badge-${task.priority}` }, task.priority)),
    task.dueDate ? h('span', {
      class: `due${overdue ? ' due-overdue' : soon ? ' due-soon' : ''}`,
      title: overdue ? 'Overdue' : 'Due date',
    }, formatDue(task.dueDate)) : null),
  h('h4', { class: 'card-title' }, task.title),
  task.description ? h('p', { class: 'card-desc' }, task.description) : null,
  h('div', { class: 'card-bottom' },
    h('div', { class: 'tags' },
      currentView() === 'all' && task.sprintId
        ? h('span', { class: 'card-sprint', title: 'Sprint' }, getSprint(state, task.sprintId)?.name) : null,
      task.tags.map((t) => h('span', { class: 'tag', style: `--hue:${hue(t)}` }, t))),
    renderAssignee(task)));
}

function renderAssignee(task) {
  const key = assigneeKey(task);
  if (!key) return h('span', { class: 'assignee is-none' }, 'Unassigned');
  const person = personFor(key);
  return h('span', { class: `assignee${person.isMe ? ' is-me' : ''}`, title: `Assigned to ${person.name}` },
    avatarEl(person, 'avatar small'),
    h('span', { class: 'assignee-name' }, person.isMe ? 'You' : shortName(person.name)));
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
  const sprintOptions = sprintsOf(state).filter((sp) => sp.status !== 'completed' || sp.id === task?.sprintId);
  form.sprint.replaceChildren(
    h('option', { value: '' }, 'No sprint (backlog)'),
    ...sprintOptions.map((sp) => h('option', { value: sp.id }, `${sp.name}${sp.status === 'active' ? ' (active)' : ''}`)),
  );
  form.sprint.value = task ? task.sprintId : defaultSprintForNewTask();
  // Set each radio directly: assigning '' to the group's value doesn't
  // select the "None" option.
  for (const radio of form.type) radio.checked = radio.value === (task?.type ?? '');
  form.dueDate.value = task?.dueDate ?? '';
  draftAssignee = task?.assigneeId ? { id: task.assigneeId } : task?.assignee ? { name: task.assignee } : null;
  $('#assignee-input').value = '';
  resultItems = [];
  renderResults();
  renderChosen();
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
    type: TASK_TYPES.includes(form.type.value) ? form.type.value : '',
    sprintId: getSprint(state, form.sprint.value) ? form.sprint.value : '',
    dueDate: form.dueDate.value,
    tags: normalizeTags(form.tags.value),
  };
  const leftover = $('#assignee-input').value.trim();
  if (!draftAssignee && leftover) draftAssignee = { name: leftover };
  fields.assigneeId = draftAssignee?.id ?? '';
  fields.assignee = draftAssignee?.name ?? '';
  if (!fields.title) {
    form.title.focus();
    return;
  }
  commit(editingId ? updateTask(state, editingId, fields) : addTask(state, fields));
  toast(editingId ? 'Task updated' : 'Task created');
  dialog.close();
});

// ---------- assignee picker ----------
// Hosted on claude.ai it searches people in the organization; everywhere
// it also offers names already used on the board, or any typed name.

let draftAssignee = null; // { id } | { name } | null
let resultItems = [];
let activeResult = 0;

const keyOf = (item) => (item.id ? `id:${item.id}` : `name:${item.name}`);

function renderChosen() {
  const chosen = $('#assignee-chosen');
  const input = $('#assignee-input');
  if (draftAssignee) {
    const person = personFor(keyOf(draftAssignee));
    chosen.replaceChildren(
      avatarEl(person, 'avatar small'),
      h('span', { class: 'chosen-name' }, person.isMe ? `${person.name} (you)` : person.name),
      h('button', {
        type: 'button',
        class: 'chip-clear',
        'aria-label': 'Remove assignee',
        onclick: () => {
          draftAssignee = null;
          renderChosen();
          input.focus();
        },
      }, '✕'));
  }
  chosen.hidden = !draftAssignee;
  input.hidden = Boolean(draftAssignee);
  $('#assign-me').hidden = !identity || Boolean(draftAssignee && personFor(keyOf(draftAssignee)).isMe);
}

async function updateResults() {
  const input = $('#assignee-input');
  const query = input.value.trim();
  const lower = query.toLowerCase();
  const items = [];
  if (userApi) {
    // With nothing typed, suggest this team's members first.
    const members = membersEnabled() ? teamMembers(currentTeam()) : [];
    const [hits, profiles] = await Promise.all([
      userApi.search(query),
      !query && members.length ? userApi.profiles(members) : null,
    ]);
    if (input.value.trim() !== query) return;
    for (const p of [...Object.values(profiles ?? {}), ...hits]) {
      if (!p.id || (!p.name && !members.includes(p.id))) continue;
      people.set(p.id, { name: p.name, avatarUrl: p.avatarUrl, color: p.color });
      if (!items.some((it) => it.id === p.id)) items.push({ id: p.id });
    }
  }
  for (const key of allAssigneeKeys(state)) {
    if (!key.startsWith('name:')) continue;
    const name = key.slice(5);
    if (!lower || name.toLowerCase().includes(lower)) items.push({ name });
  }
  if (query && !items.some((it) => personFor(keyOf(it)).name.toLowerCase() === lower)) {
    items.push({ name: query, isNew: true });
  }
  resultItems = items.slice(0, 8);
  activeResult = 0;
  renderResults();
}

function renderResults() {
  const box = $('#assignee-results');
  const input = $('#assignee-input');
  const open = document.activeElement === input && resultItems.length > 0;
  box.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  box.replaceChildren(...resultItems.map((item, i) => {
    const person = personFor(keyOf(item));
    return h('button', {
      type: 'button',
      role: 'option',
      class: `result${i === activeResult ? ' is-active' : ''}`,
      'aria-selected': String(i === activeResult),
      onmousedown: (e) => e.preventDefault(),
      onclick: () => chooseAssignee(item),
    },
    item.isNew ? null : avatarEl(person, 'avatar small'),
    item.isNew ? `Use “${item.name}” as a name` : (person.isMe ? `${person.name} (you)` : person.name),
    item.id && notOnTeam(item.id) ? h('span', { class: 'result-note' }, 'not on this team') : null);
  }));
}

// True when the team has members and this person isn't one of them, so
// they wouldn't see the task.
function notOnTeam(id) {
  if (!membersEnabled()) return false;
  const members = teamMembers(currentTeam());
  return members.length > 0 && !members.includes(id);
}

function chooseAssignee(item) {
  draftAssignee = item.id ? { id: item.id } : { name: item.name };
  $('#assignee-input').value = '';
  resultItems = [];
  renderResults();
  renderChosen();
}

$('#assignee-input').addEventListener('focus', updateResults);
$('#assignee-input').addEventListener('input', updateResults);
$('#assignee-input').addEventListener('blur', () => setTimeout(renderResults));
$('#assignee-input').addEventListener('keydown', (e) => {
  const open = !$('#assignee-results').hidden;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!resultItems.length) return;
    e.preventDefault();
    activeResult = (activeResult + (e.key === 'ArrowDown' ? 1 : -1) + resultItems.length) % resultItems.length;
    renderResults();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (open && resultItems[activeResult]) chooseAssignee(resultItems[activeResult]);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    resultItems = [];
    renderResults();
  }
});

$('#assign-me').addEventListener('click', () => {
  if (!identity) return;
  draftAssignee = identity.id && backend?.kind === 'cloud' ? { id: identity.id } : { name: identity.name };
  renderChosen();
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
  const sprintId = defaultSprintForNewTask();
  commit(addTask(state, { title, status: columnId, sprintId }));
  if (!sprintId && !['all', 'backlog'].includes(currentView())) toast('Added to the backlog (this sprint is completed)');
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
  showPopupMenu(anchor, items);
}

// items: [label, run, className?][]
function showPopupMenu(anchor, items) {
  closePopups();
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

for (const key of ['priority', 'type', 'assignee', 'tag', 'due']) {
  $(`#filter-${key}`).addEventListener('change', (e) => {
    filter[key] = e.target.value;
    render();
  });
}

$('#clear-filters').addEventListener('click', () => {
  filter = { ...EMPTY_FILTER };
  $('#search').value = '';
  $('#filter-priority').value = '';
  $('#filter-type').value = '';
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
  if (document.body.dataset.view !== 'app' || !teamId) return;
  if (document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
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

// Works out who is using the app and where boards are stored.
// - Hosted on claude.ai: the viewer's claude.ai account (their company SSO
//   when their organization uses one); teams and boards are shared through
//   the page's database.
// - Self-hosted with SSO_PROVIDERS configured: OpenID Connect sign-in;
//   teams and boards are kept in this browser.
// - Otherwise: no sign-in, teams and boards in this browser.
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
      canSignOut: true,
    };
  }

  let db = null;
  if (hosted) {
    [userApi, db] = await Promise.all([claudeUse('user'), claudeUse('db')]);
    const me = userApi ? await userApi.me() : null;
    if (me?.id) {
      identity = {
        id: me.id,
        name: me.name || 'You',
        detail: 'Signed in with your Claude account',
        avatarUrl: me.avatarUrl,
        color: me.color,
        canSignOut: false,
      };
    }
    canManageTeams = Boolean(me?.canEdit);
  }

  if (db) {
    backend = createCloudBackend(db, storage, { onStatus: setSyncStatus, onWriteError });
  } else {
    backend = createLocalBackend(storage);
    canManageTeams = true;
    setSyncStatus('Saved in this browser');
  }

  document.body.dataset.view = 'app';
  renderAccount();
  renderTeams();
  backend.subscribeTeams(onTeams, () => setSyncStatus('Not synced', 'warn'));
}

$('#no-teams-create').addEventListener('click', promptNewTeam);

boot();
