package srv

import (
	"testing"
)

func TestNew(t *testing.T) {
	// Quick smoke test that New() can create a server with an in-memory-style db
	s, err := New(":memory:", "testhost")
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}
	if s.Hostname != "testhost" {
		t.Errorf("expected hostname testhost, got %s", s.Hostname)
	}
	if s.DB == nil {
		t.Error("expected DB to be set")
	}
}
