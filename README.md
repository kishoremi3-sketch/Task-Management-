# TaskFlow: Task Management with a Kanban Dashboard

TaskFlow is a lightweight task manager. Its home screen is a Kanban board with a summary dashboard above it. It runs entirely in the browser with no build step and no dependencies. Your board is saved in `localStorage`.

## Features

- **Dashboard summary**: open tasks, in-progress count, overdue and due-soon alerts, a completion progress bar, and a workflow breakdown by column.
- **Kanban board**: Backlog → To Do → In Progress → Review → Done. You can add, rename, and delete columns, and set WIP limits (a column is highlighted when it goes over its limit).
- **Drag & drop**: move cards within and across columns with a mouse, pen, or touch (long-press on mobile). The board auto-scrolls near the edges.
- **Tasks**: title, description, status, priority (low/medium/high/urgent), type, due date, assignee, and tags. There's a full edit dialog, plus quick-add at the bottom of every column.
- **Search & filters**: free-text search plus filters for priority, assignee, tag, and due date (overdue / due soon / none).
- **Undo** for deletes, clears, imports, and resets.
- **Export / import** the board as JSON.
- **Light & dark themes**. The app follows your system setting until you toggle it.
- **Cross-tab sync**: changes in one tab show up in the others.
- **Teams**: create as many teams as you need. Each has its own shared board; switch between them with the tabs above the dashboard.
- **Team members** (hosted on claude.ai): add people to each team. Each person only sees the tabs and tasks of their own teams; people who can edit the page see every team so they can manage them. This controls what the page shows, not who can read the data: anyone with access to the page could still read other teams' tasks with developer tools.
- **Sprints**: each team plans its work in sprints. Pick a sprint in the sprint bar and the dashboard and board show only that sprint, with its dates, days left, goal and progress. **Plan sprint** pulls tasks in from the backlog (or out again), **Start sprint** makes it the active one, and **Complete sprint** keeps finished tasks as a record and moves unfinished ones to the next sprint or the backlog. You can also view **All tasks** or just the **Backlog**.
- **Task types**: mark a task as a **Project**, **Enhancement** or **Defect**. Each type has its own coloured label on the card, a filter, and open counts on the dashboard.
- **Assignees**: assign tasks to people (hosted on claude.ai: search your organization by name; elsewhere: type a name). Every card shows who owns it, "Open tasks by person" shows each person's workload (click a person to filter), and there's an "Assigned to me" filter.
- **Sign-in**: people sign in and their name and avatar appear in the top bar (see [Sign-in](#sign-in)).
- **Cloud sync when hosted on claude.ai**: teams and boards are stored in the artifact's database and shared live with everyone who has access. Everywhere else they're kept in the browser.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `N` | New task |
| `/` | Focus search |
| `Enter` (on a card) | Edit task |
| `Delete` / `Backspace` (on a card) | Delete task (with undo) |
| `Alt + ←/→` (on a card) | Move to previous/next column |
| `Alt + ↑/↓` (on a card) | Reorder within the column |
| `Esc` | Close dialog / menu, cancel a drag |
| Double-click a column title | Rename column |

## Getting started

You need Node.js 18 or newer, and only for the local server and tests.

```bash
npm start          # serves the app at http://localhost:3000
npm start -- 8080  # or pick a port
npm test           # runs the unit tests
```

To get one self-contained file (inline CSS and JS) that opens straight from disk with no server, run `npm run build` and open `dist/taskflow.html`.

The app is plain static files, so you can also host it with any static server (GitHub Pages, Netlify, `python3 -m http.server`, …). It uses ES modules, so it must be served over HTTP; opening `index.html` directly from disk won't work.

On first launch the board is filled with sample tasks. You can clear them with **⋯ → Delete all tasks**, and bring them back with **⋯ → Load sample data**.

## Sign-in

TaskFlow chooses how people sign in based on where it runs:

| Where it runs | How people sign in | Where teams and boards are kept | Who manages teams |
| --- | --- | --- | --- |
| claude.ai artifact | Their claude.ai account, which uses your company SSO if your organization has it set up | The artifact's database, shared with everyone who has access | The owner and people with edit access |
| Self-hosted, SSO configured | "Continue with …" buttons (OpenID Connect) | That browser | Anyone signed in |
| Self-hosted, no SSO configured | No sign-in | That browser | Anyone |

### Setting up SSO for a self-hosted copy

1. In your identity provider (Microsoft Entra ID, Okta, Auth0, Keycloak, or any OpenID Connect provider), register a **single-page application**: a public client using the authorization code flow with PKCE and no client secret.
2. Add the exact URL you serve TaskFlow from as a redirect URI, e.g. `https://tasks.example.com/` (and `http://localhost:3000/` for local testing). Add the same URL as a post-logout redirect URI.
3. Add the provider to `SSO_PROVIDERS` in `js/auth-config.js`. The file has ready-to-fill examples for each provider. You can list several providers; each gets its own button.

Google can't be used directly: its token endpoint requires a client secret, which a browser-only app can't keep. Connect Google Workspace through Auth0, Okta or Keycloak instead.

**Security note:** a self-hosted copy stores teams and boards in the browser, so sign-in only identifies people (their name, and "Assign to me"); it doesn't share boards between computers. The ID token's issuer, audience, nonce and expiry are checked, but its signature is not verified in the browser. For shared team boards in a self-hosted setup, add a backend that verifies tokens and stores the boards. The claude.ai-hosted version already shares boards through its database, which only lets the owner and editors change the team list.

## Project structure

```
index.html          App shell, task dialog
css/styles.css      Styles (light/dark themes, responsive layout)
js/store.js         Pure state logic: tasks, columns, filters, stats, persistence
js/app.js           UI: rendering, drag & drop, dialogs, shortcuts, start-up
js/auth.js          OpenID Connect sign-in (authorization code + PKCE)
js/backend.js       Where teams and boards are stored: browser or shared database
js/auth-config.js   SSO provider settings (empty = no sign-in)
server.js           Zero-dependency static file server
scripts/build.js    Bundles everything into a single HTML file
tests/*.test.js     Unit tests for the state logic and sign-in checks (node:test)
```

`js/store.js` has no DOM access. Every mutation returns a new state object, which keeps the logic easy to test and makes undo simple.
