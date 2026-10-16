package notes

import (
	"path/filepath"
	"testing"
	"time"
)

// testNotes is a store on a temporary path, without the app around it.
func testNotes(t *testing.T) *Notes {
	t.Helper()
	return &Notes{path: filepath.Join(t.TempDir(), "notes.json"), days: map[string]Note{}}
}

// today names the current local day, in the layout notes are stored in.
func today() string { return time.Now().Format(dayLayout) }

// dayAgo names a local day n days back.
func dayAgo(n int) string {
	return time.Now().AddDate(0, 0, -n).Format(dayLayout)
}

func TestSaveAndGet(t *testing.T) {
	n := testNotes(t)
	today := today()

	saved, err := n.Save(today, "# Today\n\n- wrote the tests")
	if err != nil {
		t.Fatal(err)
	}
	if saved.Text == "" || saved.Day != today || saved.Pinned {
		t.Fatalf("saved %+v", saved)
	}
	got, err := n.Get(today)
	if err != nil {
		t.Fatal(err)
	}
	if got != saved {
		t.Fatalf("got %+v, want %+v", got, saved)
	}
	if info := n.Info(); info.Days != 1 || info.Window != noteWindow {
		t.Fatalf("info %+v", info)
	}
}

func TestSaveWhitespaceRemovesTheDay(t *testing.T) {
	n := testNotes(t)
	today := today()
	if _, err := n.Save(today, "something"); err != nil {
		t.Fatal(err)
	}
	for _, blank := range []string{" ", "   ", "\n", "\n  \n\t\n", " \n "} {
		if _, err := n.Save(today, blank); err != nil {
			t.Fatal(err)
		}
		got, err := n.Get(today)
		if err != nil {
			t.Fatal(err)
		}
		if got.Text != "" {
			t.Fatalf("spaces alone saved as a note: %q", blank)
		}
	}
	if info := n.Info(); info.Days != 0 {
		t.Fatalf("info %+v", info)
	}
	// Words with their spacing still save untouched.
	if _, err := n.Save(today, "  hello  "); err != nil {
		t.Fatal(err)
	}
	if got, _ := n.Get(today); got.Text != "  hello  " {
		t.Fatalf("got %q, want the words with their spacing", got.Text)
	}
}

func TestSaveEmptyRemovesTheDay(t *testing.T) {
	n := testNotes(t)
	today := today()
	if _, err := n.Save(today, "something"); err != nil {
		t.Fatal(err)
	}
	if _, err := n.Save(today, ""); err != nil {
		t.Fatal(err)
	}
	got, err := n.Get(today)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "" {
		t.Fatalf("got %+v, want an empty note", got)
	}
	if info := n.Info(); info.Days != 0 {
		t.Fatalf("info %+v", info)
	}
}

func TestWindowDropsOldNotes(t *testing.T) {
	n := testNotes(t)
	now := time.Now()
	out := now.AddDate(0, 0, -noteWindow).Format(dayLayout)
	edge := now.AddDate(0, 0, -(noteWindow - 1)).Format(dayLayout)
	today := now.Format(dayLayout)
	for _, day := range []string{out, edge, today} {
		n.days[day] = Note{Day: day, Text: "note"}
	}

	if !n.prune(now) {
		t.Fatal("prune should report that a note went")
	}
	if _, ok := n.days[out]; ok {
		t.Fatalf("the note of %s outlived the window", out)
	}
	for _, day := range []string{edge, today} {
		if _, ok := n.days[day]; !ok {
			t.Fatalf("the note of %s was dropped early", day)
		}
	}
	if n.prune(now) {
		t.Fatal("prune should report nothing on a second run")
	}
}

func TestPruneKeepsPinnedNotes(t *testing.T) {
	n := testNotes(t)
	now := time.Now()
	old := now.AddDate(0, 0, -noteWindow*2).Format(dayLayout)
	n.days[old] = Note{Day: old, Text: "note", Pinned: true}
	if n.prune(now) {
		t.Fatal("prune should report nothing")
	}
	if _, ok := n.days[old]; !ok {
		t.Fatal("a pinned note was dropped")
	}
}

func TestPinnedNotesOutliveTheWindow(t *testing.T) {
	n := testNotes(t)
	day := dayAgo(noteWindow * 3)
	if _, err := n.Save(day, "from long ago"); err != nil {
		t.Fatal(err)
	}
	// A note written that far back cannot age out, so it is kept permanently.
	if got, _ := n.Get(day); !got.Pinned {
		t.Fatalf("the note of %s is not pinned: %+v", day, got)
	}
	if _, err := n.Save(day, "edited"); err != nil {
		t.Fatal(err)
	}
	got, err := n.Get(day)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text != "edited" || !got.Pinned {
		t.Fatalf("got %+v", got)
	}
}

