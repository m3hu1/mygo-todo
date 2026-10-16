// The notes view: one markdown note per local day, autosaved as the user
// types, with a calendar that colours the days that hold a note.
import { Notes, events, type DayMark, type Note, type NotesInfo } from "./mygo";
import { renderMarkdown } from "./markdown";

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const SAVE_DELAY = 600; // quiet time before a keystroke reaches Go
const INDENT = "  ";
const OLDEST_YEAR = 1970; // as far back as the store can name a day

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => dayKey(new Date());

// The panel holds one day at a time: the day being edited, its note, and the
// month the calendar shows. Everything else is read back from Go.
let selected = todayKey();
let note: Note = { day: selected, text: "", pinned: false, updatedAt: "" };
let cursor = new Date();
let marks: DayMark[] = [];
let timer = 0; // the pending autosave
let dirty = false; // the editor holds text Go has not taken yet
let reading = false; // the note is rendered rather than typed in
let caret = 0; // where in the note the writing was left

// hasText tells an empty note from one holding words: spaces and newlines
// alone are no note, so they never enable Save, Keep, Delete, or a calendar
// dot.
const hasText = (s: string) => s.trim() !== "";

const body = $<HTMLTextAreaElement>("#noteBody");
const preview = $<HTMLElement>("#notePreview");
const grid = $<HTMLElement>("#calGrid");
const editor = $<HTMLElement>(".editor");

// ---- Days ----

function parse(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

// ---- Rendering ----

function renderDay() {
  const d = parse(selected);
  $("#noteDay").textContent =
    selected === todayKey()
      ? "Today"
      : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  // Keep is always on the right; it only goes quiet when the day has nothing
  // to keep yet.
  const pin = $<HTMLButtonElement>("#pinNote");
  pin.classList.toggle("on", note.pinned);
  pin.setAttribute("aria-pressed", String(note.pinned));
  pin.disabled = !hasText(note.text);
  $("#pinLabel").textContent = note.pinned ? "Kept" : "Keep";

  // Delete stays on the right, like Keep: it only goes quiet when the day
  // has nothing to delete yet, instead of snapping in and out of view.
  $<HTMLButtonElement>("#deleteNote").disabled = !hasText(note.text);
  renderEmpty();
}

/** renderEmpty shows the hint only while the note is empty and it is being
    read: a note being written belongs to its caret, so the hint gets out of
    the way until Save — or leaving it — reads it back. */
function renderEmpty() {
  $("#editorEmpty").hidden = !reading || hasText(body.value);
}

function renderPreview() {
  preview.innerHTML = renderMarkdown(body.value);
}

function renderInfo(info: NotesInfo) {
  const notes =
    info.days === 0 ? "No notes yet" : `${info.days} ${info.days === 1 ? "note" : "notes"}`;
  const kept =
    info.pinned > 0 ? `${info.pinned} kept forever` : `the last ${info.window} days`;
  $("#noteInfo").textContent = `${notes} · ${kept}`;
}

/** renderCalendar paints the month: a dot for a day with a note, a filled one
    for a note kept forever, greyed numbers for archived and future days. */
function renderCalendar() {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  $("#calLabel").textContent = `${MONTHS[month]} ${year}`;

  const head = document.createDocumentFragment();
  for (const w of WEEKDAYS) {
    const el = document.createElement("span");
    el.className = "cal-wd";
    el.textContent = w;
    head.append(el);
  }

  const today = todayKey();
  const cells = document.createDocumentFragment();
  for (let i = 0; i < new Date(year, month, 1).getDay(); i++) {
    const blank = document.createElement("span");
    blank.className = "cal-cell gap";
    cells.append(blank);
  }
  let stopCell: HTMLButtonElement | null = null; // the last day that can be opened
  for (const mark of marks) {
    const d = parse(mark.day);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cal-cell";
    cell.dataset.day = mark.day;
    cell.textContent = String(d.getDate());
    const what = mark.pinned
      ? ", kept forever"
      : mark.has
        ? ", has a note"
        : mark.archived
          ? ", archived"
          : "";
    cell.setAttribute(
      "aria-label",
      d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) + what,
    );
    if (mark.has) cell.classList.add(mark.pinned ? "kept" : "has");
    if (mark.archived && !mark.has) cell.classList.add("archived");
    if (mark.day === selected) cell.classList.add("sel");
    if (mark.day > today) {
      cell.classList.add("future");
    } else {
      stopCell = cell;
    }
    if (mark.day === today) cell.classList.add("today");
    cells.append(cell);
  }
  grid.replaceChildren(head, cells);

  // One cell in the month takes the keyboard: the day on screen when it is
  // there, otherwise the last day that can still be opened.
  const focusable = grid.querySelector<HTMLButtonElement>(".cal-cell.sel[data-day]") ?? stopCell;
  for (const cell of grid.querySelectorAll<HTMLButtonElement>(".cal-cell[data-day]")) {
    cell.tabIndex = cell === focusable ? 0 : -1;
  }

  // Months go back as far as the store can hold one, never further.
  $<HTMLButtonElement>("#calPrev").disabled = year <= OLDEST_YEAR && month === 0;
}

