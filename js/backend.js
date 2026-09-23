// Where teams and their boards are stored. Both backends expose the same
// interface, so the UI doesn't care which one it talks to:
//
//   kind                'local' | 'cloud'
//   subscribeTeams(fn)  fn(teams) now and on every change; returns unsubscribe
//   createTeam(name, members)  resolves the new team's id
//   renameTeam(id, name), setMembers(id, members), deleteTeam(id)
//   openBoard(teamId, fn)  fn(boardState) whenever the board changes
//                          remotely; returns unsubscribe
//   saveBoard(teamId, state)
//   cachedBoard(teamId) this browser's last copy of the board, or null
//
// Boards live apart from the team list so renaming a team and editing
// its tasks never overwrite each other.

import {
  STORAGE_KEY, loadState, saveState, normalizeState, createEmptyState, createSampleState, uid,
} from './store.js';

const TEAMS_KEY = 'taskflow.teams.v1';
// The board from before teams existed becomes the first team's board.
export const FIRST_TEAM_ID = 'main';
export const FIRST_TEAM_NAME = 'My team';

export const boardKey = (teamId) => `${STORAGE_KEY}:team:${teamId}`;

export function cleanTeamName(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

// Team members are account ids. Only members (and people who manage
// teams) are shown a team; see visibleTeams.
export function cleanMembers(members) {
  return [...new Set((Array.isArray(members) ? members : []).filter((m) => typeof m === 'string' && m))];
}

// The teams a person should see: everything for those who manage teams,
// otherwise only teams listing them as a member. This is what the page
// shows, not an access control: the data itself is readable by everyone
// who can open the page.
export function visibleTeams(teams, { userId = null, canManage = false } = {}) {
  if (canManage) return teams;
  return teams.filter((t) => userId && cleanMembers(t.members).includes(userId));
}

export function sortTeams(teams) {
  return [...teams].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))
    || String(a.name).localeCompare(String(b.name)));
}

function readTeams(storage) {
  try {
    const list = JSON.parse(storage?.getItem(TEAMS_KEY) ?? 'null');
    return Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string') : null;
  } catch {
    return null;
  }
}

function writeTeams(storage, teams) {
  try { storage?.setItem(TEAMS_KEY, JSON.stringify(teams)); } catch { /* storage full or blocked */ }
}

// ---------- this browser only ----------

export function createLocalBackend(storage, events = globalThis.window) {
  let teams = readTeams(storage);
  if (!teams) {
    // First run with teams: move the old single board into the first team.
    teams = [{ id: FIRST_TEAM_ID, name: FIRST_TEAM_NAME, createdAt: new Date().toISOString() }];
    if (!loadState(storage, boardKey(FIRST_TEAM_ID))) {
      saveState(storage, loadState(storage) ?? createSampleState(), boardKey(FIRST_TEAM_ID));
    }
    writeTeams(storage, teams);
  }
  const teamListeners = new Set();
  const emit = () => teamListeners.forEach((fn) => fn(teams));
  const setTeams = (next) => {
    teams = sortTeams(next);
    writeTeams(storage, teams);
    emit();
  };

  // Other tabs of this browser.
  events?.addEventListener?.('storage', (e) => {
    if (e.storageArea === storage && e.key === TEAMS_KEY) {
      teams = readTeams(storage) ?? [];
      emit();
    }
  });

  return {
    kind: 'local',
    subscribeTeams(fn) {
      teamListeners.add(fn);
      fn(teams);
      return () => teamListeners.delete(fn);
    },
    async createTeam(name, members = []) {
      const team = {
        id: uid('team'), name: cleanTeamName(name), members: cleanMembers(members), createdAt: new Date().toISOString(),
      };
      saveState(storage, createEmptyState(), boardKey(team.id));
      setTeams([...teams, team]);
      return team.id;
    },
    async renameTeam(id, name) {
      setTeams(teams.map((t) => (t.id === id ? { ...t, name: cleanTeamName(name) } : t)));
    },
    async setMembers(id, members) {
      setTeams(teams.map((t) => (t.id === id ? { ...t, members: cleanMembers(members) } : t)));
    },
    async deleteTeam(id) {
      try { storage?.removeItem(boardKey(id)); } catch { /* ignore */ }
      setTeams(teams.filter((t) => t.id !== id));
    },
    openBoard(teamId, fn) {
      const onStorage = (e) => {
        if (e.storageArea !== storage || e.key !== boardKey(teamId)) return;
        const next = loadState(storage, boardKey(teamId));
        if (next) fn(next);
      };
      events?.addEventListener?.('storage', onStorage);
      return () => events?.removeEventListener?.('storage', onStorage);
    },
    saveBoard(teamId, state) {
      saveState(storage, state, boardKey(teamId));
    },
    cachedBoard(teamId) {
      return loadState(storage, boardKey(teamId));
    },
  };
}

