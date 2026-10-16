// Package todos is the day's list: its items, persistence and reset.
package todos

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
)

// Todo is one item of the day's list.
type Todo struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	Done      bool      `json:"done"`
	CreatedAt time.Time `json:"createdAt"`
}

// Stats summarizes the day and drives the UI footer, the progress ring and
// the tray title. ResetsAt is the next local midnight as Unix milliseconds,
// so the countdown in the page stays correct even while it is hidden.
type Stats struct {
	Day      string `json:"day"`
	Total    int    `json:"total"`
	Done     int    `json:"done"`
	Active   int    `json:"active"`
	ResetsAt int64  `json:"resetsAt"`
}

// Changed is emitted to every page whenever the list changes, including the
// automatic reset at midnight.
var Changed = mygo.NewEvent[Stats]("todos:changed")

// Todos is the list for the current local day. It is stored as JSON in the
// app's user data directory and starts empty again after midnight.
type Todos struct {
	mu    sync.Mutex
	path  string
	day   string
	items []Todo
	next  int64
}

// saved is the on-disk shape.
type saved struct {
	Day   string `json:"day"`
	Items []Todo `json:"items"`
}

// OpenStore loads the saved list. A list written on an earlier day is
// yesterday's and is discarded, so the app always opens on a fresh day.
func OpenStore() (*Todos, error) {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return nil, err
	}
	t := &Todos{path: filepath.Join(dir, "todos.json")}
	data, err := os.ReadFile(t.path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if len(data) > 0 {
		var s saved
		if err := json.Unmarshal(data, &s); err != nil {
			// An older file is a bare array of todos: adopt it as today's.
			var items []Todo
			if err := json.Unmarshal(data, &items); err != nil {
				return nil, err
			}
			t.items = items
			t.day = today()
		} else {
			t.day = s.Day
			t.items = s.Items
		}
	}
	for _, it := range t.items {
		t.next = max(t.next, it.ID)
	}
	if t.day != today() {
		t.day = today()
		t.items = nil
		t.next = 0
		if err := t.save(); err != nil {
			return nil, err
		}
	}
	return t, nil
}

// WatchMidnight resets the list as each local midnight passes. It runs in the
// background, waking only once per day, and stops with the process. It is not
// a method so it stays out of the frontend bindings.
func WatchMidnight(t *Todos) {
	go func() {
		for {
			next := nextMidnight(time.Now())
			time.Sleep(time.Until(next))
			t.resetIfNewDay(time.Now())
		}
	}()
}

// List returns the day's todos in the order they were added.
func (t *Todos) List() []Todo {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]Todo, len(t.items))
	copy(out, t.items)
	return out
}

// Add appends a todo and returns it.
func (t *Todos) Add(title string) (Todo, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Todo{}, errors.New("a todo needs a title")
	}
	t.mu.Lock()
	t.next++
	todo := Todo{ID: t.next, Title: title, CreatedAt: time.Now()}
	t.items = append(t.items, todo)
	t.mu.Unlock()
	return todo, t.save()
}

// Toggle flips a todo between done and not done.
func (t *Todos) Toggle(id int64) error {
	return t.update(func() error {
		i := t.index(id)
		if i < 0 {
			return errors.New("todo not found")
		}
		t.items[i].Done = !t.items[i].Done
		return nil
	})
}

// Remove deletes a todo.
func (t *Todos) Remove(id int64) error {
	return t.update(func() error {
		i := t.index(id)
		if i < 0 {
			return errors.New("todo not found")
		}
		t.items = slices.Delete(t.items, i, i+1)
		return nil
	})
}

// ClearDone removes completed todos and returns how many were removed.
func (t *Todos) ClearDone() (int, error) {
	n := 0
	err := t.update(func() error {
		before := len(t.items)
		t.items = slices.DeleteFunc(t.items, func(it Todo) bool { return it.Done })
		n = before - len(t.items)
		return nil
	})
	return n, err
}

// Clear empties the list, starting the day over.
func (t *Todos) Clear() error {
	return t.update(func() error {
		t.items = nil
		return nil
	})
}

// Stats returns the counters for the footer and the progress ring.
func (t *Todos) Stats() Stats {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.stats()
}

func (t *Todos) index(id int64) int {
	return slices.IndexFunc(t.items, func(it Todo) bool { return it.ID == id })
}

func (t *Todos) stats() Stats {
	s := Stats{Day: t.day, Total: len(t.items), ResetsAt: nextMidnight(time.Now()).UnixMilli()}
	for _, it := range t.items {
		if it.Done {
			s.Done++
		} else {
			s.Active++
		}
	}
	return s
}

func (t *Todos) update(fn func() error) error {
	t.mu.Lock()
	err := fn()
	t.mu.Unlock()
	if err != nil {
		return err
	}
	return t.save()
}

// resetIfNewDay clears the list when the local date has moved on, which is
// what "resets daily at midnight" means for the list.
func (t *Todos) resetIfNewDay(now time.Time) {
	t.mu.Lock()
	if t.day == todayIn(now) {
		t.mu.Unlock()
		return
	}
	t.day = todayIn(now)
	t.items = nil
	t.next = 0
	t.mu.Unlock()
	_ = t.save()
}

// save writes the list and tells every page about the change.
func (t *Todos) save() error {
	t.mu.Lock()
	data, err := json.MarshalIndent(saved{Day: t.day, Items: t.items}, "", "  ")
	stats := t.stats()
	t.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.WriteFile(t.path, data, 0o644); err != nil {
		return err
	}
	return Changed.Broadcast(stats)
}

func today() string { return todayIn(time.Now()) }

func todayIn(now time.Time) string { return now.Format("2006-01-02") }

// nextMidnight is the next local midnight strictly after now.
func nextMidnight(now time.Time) time.Time {
	return time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location())
}