async function loadMarks() {
  marks = await Notes.month(cursor.getFullYear(), cursor.getMonth() + 1);
  renderCalendar();
}

async function refreshInfo() {
  renderInfo(await Notes.info());
}

function showError(err: unknown) {
  $("#noteError").textContent = err instanceof Error ? err.message : String(err);
  window.setTimeout(() => ($("#noteError").textContent = ""), 4000);
}

// ---- Reading and writing ----

/**
 * A note has two states. It is read as rendered markdown, and it is written as
 * markdown in a textarea. Nothing but a click in the note goes from reading to
 * writing, and nothing but Save — or leaving an untouched note, or the panel
 * closing — goes back. The caret is put back where the writing left it,
 * rather than where the click landed: the rendered note has no source
 * positions to click into.
 */

function scrolled(el: HTMLElement): number {
  const room = el.scrollHeight - el.clientHeight;
  return room > 0 ? el.scrollTop / room : 0;
}

function renderSaveButton() {
  // Save belongs to writing, and only when there is something to save:
  // whitespace alone is no note.
  $<HTMLButtonElement>("#saveNote").hidden = reading || !hasText(body.value);
}

/** read renders the note and leaves writing until it is asked for again. */
function read(): void {
  if (reading) return;
  caret = body.selectionStart;
  const at = scrolled(body);
  reading = true;
  renderPreview();
  body.hidden = true;
  preview.hidden = false;
  preview.scrollTop = at * (preview.scrollHeight - preview.clientHeight);
  renderSaveButton();
  renderEmpty();
}

/** write puts the source back, with the caret where it was left. */
function write(): void {
  if (!reading) return;
  const from = scrolled(preview);
  reading = false;
  preview.hidden = true;
  preview.innerHTML = ""; // it is drawn again whenever the note is read
  body.hidden = false;
  body.scrollTop = from * (body.scrollHeight - body.clientHeight);
  renderSaveButton();
  renderEmpty();
}

/** blank empties the note while a day is on its way, without saying the day is
    empty: it is on its way. */
function blank(): void {
  reading = false;
  preview.hidden = true;
  preview.innerHTML = "";
  body.hidden = false;
  body.value = "";
  // The day is on its way: the hint waits for it rather than saying it is
  // empty before it has arrived.
  $("#editorEmpty").hidden = true;
  renderSaveButton();
}

/** showText puts a day's text in the state the note opens in: rendered when
    it holds something, and rendered and empty when it does not, so the note
    is only ever written by asking for it. */
function showText(text: string): void {
  body.value = text;
  caret = text.length;
  reading = false;
  body.hidden = false;
  preview.hidden = true;
  read();
}

/** edit goes from reading to writing and puts the caret back. */
function edit(): void {
  write();
  body.focus();
  const at = Math.max(0, Math.min(caret, body.value.length));
  body.selectionStart = body.selectionEnd = at;
}

/** insert writes text into the source where the caret is, as a keystroke
    would. */
function insert(text: string): void {
  const from = body.selectionStart;
  const to = body.selectionEnd;
  body.value = body.value.slice(0, from) + text + body.value.slice(to);
  caret = from + text.length;
  body.selectionStart = body.selectionEnd = caret;
  body.dispatchEvent(new Event("input", { bubbles: true }));
}

/** type writes a keystroke that arrived while the note was being read. */
function type(key: string): void {
  edit();
  if (key === "Backspace" || key === "Delete") {
    const at = body.selectionStart;
    const from = key === "Backspace" ? Math.max(0, at - 1) : at;
    if (from === at) return;
    body.value = body.value.slice(0, from) + body.value.slice(at);
    caret = from;
    body.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    insert(key);
  }
}

// ---- Saving ----

// flush hands the editor's text to Go, unless it already has.
async function flush(): Promise<void> {
  window.clearTimeout(timer);
  timer = 0;
  if (!dirty) return;
  dirty = false;
  try {
    note = await Notes.save(selected, body.value);
  } catch (err) {
    dirty = true; // hold on to it for the next attempt
    throw err;
  }
  renderDay();
  await Promise.all([loadMarks(), refreshInfo()]);
}

