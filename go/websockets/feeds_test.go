package websockets

import (
	"github.com/cutechan/cutechan/go/feeds"
	"testing"
)

func TestStreamUpdates(t *testing.T) {
	feeds.Clear()
	assertTableClear(t, "boards")
	writeSampleBoard(t)
	writeSampleThread(t)

	sv := newWSServer(t)
	defer sv.Close()
	sv.Add(1)
	cl, wcl := sv.NewClient()
	registerClient(t, cl, 1, "a")
	go readListenErrors(t, cl, sv)

	assertMessage(
		t,
		wcl,
		`30{"recent":[1],"open":{"1":{"body":""}},"banned":[],"deleted":[],"deletedImage":[]}`,
	)
	assertMessage(t, wcl, "33351")

	// Send message
	feeds.SendTo(1, []byte("foo"))
	assertMessage(t, wcl, "33foo")

	cl.Close(nil)
	sv.Wait()
}
