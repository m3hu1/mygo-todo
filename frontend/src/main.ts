// Calls and payloads come from the Go side via `mygo generate` (src/mygo.ts).
import { Todos, events, type Stats, type Todo } from "./mygo";
import { initNotes, focusNote, notesToday, showNote } from "./notes";

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const RING = 97.4; // 2πr for the progress ring's r = 15.5
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let list: Todo[] = [];
let resetsAt = 0;

// ---- Rendering ----

function applyStats(stats: Stats) {
  const pct = stats.total === 0 ? 0 : stats.done / stats.total;
  $<SVGCircleElement>("#ringFill").style.strokeDashoffset = String(RING * (1 - pct));
  $("#ringLabel").textContent = String(stats.total === 0 ? 0 : stats.done);
  $("#date").textContent = formatDay(stats.day);
  $("#left").textContent =
    stats.total === 0
      ? "No tasks"
      : stats.active === 0
        ? "All done"
        : stats.active === 1
          ? "1 left"
          : `${stats.active} left`;
  $<HTMLButtonElement>("#clearDone").hidden = stats.done === 0;
  resetsAt = stats.resetsAt;
  paintCountdown();
}

function render() {
  $("#list").replaceChildren(...list.map(renderRow));
  $<HTMLElement>("#empty").hidden = list.length > 0;
}

function renderRow(todo: Todo): HTMLLIElement {
  const li = $<HTMLTemplateElement>("#item").content.firstElementChild!.cloneNode(
    true,
  ) as HTMLLIElement;
  li.dataset.id = String(todo.id);
  li.classList.toggle("done", todo.done);

  const check = li.querySelector<HTMLButtonElement>(".check")!;
  check.setAttribute("aria-checked", String(todo.done));
  check.addEventListener("click", () => toggle(todo));

  li.querySelector(".label")!.textContent = todo.title;
  li.querySelector(".remove")!.addEventListener("click", () => remove(todo));
  return li;
}

function rowEl(id: number): HTMLLIElement | null {
  return document.querySelector(`.row[data-id="${id}"]`);
}

// ---- Actions ----

// toggle flips the row in place first so the animation runs right away, then
// tells Go; the change event only refreshes the counters, not the row.
async function toggle(todo: Todo) {
  const next = !todo.done;
  todo.done = next;
  const li = rowEl(todo.id);
  if (li) {
    li.classList.toggle("done", next);
    li.querySelector(".check")!.setAttribute("aria-checked", String(next));
  }
  try {
    await Todos.toggle(todo.id);
  } catch (err) {
    todo.done = !next;
    await refresh();
    showError(err);
  }
}

async function remove(todo: Todo) {
  list = list.filter((t) => t.id !== todo.id);
  const li = rowEl(todo.id);
  if (li) li.classList.add("out");
  await sleep(160);
  render();
  try {
    await Todos.remove(todo.id);
  } catch (err) {
    showError(err);
    await refresh();
  }
}

async function clearDone() {
  document.querySelectorAll(".row.done").forEach((li) => li.classList.add("out"));
  await sleep(160);
  try {
    await Todos.clearDone();
  } catch (err) {
    showError(err);
  }
  await refresh();
}

// ---- State sync ----

function sameList(a: Todo[], b: Todo[]) {
  return (
    a.length === b.length &&
    a.every((t, i) => {
      const u = b[i]!;
      return t.id === u.id && t.title === u.title && t.done === u.done;
    })
  );
}

// refresh pulls the day's list and counters. It only rebuilds the rows when
// their contents actually changed, so in-place animations are never replayed.
async function refresh() {
  const [items, stats] = await Promise.all([Todos.list(), Todos.stats()]);
  applyStats(stats);
  if (!sameList(list, items)) {
    list = items;
    render();
  }
}

function showError(err: unknown) {
  $("#error").textContent = err instanceof Error ? err.message : String(err);
  window.setTimeout(() => ($("#error").textContent = ""), 4000);
}

// ---- Countdown to the midnight reset ----

function paintCountdown() {
  const ms = resetsAt - Date.now();
  if (ms <= 0) {
    $("#reset").textContent = "";
    return;
  }
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  $("#reset").textContent = h > 0 ? `Resets in ${h}h ${m}m` : `Resets in ${m}m`;
}

function formatDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// ---- Views ----

// The panel is one window with two views: the day's list and the day's note.
// Only one is shown, and the tab that is on keeps its state.

function showView(view: string) {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    const on = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(on));
    tab.classList.toggle("on", on);
    $(`#view-${tab.dataset.view}`).hidden = !on;
  });
  if (view === "tasks") $<HTMLInputElement>("#title").focus();
  else focusNote();
}

// ---- Wiring ----

void (async () => {
  document.querySelectorAll<HTMLElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view!));
  });

  $("#add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("#title");
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    try {
      await Todos.add(title);
    } catch (err) {
      showError(err);
    }
    await refresh();
    input.focus();
  });

  $("#clearDone").addEventListener("click", () => void clearDone());

  // The global shortcuts bring the panel up on a view: the list, or a day's
  // note. This also runs when the panel was just built by one, before the
  // page has finished starting up, so it must not be undone by start-up.
  events.panelShow.on(({ view, day }) => {
    showView(view === "notes" ? "notes" : "tasks");
    if (view === "notes") showNote(day ?? "");
  });

  // The midnight reset arrives as a normal change event, and takes the notes
  // view with it when its day turns over.
  events.todosChanged.on(() => {
    void refresh();
    notesToday();
  });

  // The panel keeps its page between openings; focus the field of the view
  // that is on each time.
  window.addEventListener("focus", () => {
    if (document.querySelector<HTMLElement>(".tab.on")?.dataset.view === "notes") focusNote();
    else $<HTMLInputElement>("#title").focus();
  });

  window.setInterval(paintCountdown, 30_000);

  // The view on screen is the one the markup starts in; a shortcut that gets
  // here first has already chosen its own.
  initNotes();
  await refresh();
  $<HTMLInputElement>("#title").focus();
})();
