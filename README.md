# TaskFlow: Task Management with a Kanban Dashboard

TaskFlow is a lightweight task manager. Its home screen is a Kanban board with a summary dashboard above it. It runs entirely in the browser with no build step and no dependencies. Your board is saved in `localStorage`.

## Features

- **Dashboard summary**: open tasks, in-progress count, overdue and due-soon alerts, a completion progress bar, and a workflow breakdown by column.
- **Kanban board**: Backlog → To Do → In Progress → Review → Done. You can add, rename, and delete columns, and set WIP limits (a column is highlighted when it goes over its limit).
- **Drag & drop**: move cards within and across columns with a mouse, pen, or touch (long-press on mobile). The board auto-scrolls near the edges.
- **Tasks**: title, description, status, priority (low/medium/high/urgent), due date, assignee, and tags. There's a full edit dialog, plus quick-add at the bottom of every column.
- **Search & filters**: free-text search plus filters for priority, assignee, tag, and due date (overdue / due soon / none).
- **Undo** for deletes, clears, imports, and resets.
- **Export / import** the board as JSON.
- **Light & dark themes**. The app follows your system setting until you toggle it.
- **Cross-tab sync**: changes in one tab show up in the others.
- **Cloud sync when hosted on claude.ai**: when the page runs as a claude.ai artifact, the board is stored in the artifact's database, so it follows you across devices. Everywhere else it uses the browser's own storage.

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

## Project structure

```
index.html          App shell, task dialog
css/styles.css      Styles (light/dark themes, responsive layout)
js/store.js         Pure state logic: tasks, columns, filters, stats, persistence
js/app.js           UI: rendering, drag & drop, dialogs, shortcuts
server.js           Zero-dependency static file server
scripts/build.js    Bundles everything into a single HTML file
tests/store.test.js Unit tests for the state logic (node:test)
```

`js/store.js` has no DOM access. Every mutation returns a new state object, which keeps the logic easy to test and makes undo simple.
