# Darkhan UI Development Guide

Welcome to the Darkhan UI workspace. This folder contains the entire frontend — it's a vanilla JS single-page app with no build tools, no framework, and no npm dependencies.

## What's Here

```
client/
  index.html      — App shell (94 lines). Loads app.js and style.css.
  js/app.js        — All UI logic (1270 lines). Vanilla JS, Socket.IO client.
  css/style.css    — All styling (514 lines). Dark theme, CSS variables.
  manifest.json    — PWA manifest.
  sw.js            — Service worker for offline support.
```

## Quick Start (no server needed)

You can preview the UI layout and styling without the backend:

```bash
# Option 1: Python (comes with every Mac)
cd client
python3 -m http.server 8080
# Open http://localhost:8080

# Option 2: Just open index.html directly
open index.html
```

The app will show the login screen and UI shell. Without the backend running, API calls will fail — but you can see and edit all the layout, styling, and component structure.

## How the UI Works

### Architecture
- **No framework.** Pure HTML + CSS + vanilla JavaScript.
- **Single HTML file** loads everything. No routing library.
- **Socket.IO** for real-time updates (loaded from CDN).
- **CSS variables** control the theme (see `:root` in style.css).
- **Dark theme** by default. All colors are in CSS variables.

### Key Views (in app.js)
The app has these views, switched by `showView()`:

| View | Function | What It Shows |
|------|----------|---------------|
| `login` | Login screen | Username + password form |
| `channels` | Main view | Channel list + message feed + input |
| `tasks` | Task board | Kanban-style task cards |
| `health` | Agent dashboard | Agent status lights (green/amber/red) |
| `vault` | Knowledge base | File browser + markdown renderer |
| `costs` | Cost tracking | Per-agent token usage charts |
| `settings` | Admin panel | Password, PIN, lockdown controls |

### Making Changes

**To change colors/theme:**
Edit CSS variables in `css/style.css` under `:root`.

**To change layout:**
Edit `index.html` for structure, `css/style.css` for positioning.

**To add a new view:**
1. Add a nav item in `index.html`
2. Add a `<div id="view-yourview">` container
3. Add a `showYourView()` function in `app.js`
4. Wire the nav click in `setupNav()`

**To modify an existing view:**
Find the `show[ViewName]()` function in `app.js`. Each view function fetches data from the API and renders HTML into its container div.

## Design Guidelines

- **Dark theme first.** Light backgrounds are not on-brand.
- **Monospace for data.** Use `font-family: var(--font-mono)` for code, logs, hashes.
- **Status colors:** Green = healthy, Amber = warning, Red = critical. These are CSS variables.
- **No external dependencies** besides Socket.IO (CDN). No React, no Tailwind, no build step.
- **Mobile-responsive.** Test at 375px width minimum.

## Git Workflow

You're on the `ui-workspace` branch. Make your changes here:

```bash
git add -A
git commit -m "Description of UI changes"
git push origin ui-workspace
```

Claude will review your changes and merge into `main` when ready.

## Questions?

Ask Adrian or post in #chan_command on Darkhan.