func TestPinReleasesAnArchivedNote(t *testing.T) {
	n := testNotes(t)
	day := dayAgo(noteWindow * 3)
	if _, err := n.Save(day, "from long ago"); err != nil {
		t.Fatal(err)
	}
	note, err := n.Pin(day, false)
	if err != nil {
		t.Fatal(err)
	}
	if note.Text != "" {
		t.Fatalf("got %+v, want the day released", note)
	}
	if got, _ := n.Get(day); got.Text != "" {
		t.Fatalf("the note of %s is still stored", day)
	}
	if info := n.Info(); info.Days != 0 || info.Pinned != 0 {
		t.Fatalf("info %+v", info)
	}
}

func TestPinInsideTheWindowKeepsItInTheWindow(t *testing.T) {
	n := testNotes(t)
	today := today()
	if _, err := n.Save(today, "note"); err != nil {
		t.Fatal(err)
	}
	if _, err := n.Pin(today, true); err != nil {
		t.Fatal(err)
	}
	got, err := n.Pin(today, false)
	if err != nil {
		t.Fatal(err)
	}
	if got.Text == "" || got.Pinned {
		t.Fatalf("got %+v, want the note back in the window", got)
	}
}

func TestPinNeedsANote(t *testing.T) {
	n := testNotes(t)
	if _, err := n.Pin(today(), true); err == nil {
		t.Fatal("pinning a day without a note should fail")
	}
}

func TestMonthMarks(t *testing.T) {
	n := testNotes(t)
	today := today()
	kept := dayAgo(noteWindow * 3)
	marked := dayAgo(2)
	for _, day := range []string{today, kept, marked} {
		if _, err := n.Save(day, "note"); err != nil {
			t.Fatal(err)
		}
	}

	// The month the kept note sits in: only that day escapes being archived.
	old := parseInTest(t, kept)
	marks, err := n.Month(old.Year(), int(old.Month()))
	if err != nil {
		t.Fatal(err)
	}
	if len(marks) < 28 || len(marks) > 31 {
		t.Fatalf("got %d marks", len(marks))
	}
	byDay := map[string]DayMark{}
	for _, m := range marks {
		byDay[m.Day] = m
	}
	if m := byDay[kept]; !m.Has || !m.Pinned || m.Archived {
		t.Fatalf("the kept day reads %+v", m)
	}
	for day, m := range byDay {
		if day != kept && !m.Archived {
			t.Fatalf("%s should be archived: %+v", day, m)
		}
	}

	// The current month: today carries a note and is not archived.
	now := time.Now()
	marks, err = n.Month(now.Year(), int(now.Month()))
	if err != nil {
		t.Fatal(err)
	}
	byDay = map[string]DayMark{}
	for _, m := range marks {
		byDay[m.Day] = m
	}
	if m := byDay[today]; !m.Has || m.Pinned || m.Archived {
		t.Fatalf("today reads %+v", m)
	}
	for _, m := range marks {
		if m.Day > today && m.Archived {
			t.Fatalf("%s is in the future: %+v", m.Day, m)
		}
	}
}

func TestMonthRejectsOddInput(t *testing.T) {
	n := testNotes(t)
	if _, err := n.Month(2026, 13); err == nil {
		t.Fatal("month 13 should fail")
	}
	if _, err := n.Month(1969, 1); err == nil {
		t.Fatal("the year before the window should fail")
	}
}

func TestDaysMustBeDays(t *testing.T) {
	n := testNotes(t)
	for _, day := range []string{"", "today", "2026-13-01", "2026-02-30", "14-10-2026"} {
		if _, err := n.Get(day); err == nil {
			t.Fatalf("%q should not be a day", day)
		}
		if _, err := n.Save(day, "note"); err == nil {
			t.Fatalf("%q should not be savable", day)
		}
		if err := n.Delete(day); err == nil {
			t.Fatalf("%q should not be deletable", day)
		}
	}
}

func TestDelete(t *testing.T) {
	n := testNotes(t)
	day := dayAgo(3)
	if _, err := n.Save(day, "note"); err != nil {
		t.Fatal(err)
	}
	if err := n.Delete(day); err != nil {
		t.Fatal(err)
	}
	if got, _ := n.Get(day); got.Text != "" {
		t.Fatalf("got %+v, want the note gone", got)
	}
}

func parseInTest(t *testing.T, day string) time.Time {
	t.Helper()
	at, err := time.ParseInLocation(dayLayout, day, time.Local)
	if err != nil {
		t.Fatal(err)
	}
	return at
}