function scheduleSave() {
  dirty = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void flush().catch(showError), SAVE_DELAY);
}

// ---- Opening a day ----

// opening counts the days asked for: the last one asked for is the one that
// lands, so a day still on its way is never written over by one that was
// asked for before it.
let opening = 0;

async function openDay(day: string, keepCalendar = false): Promise<boolean> {
  if (day > todayKey()) return false; // there is no today to write about
  const mine = ++opening;
  // Save what the day on screen holds before touching it.
  await flush().catch(showError);
  if (mine !== opening) return false; // a newer day took over while it saved
  // Then empty the note at once: the calendar closing over it would otherwise
  // uncover the last day's note for as long as this one takes to arrive.
  blank();
  selected = day;
  note = await Notes.get(day);
  if (mine !== opening) return false; // a newer day took over while it loaded
  showText(note.text);
  renderDay();

  const d = parse(day);
  const moved = d.getMonth() !== cursor.getMonth() || d.getFullYear() !== cursor.getFullYear();
  if (moved) {
    cursor = d;
    await loadMarks();
  } else if (keepCalendar) {
    renderCalendar();
  }
  return true;
}

function focusDay(day: string): void {
  grid.querySelector<HTMLButtonElement>(`.cal-cell[data-day="${day}"]`)?.focus();
}

function goMonth(delta: number): void {
  cursor = new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1);
  void loadMarks().catch(showError);
}

// ---- Editor keys ----

/** indent adds a level to every line the selection touches, which is what
    Tab does in a markdown editor. */
function indent(e: KeyboardEvent): void {
  const { selectionStart: from, selectionEnd: to } = body;
  const start = body.value.lastIndexOf("\n", from - 1) + 1;
  const end = body.value.indexOf("\n", to);
  const block = body.value
    .slice(start, end === -1 ? body.value.length : end)
    .split("\n")
    .map((line) => INDENT + line)
    .join("\n");
  body.value = body.value.slice(0, start) + block + body.value.slice(end === -1 ? body.value.length : end);
  body.selectionStart = start;
  body.selectionEnd = start + block.length;
  scheduleSave();
  e.preventDefault();
}

/** unindent removes one level from the first line, for Backspace at its start. */
function unindent(e: KeyboardEvent): void {
  e.preventDefault();
  body.value = body.value.replace(new RegExp(`^ {1,${INDENT.length}}`), "");
  scheduleSave();
}

// ---- Wiring ----

/** setCalendar opens or closes the picker over the editor. */
function setCalendar(open: boolean) {
  $<HTMLButtonElement>("#calToggle").setAttribute("aria-expanded", String(open));
  $("#calToggle").classList.toggle("on", open);
  $("#calendar").hidden = !open;
  if (open) void loadMarks().catch(showError);
}

/** pickDay opens a day and closes the picker, so the note it chose is what
    the user sees next. The focus goes with it: a day cell left holding it,
    hidden with the picker, would swallow the next Enter or Space. */
function pickDay(day: string): void {
  setCalendar(false);
  void openDay(day, true)
    .then(focusNote)
    .catch(showError);
}

