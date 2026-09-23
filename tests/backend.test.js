import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalBackend, createCloudBackend, boardKey, FIRST_TEAM_ID, FIRST_TEAM_NAME, cleanTeamName, sortTeams,
  cleanMembers, visibleTeams,
} from '../js/backend.js';
import { createEmptyState, addTask, saveState, STORAGE_KEY } from '../js/store.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
  };
}

const lastTeams = (backend) => {
  let teams;
  backend.subscribeTeams((t) => { teams = t; })();
  return teams;
};

test('local backend moves the pre-teams board into the first team', () => {
  const storage = memoryStorage();
  const old = addTask(createEmptyState(), { title: 'Old task', status: 'todo' });
  saveState(storage, old, STORAGE_KEY);
  const backend = createLocalBackend(storage, null);
  const teams = lastTeams(backend);
  assert.deepEqual(teams.map((t) => [t.id, t.name]), [[FIRST_TEAM_ID, FIRST_TEAM_NAME]]);
  assert.deepEqual(backend.cachedBoard(FIRST_TEAM_ID).tasks.map((t) => t.title), ['Old task']);
});

test('local backend keeps each team’s board separate', async () => {
  const storage = memoryStorage();
  const backend = createLocalBackend(storage, null);
  const id = await backend.createTeam('  Design   team ');
  assert.equal(lastTeams(backend).find((t) => t.id === id).name, 'Design team');
  assert.equal(backend.cachedBoard(id).tasks.length, 0);
  backend.saveBoard(id, addTask(createEmptyState(), { title: 'Mockups', status: 'todo' }));
  assert.deepEqual(backend.cachedBoard(id).tasks.map((t) => t.title), ['Mockups']);
  assert.notDeepEqual(backend.cachedBoard(FIRST_TEAM_ID).tasks.map((t) => t.title), ['Mockups']);

  await backend.renameTeam(id, 'Product design');
  assert.equal(lastTeams(backend).find((t) => t.id === id).name, 'Product design');
  await backend.deleteTeam(id);
  assert.ok(!lastTeams(backend).some((t) => t.id === id));
  assert.equal(storage.has(boardKey(id)), false);
});

test('local backend reuses an existing team list', async () => {
  const storage = memoryStorage();
  const first = createLocalBackend(storage, null);
  await first.createTeam('Ops');
  const second = createLocalBackend(storage, null);
  assert.deepEqual(lastTeams(second).map((t) => t.name).sort(), ['My team', 'Ops']);
});

test('cloud backend collapses bursts per board and never drops another team’s save', async () => {
  const sets = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const db = {
    doc: (path) => ({
      set: async (data) => { sets.push([path, data.tasks.length]); if (sets.length === 1) await gate; },
    }),
  };
  const backend = createCloudBackend(db, memoryStorage());
  const board = (n) => {
    let s = createEmptyState();
    for (let i = 0; i < n; i++) s = addTask(s, { title: `T${i}`, status: 'todo' });
    return s;
  };
  backend.saveBoard('a', board(1)); // starts writing immediately
  backend.saveBoard('a', board(2)); // queued
  backend.saveBoard('b', board(3)); // queued separately
  backend.saveBoard('a', board(4)); // replaces a's queued state
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sets, [['boards/a', 1], ['boards/b', 3], ['boards/a', 4]]);
});

test('team helpers', () => {
  assert.equal(cleanTeamName('  a \n b '), 'a b');
  assert.equal(cleanTeamName('x'.repeat(100)).length, 60);
  assert.deepEqual(sortTeams([
    { id: '2', name: 'B', createdAt: '2026-02-01' },
    { id: '1', name: 'A', createdAt: '2026-01-01' },
  ]).map((t) => t.id), ['1', '2']);
});

test('people only see teams they are members of, unless they manage teams', () => {
  const teams = [
    { id: 'a', name: 'Design', members: ['u_1', 'u_2'] },
    { id: 'b', name: 'Sales', members: ['u_3'] },
    { id: 'c', name: 'New team' },
  ];
  assert.deepEqual(visibleTeams(teams, { userId: 'u_1' }).map((t) => t.id), ['a']);
  assert.deepEqual(visibleTeams(teams, { userId: 'u_3' }).map((t) => t.id), ['b']);
  assert.deepEqual(visibleTeams(teams, { userId: 'u_9' }), []);
  assert.deepEqual(visibleTeams(teams, { userId: null }), []);
  assert.deepEqual(visibleTeams(teams, { userId: 'u_9', canManage: true }).map((t) => t.id), ['a', 'b', 'c']);
});

test('members are de-duplicated and saved per team', async () => {
  assert.deepEqual(cleanMembers(['u_1', 'u_1', '', null, 'u_2']), ['u_1', 'u_2']);
  assert.deepEqual(cleanMembers(undefined), []);
  const backend = createLocalBackend(memoryStorage(), null);
  const id = await backend.createTeam('Ops', ['u_1']);
  await backend.setMembers(id, ['u_1', 'u_2', 'u_2']);
  assert.deepEqual(lastTeams(backend).find((t) => t.id === id).members, ['u_1', 'u_2']);
});
