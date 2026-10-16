# Todo — a menu bar app

A small, modern todo list that lives in the macOS menu bar. Click the check
mark icon to open today's list in a popover; click outside to dismiss it. The
popover holds two views: the day's list, and a markdown note for the day.

Built with [MyGo](https://mygo.egoist.dev) — a native status bar icon and
popover, with the panel's contents drawn as an embedded web page (the same
approach as MyGo's own `examples/todo`).

## Features

- **Menu bar native** — a status bar icon with no Dock icon
  (`LSUIElement` + `ActivationPolicyAccessory`). The popover is built once
  and shown/hidden, so reopening is instant.
- **Animated ticks** — clicking a task draws the check and sweeps a
  strikethrough across the title.
- **Daily reset** — the list is today's list. A background goroutine wakes
  once a day at local midnight and clears it; a stale list from an earlier
  day is dropped on launch too. The footer shows a countdown to the reset.
- **Daily notes in markdown** — the Notes tab is one note per day, written
  in a plain textarea and read as rendered markdown: headings, lists, task
  lists, emphasis, quotes, code and links. No markdown dependency; the
  renderer is `frontend/src/markdown.ts`, and it escapes the text it renders,
  so a note can only ever draw itself.
- **Read and write in one place** — there is no mode to switch. A note opens
  as rendered markdown, and one click anywhere in it goes back to writing,
  with the caret where the writing was left. Writing lasts until *Save* —
  also `Cmd+S` — or until the panel closes; either one saves the note and
  renders it. Leaving a note still untouched goes back as well, so an empty
  day reads empty again.
- **Kept 30 days** — the store holds the last 30 days of notes and drops the
  rest. *Keep* pins a day so it never ages out, and a note written on a day
  the window has already passed is pinned as it is written: it could not be
  held in the window. Pinned days can be reached from the calendar at any
  time.
- **A calendar that says what is there** — the calendar button opens a month
  over the editor: a blue dot for a day with a note, a gold one of the same
  size for a day kept forever, and greyed numbers for days the window has let
  go and for the days still to come. Arrows walk the month, Enter opens a day,
  and picking a day closes the calendar so the note it chose is what you see.
- **Autosaved** — the page saves about half a second after you stop typing,
  and again when the panel loses focus, so closing it mid-sentence keeps the
  sentence.
- **Shortcuts to either view** — `Cmd+Ctrl+Alt+Shift+N` (Caps Lock set up as
  a hyper key, then `N`) brings the panel up on today's note, ready to type
  or paste into, and the same with `T` on the day's list, from anywhere.
- **Persisted** — saved as JSON in `~/Library/Application Support/Todo/`.
- **Light** — the whole frontend is a few kilobytes, with no framework and
  no network calls.

## Commands

```sh
bun install        # dependencies, both packages (mygo-cli, vite, typescript)
bun run dev        # develop with live reload
bun run build      # the .app and a .dmg in build/darwin-arm64/
bun run typecheck  # tsc --noEmit in frontend/
bun run generate   # rewrite frontend/src/mygo.ts from the Go code
go test ./...      # the stores: retention, pinning, the calendar's marks
go vet ./...       # Go vet
```

## Layout

```
cmd/todo/          the app: tray icon, popover flyout, global shortcuts, lifecycle
internal/todos/    the day's list: items, persistence, the midnight reset
internal/notes/    the day's notes: the rolling window, pinning, calendar marks
frontend/          the panel's page, a Vite workspace of the root package
  index.html       the panel's markup: tabs, the list, the editor, the calendar
  src/main.ts      the tasks view: tabs, the list, the day's counters
  src/notes.ts     the notes view: the calendar, autosaving, keeping a day
  src/markdown.ts  the markdown renderer the preview draws with
  src/style.css    the panel's look and the animations
  src/mygo.ts      generated from the Go code — do not edit
resources/icon.png the app icon
mygo.config.ts     name, identifier, and how dev/build run
```

`mygo dev` and `mygo build` run `frontend/`'s scripts through `bun run
--cwd frontend`, compile `./cmd/todo`, and embed `frontend/dist` into the
app.