export function initNotes() {
  grid.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".cal-cell[data-day]");
    if (cell) pickDay(cell.dataset.day!);
  });

  // Arrows walk the month, Enter opens the day under the cursor.
  grid.addEventListener("keydown", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>(".cal-cell[data-day]");
    if (!cell) return;
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickDay(cell.dataset.day!);
      return;
    }
    const delta = step[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = parse(cell.dataset.day!);
    next.setDate(next.getDate() + delta);
    const day = dayKey(next);
    if (day > todayKey()) return;
    if (next.getMonth() !== cursor.getMonth() || next.getFullYear() !== cursor.getFullYear()) {
      cursor = next;
      void loadMarks()
        .then(() => focusDay(day))
        .catch(showError);
    } else {
      focusDay(day);
    }
  });

  $("#calPrev").addEventListener("click", () => goMonth(-1));
  $("#calNext").addEventListener("click", () => goMonth(1));

  $("#calToggle").addEventListener("click", () =>
    setCalendar($("#calToggle").getAttribute("aria-expanded") !== "true"),
  );

  $("#pinNote").addEventListener("click", () => {
    void (async () => {
      try {
        note = await Notes.pin(selected, !note.pinned);
        renderDay();
        await Promise.all([loadMarks(), refreshInfo()]);
      } catch (err) {
        showError(err);
      }
    })();
  });

  // Save writes the note and reads it back as markdown. So does closing the
  // panel, which is the other thing that ends writing.
  const save = () => {
    void (async () => {
      await flush().catch(showError);
      // A save that went through is the note; one that failed keeps the
      // typing, so nothing written is lost. Whitespace alone saves as no
      // note, so it reads back empty rather than as blank lines.
      showText(dirty ? body.value : note.text);
    })();
  };
  $("#saveNote").addEventListener("click", save);

  // Deleting a note empties it in place: the rendered note has to go too, or
  // the note reads as still there until the next click.
  $("#deleteNote").addEventListener("click", () => {
    body.value = "";
    dirty = true;
    void (async () => {
      await flush().catch(showError);
      showText("");
      renderDay();
    })().catch(showError);
  });

  // Anywhere in the note goes back to writing it, except a link, which opens:
  // MyGo sends target="_blank" and window.open() to the default browser.
  editor.addEventListener("mouseup", (e) => {
    if (!reading) return;
    if ((e.target as HTMLElement).closest("a[href]")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    edit();
  });

  preview.addEventListener("click", (e) => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!link) return;
    // The panel is never left for a website: a link goes to the browser, and
    // one that only means something inside a page is left alone.
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^(https?:\/\/|mailto:)/i.test(href)) window.open(link.href, "_blank", "noopener");
  });

  // Typing in the rendered note writes it too, for the keyboard's sake.
  preview.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (key.length !== 1 && !["Enter", "Backspace", "Delete"].includes(key)) return;
    e.preventDefault();
    type(key === "Enter" ? "\n" : key);
  });

  body.addEventListener("input", () => {
    caret = body.selectionStart;
    scheduleSave();
    renderSaveButton();
    renderEmpty();
  });

  body.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      indent(e);
    } else if (
      e.key === "Backspace" &&
      body.selectionStart === 0 &&
      body.selectionEnd === 0 &&
      body.value.startsWith(" ")
    ) {
      unindent(e);
    }
  });

  // Cmd+S saves, as it does everywhere else.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });

  // Losing focus ends writing a note that was never written in: the day goes
  // back to being read as the empty note it is, so the hint returns. A note
  // with words stays in the editor — the caret keeps it — until Save or the
  // panel closing reads it back.
  body.addEventListener("blur", () => {
    if (!hasText(body.value)) read();
    void flush().catch(showError);
  });

  // The panel closing ends writing: the note is saved and read as markdown,
  // so it comes back rendered. The state belongs to the note, not to the
  // view, so this does not care which tab is on.
  const settle = () => {
    void (async () => {
      await flush().catch(showError);
      // As with Save: the note when it saved, the typing when it did not.
      showText(dirty ? body.value : note.text);
    })();
  };
  window.addEventListener("blur", settle);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) settle();
  });

  // A note changed elsewhere — another window, the midnight reset — refreshes
  // the calendar, never the editor being typed in.
  events.notesChanged.on(() => {
    void Promise.all([loadMarks(), refreshInfo()]).catch(showError);
  });

  // The panel keeps its page between openings, so a note may be stale when it
  // comes back: the counts follow, and an empty day follows the date.
  window.addEventListener("focus", () => {
    if (selected !== todayKey() && !hasText(note.text)) {
      void openDay(todayKey()).catch(showError);
      return;
    }
    void Promise.all([loadMarks(), refreshInfo()]).catch(showError);
  });

  void (async () => {
    // The panel opens on today: show whatever it already holds, rendered.
    note = await Notes.get(selected);
    showText(note.text);
    renderDay();
    await Promise.all([loadMarks(), refreshInfo()]);
  })().catch(showError);
}

/** notesToday follows the date: after midnight an untouched day becomes
    today's, while a note the user opened stays where it is. */
export function notesToday(): void {
  const today = todayKey();
  if (selected === today || hasText(note.text)) return;
  void openDay(today).catch(showError);
}

/** showNote opens a day, which is where the global shortcut lands. The note
    opens in writing — the shortcut asks for the note, not to read it — so
    the day can be typed or pasted into without a click first. */
export function showNote(day: string): void {
  const today = todayKey();
  void openDay(day && day <= today ? day : today)
    .then((opened) => {
      if (opened) edit();
    })
    .catch(showError);
}

/** focusNote focuses whatever the note currently is: its source while it is
    being written, the rendered note while it is being read. */
export function focusNote(): void {
  if (reading) preview.focus({ preventScroll: true });
  else body.focus({ preventScroll: true });
}
