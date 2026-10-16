// Package notes is the day's notes: the rolling window, pinning and the
// calendar's marks.
package notes

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// noteWindow is how many days of notes are kept, today included. Notes older
// than that are dropped on launch and after every save, unless they were kept
// permanently.
const noteWindow = 30

// dayLayout is the format days are named in, everywhere on both sides.
const dayLayout = "2006-01-02"

// Note is the note of one local day. Days without a note are not stored at
// all, so the file only ever holds what someone actually wrote.
type Note struct {
	Day       string    `json:"day"`
	Text      string    `json:"text"`
	Pinned    bool      `json:"pinned"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// DayMark is everything the calendar draws for one day, so it can colour a
// month without fetching every note it holds.
type DayMark struct {
	Day string `json:"day"`
	// Has is true when the day has note text.
	Has bool `json:"has"`
	// Pinned is true when the note is kept permanently.
	Pinned bool `json:"pinned"`
	// Archived is true for a past day the window no longer holds and that
	// was never kept permanently.
	Archived bool `json:"archived"`
}

// NotesInfo is what the notes footer reports.
type NotesInfo struct {
	Days   int `json:"days"`
	Pinned int `json:"pinned"`
	Window int `json:"window"`
}

// NoteChanged is emitted to every page with the day that changed, so a
// calendar can stay in step with an editor.
var NoteChanged = mygo.NewEvent[string]("notes:changed")

// Notes stores one note per local day, in the app's user data directory. It
// keeps the last noteWindow days and drops the rest; a pinned note is kept
// until it is released.
type Notes struct {
	mu   sync.Mutex
	path string
	days map[string]Note
}

// savedNotes is the on-disk shape.
type savedNotes struct {
	Days map[string]Note `json:"days"`
}

// OpenNotes loads the saved notes and drops everything the rolling window no
// longer holds.
func OpenNotes() (*Notes, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return nil, err
	}
	n := &Notes{path: filepath.Join(dir, "notes.json"), days: map[string]Note{}}
	data, err := os.ReadFile(n.path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(data) > 0 {
		var s savedNotes
		if err := json.Unmarshal(data, &s); err != nil {
			return nil, err
		}
		for day, note := range s.Days {
			// An empty note is no note: drop it rather than keeping it
			// around as an empty day the calendar would mark. Whitespace
			// alone is empty too, so space or newline spam never becomes a
			// note.
			if _, err := time.ParseInLocation(dayLayout, day, time.Local); err == nil && strings.TrimSpace(note.Text) != "" {
				n.days[day] = note
			}
		}
	}
	if n.prune(time.Now()) {
		if err := n.saveFile(); err != nil {
			return nil, err
		}
	}
	return n, nil
}

// Get returns the note of a day. A day without one comes back empty.
func (n *Notes) Get(day string) (Note, error) {
	if err := validDay(day); err != nil {
		return Note{}, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.days[day], nil
}

// Save writes a day's note, which the page does as the user types. Empty text
// removes the day, kept permanently or not, and comes back as an empty note.
// Text without a word in it — only spaces or newlines — counts as empty, so
// it removes the day rather than saving a blank note. A note on a day the
// window has already moved past is kept permanently: it cannot be held in
// the rolling window, and writing it is the point.
func (n *Notes) Save(day, text string) (Note, error) {
	if err := validDay(day); err != nil {
		return Note{}, err
	}
	now := time.Now()
	n.mu.Lock()
	note := n.days[day]
	if strings.TrimSpace(text) == "" {
		delete(n.days, day)
		note = Note{}
	} else {
		note.Day, note.Text, note.UpdatedAt = day, text, now
		note.Pinned = note.Pinned || day < windowStart(now).Format(dayLayout)
		n.days[day] = note
	}
	n.pruneLocked(now)
	n.mu.Unlock()
	if err := n.write(day); err != nil {
		return Note{}, err
	}
	return note, nil
}

// Pin keeps a day's note forever. Releasing it hands the note back to the
// rolling window, which removes it at once when it already sits outside it.
func (n *Notes) Pin(day string, pinned bool) (Note, error) {
	if err := validDay(day); err != nil {
		return Note{}, err
	}
	now := time.Now()
	n.mu.Lock()
	note, ok := n.days[day]
	if !ok {
		n.mu.Unlock()
		return Note{}, errors.New("there is no note on that day")
	}
	if !pinned && day < windowStart(now).Format(dayLayout) {
		delete(n.days, day)
		note = Note{}
	} else {
		note.Pinned = pinned
		n.days[day] = note
	}
	n.pruneLocked(now)
	n.mu.Unlock()
	if err := n.write(day); err != nil {
		return Note{}, err
	}
	return note, nil
}

// Delete removes a day's note.
func (n *Notes) Delete(day string) error {
	if err := validDay(day); err != nil {
		return err
	}
	n.mu.Lock()
	delete(n.days, day)
	n.mu.Unlock()
	return n.write(day)
}

// Month returns a mark for every day of a month, which is all the calendar
// needs to colour them.
func (n *Notes) Month(year, month int) ([]DayMark, error) {
	if year < 1970 || year > 9999 || month < 1 || month > 12 {
		return nil, fmt.Errorf("%04d-%02d is not a month", year, month)
	}
	first := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.Local)
	now := time.Now()
	start := windowStart(now).Format(dayLayout)
	n.mu.Lock()
	defer n.mu.Unlock()
	marks := make([]DayMark, first.AddDate(0, 1, -1).Day())
	for i := range marks {
		day := first.AddDate(0, 0, i).Format(dayLayout)
		note, ok := n.days[day]
		marks[i] = DayMark{
			Day:      day,
			Has:      ok,
			Pinned:   ok && note.Pinned,
			Archived: day < start && !(ok && note.Pinned),
		}
	}
	return marks, nil
}

// Info reports how many days are stored, how many of those are kept
// permanently, and how long the rolling window is.
func (n *Notes) Info() NotesInfo {
	n.mu.Lock()
	defer n.mu.Unlock()
	info := NotesInfo{Window: noteWindow}
	for _, note := range n.days {
		info.Days++
		if note.Pinned {
			info.Pinned++
		}
	}
	return info
}

// prune drops the notes the window no longer holds, pinned ones except, and
// reports whether anything went.
func (n *Notes) prune(now time.Time) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.pruneLocked(now)
}

func (n *Notes) pruneLocked(now time.Time) bool {
	start := windowStart(now).Format(dayLayout)
	removed := false
	for day, note := range n.days {
		if note.Pinned || day >= start {
			continue
		}
		delete(n.days, day)
		removed = true
	}
	return removed
}

// write saves the notes and tells every page which day changed.
func (n *Notes) write(day string) error {
	if err := n.saveFile(); err != nil {
		return err
	}
	return NoteChanged.Broadcast(day)
}

// saveFile writes the notes as JSON, holding the lock only while reading them.
func (n *Notes) saveFile() error {
	n.mu.Lock()
	data, err := json.MarshalIndent(savedNotes{Days: n.days}, "", "  ")
	n.mu.Unlock()
	if err != nil {
		return err
	}
	return os.WriteFile(n.path, data, 0o644)
}

// windowStart is the oldest day the rolling window still keeps, today
// included.
func windowStart(now time.Time) time.Time {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	return day.AddDate(0, 0, -(noteWindow - 1))
}

// validDay rejects anything that is not a local calendar day, so the map keys
// stay comparable as plain strings.
func validDay(day string) error {
	if _, err := time.ParseInLocation(dayLayout, day, time.Local); err != nil {
		return fmt.Errorf("%q is not a day, want YYYY-MM-DD", day)
	}
	return nil
}