// ---------- shared, through the page's database ----------

// db: the `db` capability. onStatus(text, mode) reports sync state;
// onWriteError(err) is told when a board can't be saved.
export function createCloudBackend(db, storage, { onStatus = () => {}, onWriteError = () => {} } = {}) {
  // Latest unsaved board per document path, in the order they were queued.
  const writes = { pending: new Map(), running: false, inflightPath: null };

  async function setWithRetry(ref, data) {
    try {
      await ref.set(data);
    } catch (err) {
      if (err?.code !== 'unavailable') throw err;
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
      await ref.set(data);
    }
  }

  // One write in flight at a time; a burst of edits to one board collapses
  // into one write of its latest state. Boards are queued separately, so
  // switching teams mid-save never drops the other team's changes.
  async function flush() {
    if (writes.running) return;
    writes.running = true;
    while (writes.pending.size) {
      const [path, data] = writes.pending.entries().next().value;
      writes.pending.delete(path);
      writes.inflightPath = path;
      onStatus('Saving…', 'busy');
      try {
        await setWithRetry(db.doc(path), data);
        onStatus('Synced', 'ok');
      } catch (err) {
        onStatus(err?.code === 'invalid_argument' ? 'Read-only' : 'Not synced', 'warn');
        onWriteError(err);
      }
    }
    writes.inflightPath = null;
    writes.running = false;
  }

  const busyWith = (path) => writes.inflightPath === path || writes.pending.has(path);

  return {
    kind: 'cloud',
    subscribeTeams(fn, onError) {
      return db.collection('teams').onSnapshot((snap) => {
        // A cached empty list may just mean "not loaded yet".
        if (snap.empty && snap.metadata.fromCache) return;
        fn(sortTeams(snap.docs.map((d) => ({ ...d.data(), id: d.id }))));
      }, onError);
    },
    async createTeam(name, members = []) {
      const ref = db.collection('teams').doc();
      await db.doc(`boards/${ref.id}`).set(createEmptyState());
      await ref.set({ name: cleanTeamName(name), members: cleanMembers(members), createdAt: new Date().toISOString() });
      return ref.id;
    },
    async renameTeam(id, name) {
      await db.doc(`teams/${id}`).update({ name: cleanTeamName(name) });
    },
    async setMembers(id, members) {
      await db.doc(`teams/${id}`).update({ members: cleanMembers(members) });
    },
    async deleteTeam(id) {
      await db.doc(`teams/${id}`).delete();
      await db.doc(`boards/${id}`).delete();
      try { storage?.removeItem(boardKey(id)); } catch { /* ignore */ }
    },
    openBoard(teamId, fn) {
      const path = `boards/${teamId}`;
      onStatus('Connecting…', 'busy');
      return db.doc(path).onSnapshot((snap) => {
        // Skip echoes of our own writes and states older than a queued one.
        if (snap.metadata.hasPendingWrites || busyWith(path)) return;
        if (!snap.exists) {
          if (snap.metadata.fromCache) return;
          onStatus('Synced', 'ok');
          fn(createEmptyState());
          return;
        }
        let board;
        try {
          board = normalizeState(snap.data());
        } catch {
          return;
        }
        onStatus('Synced', 'ok');
        saveState(storage, board, boardKey(teamId));
        fn(board);
      }, () => onStatus('Not synced', 'warn'));
    },
    saveBoard(teamId, state) {
      saveState(storage, state, boardKey(teamId));
      const path = `boards/${teamId}`;
      writes.pending.delete(path); // re-queue at the end with the newest state
      writes.pending.set(path, state);
      flush();
    },
    cachedBoard(teamId) {
      return loadState(storage, boardKey(teamId));
    },
  };
}
