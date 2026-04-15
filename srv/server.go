package srv

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"

	"srv.exe.dev/db"
)

// Server is the main web terminal server.
type Server struct {
	DB           *sql.DB
	Hostname     string
	TemplatesDir string
	StaticDir    string
}

// wsMessage is the JSON message format for WebSocket communication.
type wsMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// historyEntry represents a command history record.
type historyEntry struct {
	ID        int64  `json:"id"`
	Command   string `json:"command"`
	CreatedAt string `json:"created_at"`
}

// bookmarkEntry represents a saved bookmark.
type bookmarkEntry struct {
	ID        int64  `json:"id"`
	Command   string `json:"command"`
	Label     string `json:"label"`
	CreatedAt string `json:"created_at"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // allow all origins for local/dev use
	},
}

// New creates a new Server, initializes the database, and resolves template/static paths.
func New(dbPath, hostname string) (*Server, error) {
	_, thisFile, _, _ := runtime.Caller(0)
	baseDir := filepath.Dir(thisFile)
	srv := &Server{
		Hostname:     hostname,
		TemplatesDir: filepath.Join(baseDir, "templates"),
		StaticDir:    filepath.Join(baseDir, "static"),
	}
	if err := srv.setUpDatabase(dbPath); err != nil {
		return nil, err
	}
	return srv, nil
}

// setUpDatabase opens the SQLite database and runs migrations.
func (s *Server) setUpDatabase(dbPath string) error {
	wdb, err := db.Open(dbPath)
	if err != nil {
		return fmt.Errorf("failed to open db: %w", err)
	}
	s.DB = wdb
	if err := db.RunMigrations(wdb); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}
	return nil
}

// Serve starts the HTTP server with all configured routes.
func (s *Server) Serve(addr string) error {
	mux := http.NewServeMux()

	// Frontend
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(s.StaticDir))))

	// WebSocket terminal
	mux.HandleFunc("/ws", s.handleWebSocket)

	// Command history API
	mux.HandleFunc("GET /api/history", s.handleGetHistory)
	mux.HandleFunc("POST /api/history", s.handlePostHistory)

	// Bookmarks API
	mux.HandleFunc("GET /api/bookmarks", s.handleGetBookmarks)
	mux.HandleFunc("POST /api/bookmarks", s.handlePostBookmark)
	mux.HandleFunc("DELETE /api/bookmarks/{id}", s.handleDeleteBookmark)

	slog.Info("starting server", "addr", addr)
	return http.ListenAndServe(addr, mux)
}

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	path := filepath.Join(s.TemplatesDir, "index.html")
	tmpl, err := template.ParseFiles(path)
	if err != nil {
		slog.Error("parse template", "error", err)
		http.Error(w, "template error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	data := struct {
		Hostname string
	}{
		Hostname: s.Hostname,
	}
	if err := tmpl.Execute(w, data); err != nil {
		slog.Error("execute template", "error", err)
	}
}

// ---------------------------------------------------------------------------
// WebSocket terminal
// ---------------------------------------------------------------------------

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("websocket upgrade", "error", err)
		return
	}
	defer conn.Close()

	// Spawn bash via PTY
	cmd := exec.Command("bash")
	ptmx, err := pty.Start(cmd)
	if err != nil {
		slog.Error("pty start", "error", err)
		_ = conn.WriteJSON(wsMessage{Type: "output", Data: base64.StdEncoding.EncodeToString([]byte("Error: " + err.Error() + "\r\n"))})
		return
	}
	defer func() {
		_ = ptmx.Close()
		// Kill the process if it's still running
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}()

	// Use a WaitGroup to coordinate goroutines
	var wg sync.WaitGroup
	done := make(chan struct{})

	// PTY -> WebSocket (read from PTY, send to browser)
	wg.Add(1)
	go func() {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				if err != io.EOF {
					slog.Debug("pty read error", "error", err)
				}
				close(done)
				return
			}
			if n > 0 {
				msg := wsMessage{
					Type: "output",
					Data: base64.StdEncoding.EncodeToString(buf[:n]),
				}
				if err := conn.WriteJSON(msg); err != nil {
					slog.Debug("websocket write error", "error", err)
					close(done)
					return
				}
			}
		}
	}()

	// WebSocket -> PTY (read from browser, write to PTY)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
			}

			var msg wsMessage
			if err := conn.ReadJSON(&msg); err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
					slog.Debug("websocket read error", "error", err)
				}
				return
			}

			switch msg.Type {
			case "input":
				decoded, err := base64.StdEncoding.DecodeString(msg.Data)
				if err != nil {
					slog.Warn("base64 decode error", "error", err)
					continue
				}
				if _, err := ptmx.Write(decoded); err != nil {
					slog.Debug("pty write error", "error", err)
					return
				}
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					winSize := &pty.Winsize{
						Cols: msg.Cols,
						Rows: msg.Rows,
					}
					if err := pty.Setsize(ptmx, winSize); err != nil {
						slog.Warn("pty resize error", "error", err)
					}
				}
			default:
				slog.Warn("unknown message type", "type", msg.Type)
			}
		}
	}()

	wg.Wait()
	slog.Info("websocket session ended")
}

// ---------------------------------------------------------------------------
// Command History API
// ---------------------------------------------------------------------------

func (s *Server) handleGetHistory(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT id, command, created_at FROM command_history ORDER BY created_at DESC LIMIT 200")
	if err != nil {
		slog.Error("query history", "error", err)
		http.Error(w, "database error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	entries := make([]historyEntry, 0)
	for rows.Next() {
		var e historyEntry
		var t time.Time
		if err := rows.Scan(&e.ID, &e.Command, &t); err != nil {
			slog.Error("scan history row", "error", err)
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		e.CreatedAt = t.Format(time.RFC3339)
		entries = append(entries, e)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

func (s *Server) handlePostHistory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Command string `json:"command"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if body.Command == "" {
		http.Error(w, "command is required", http.StatusBadRequest)
		return
	}

	result, err := s.DB.ExecContext(r.Context(),
		"INSERT INTO command_history (command) VALUES (?)", body.Command)
	if err != nil {
		slog.Error("insert history", "error", err)
		http.Error(w, "database error", http.StatusInternalServerError)
		return
	}

	id, _ := result.LastInsertId()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(historyEntry{
		ID:        id,
		Command:   body.Command,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

// ---------------------------------------------------------------------------
// Bookmarks API
// ---------------------------------------------------------------------------

func (s *Server) handleGetBookmarks(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.QueryContext(r.Context(),
		"SELECT id, command, label, created_at FROM bookmarks ORDER BY created_at DESC")
	if err != nil {
		slog.Error("query bookmarks", "error", err)
		http.Error(w, "database error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	entries := make([]bookmarkEntry, 0)
	for rows.Next() {
		var e bookmarkEntry
		var t time.Time
		if err := rows.Scan(&e.ID, &e.Command, &e.Label, &t); err != nil {
			slog.Error("scan bookmark row", "error", err)
			http.Error(w, "database error", http.StatusInternalServerError)
			return
		}
		e.CreatedAt = t.Format(time.RFC3339)
		entries = append(entries, e)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(entries)
}

func (s *Server) handlePostBookmark(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Command string `json:"command"`
		Label   string `json:"label"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if body.Command == "" {
		http.Error(w, "command is required", http.StatusBadRequest)
		return
	}

	result, err := s.DB.ExecContext(r.Context(),
		"INSERT INTO bookmarks (command, label) VALUES (?, ?)", body.Command, body.Label)
	if err != nil {
		slog.Error("insert bookmark", "error", err)
		http.Error(w, "database error", http.StatusInternalServerError)
		return
	}

	id, _ := result.LastInsertId()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(bookmarkEntry{
		ID:        id,
		Command:   body.Command,
		Label:     body.Label,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Server) handleDeleteBookmark(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	result, err := s.DB.ExecContext(r.Context(),
		"DELETE FROM bookmarks WHERE id = ?", id)
	if err != nil {
		slog.Error("delete bookmark", "error", err)
		http.Error(w, "database error", http.StatusInternalServerError)
		return
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
