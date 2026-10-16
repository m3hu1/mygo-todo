// Todo is a menu bar app: the icon in the menu bar opens a popover holding
// today's list. Tasks reset at local midnight, and the list lives in the
// app's user data directory.
//
//	bun run dev    # live reload
//	bun run build  # the .app and a disk image
package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"runtime"
	"time"

	"github.com/egoist/mygo"
	"github.com/mehul/todo-menubar/internal/notes"
	"github.com/mehul/todo-menubar/internal/todos"
)

// Show asks the panel to open on a view, which is how the global shortcuts
// reach it from anywhere: "tasks", or "notes" with the day they want.
type Show struct {
	View string `json:"view"`
	Day  string `json:"day,omitempty"`
}

// ShowPanel is emitted to the panel when a shortcut opens it.
var ShowPanel = mygo.NewEvent[Show]("panel:show")

// app holds the menu bar state. Everything here is touched on the main
// thread only, by tray callbacks.
type app struct {
	tray   *mygo.Tray
	panel  *mygo.Window
	hidden time.Time
}

// toggle opens the panel next to the icon, or closes it. The panel is built
// once and then shown and hidden, so reopening it is instant and costs
// nothing.
func (a *app) toggle() {
	if time.Since(a.hidden) < 150*time.Millisecond {
		return // the same click that dismissed the popover
	}
	panel := a.panel0()
	if panel.IsVisible() {
		panel.Hide()
		return
	}
	a.openPanel()
}

// openPanel shows the panel, but not before the click that asked for it has
// been handled. AppKit keeps the icon "pressed" for the rest of a click that
// opens a popover from it, and while it is, the icon swallows Space and
// Return and the popover closes when they are typed in it: showing the panel
// on the next turn of the main loop lets the click finish first.
func (a *app) openPanel() {
	go mygo.RunOnMain(func() {
		if a.panel == nil || a.panel.IsVisible() {
			return
		}
		a.panel.Show()
		a.panel.Focus()
	})
}

// panel0 builds the panel the first time and returns it: it is built hidden,
// so opening it is always openPanel's job, and the click that asked for it
// is not spent building it.
func (a *app) panel0() *mygo.Window {
	if a.panel == nil {
		a.panel = mygo.NewFlyout(mygo.FlyoutOptions{
			Tray:      a.tray,
			Placement: mygo.PlacementBottom,
			Gap:       6,
			Width:     340,
			Height:    470,
			Focusable: true,
			Hidden:    true,
			Popover:   true, // the system's translucent popover material
			URL:       "/",
		})
		a.panel.OnHide(func() { a.hidden = time.Now() })
		a.panel.OnClosed(func() { a.panel = nil })
	}
	return a.panel
}

// show brings the panel up on a view, which is what the global shortcuts are
// for: they work while the app sits in the menu bar. day is the note a view
// opens on.
func (a *app) show(view, day string) {
	panel := a.panel0()
	if !panel.IsVisible() {
		panel.Show()
	}
	panel.Focus()
	if err := ShowPanel.Emit(panel, Show{View: view, Day: day}); err != nil {
		log.Println("panel: ", err)
	}
}

// ready builds the tray icon once the application is ready.
func (a *app) ready() {
	var err error
	a.tray, err = mygo.NewTray(mygo.TrayOptions{
		Icon:           trayIcon(),
		IconIsTemplate: true,
		ToolTip:        "Todo",
	})
	if err != nil {
		log.Fatal("tray: ", err)
	}
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Open Today", Click: func(*mygo.MenuItem, *mygo.Window) { a.toggle() }},
		mygo.Separator(),
		{Role: mygo.RoleQuit},
	})
	if runtime.GOOS == "linux" {
		// AppIndicator reports neither clicks nor bounds: open from the menu.
		a.tray.SetMenu(menu)
	} else {
		a.tray.OnClick(a.toggle)
		a.tray.OnRightClick(func() {
			if a.panel != nil && a.panel.IsVisible() {
				a.panel.Hide()
			}
			a.tray.SetMenu(menu)
			defer a.tray.SetMenu(nil)
			a.tray.PopUpMenu()
		})
	}
	mygo.App.OnWillQuit(func(*mygo.QuitEvent) {
		a.tray.Destroy()
		mygo.GlobalShortcut.UnregisterAll()
	})

	// Cmd+Ctrl+Alt+Shift, which is what a Caps Lock set up as a hyper key
	// sends: today's note, and the day's list, from anywhere.
	if err := mygo.GlobalShortcut.Register("Cmd+Ctrl+Alt+Shift+N", func() {
		a.show("notes", today())
	}); err != nil {
		log.Println("shortcut: ", err)
	}
	if err := mygo.GlobalShortcut.Register("Cmd+Ctrl+Alt+Shift+T", func() {
		a.show("tasks", "")
	}); err != nil {
		log.Println("shortcut: ", err)
	}
}

// trayIcon draws a check mark in a rounded square, black on transparent so
// macOS tints it to match the menu bar.
func trayIcon() []byte {
	const size = 32
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	ink := color.NRGBA{A: 255}
	if runtime.GOOS != "darwin" {
		ink = color.NRGBA{R: 10, G: 122, B: 255, A: 255}
	}
	// The two strokes of the check, with round caps and joins.
	a := [2]float64{8, 16.5}
	b := [2]float64{13.5, 22}
	c := [2]float64{24, 10}
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			p := [2]float64{float64(x) + 0.5, float64(y) + 0.5}
			if distToSegment(p, a, b) < 2.4 || distToSegment(p, b, c) < 2.4 {
				img.Set(x, y, ink)
			}
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// distToSegment is the distance from p to the segment a-b.
func distToSegment(p, a, b [2]float64) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	len2 := dx*dx + dy*dy
	t := 0.0
	if len2 > 0 {
		t = ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / len2
		t = math.Max(0, math.Min(1, t))
	}
	return math.Hypot(p[0]-(a[0]+t*dx), p[1]-(a[1]+t*dy))
}

// today names the current local day, in the layout the stores use.
func today() string { return time.Now().Format("2006-01-02") }

func main() {
	mygo.App.SetName("Todo")
	// No Dock icon: this is a menu bar app.
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	// The panel is the app's only window: keep running as it hides.
	mygo.App.OnWindowAllClosed(func() {})

	// SetName first: it determines the user data directory.
	todosStore, err := todos.OpenStore()
	if err != nil {
		log.Fatal(err)
	}
	notesStore, err := notes.OpenNotes()
	if err != nil {
		log.Fatal(err)
	}
	mygo.Bind(todosStore)
	mygo.Bind(notesStore)
	todos.WatchMidnight(todosStore)

	a := &app{}
	mygo.App.WhenReady(a.ready)

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
