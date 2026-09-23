package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type SinkMailer struct {
	dir string
	mu  sync.Mutex
}

func NewSinkMailer(dir string) (*SinkMailer, error) {
	if dir == "" {
		return nil, ErrMailDeliveryUnavailable
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &SinkMailer{dir: dir}, nil
}

type SinkEntry struct {
	Recipient string `json:"recipient"`
	Purpose   string `json:"purpose"`
	Link      string `json:"link"`
}

func (m *SinkMailer) Send(_ context.Context, recipient, purpose, link string) (err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var nonce [8]byte
	_, _ = rand.Read(nonce[:])
	name := hex.EncodeToString(nonce[:]) + ".json"
	path := filepath.Join(m.dir, name)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
	}()
	return json.NewEncoder(f).Encode(SinkEntry{Recipient: recipient, Purpose: purpose, Link: link})
}

func (m *SinkMailer) EntriesFor(recipient, purpose string) ([]SinkEntry, error) {
	ents, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, err
	}
	var out []SinkEntry
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(m.dir, e.Name()))
		if err != nil {
			continue
		}
		var m0 SinkEntry
		if json.Unmarshal(b, &m0) != nil {
			continue
		}
		if m0.Recipient == recipient && m0.Purpose == purpose {
			out = append(out, m0)
		}
	}
	return out, nil
}
