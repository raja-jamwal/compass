const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "sessions.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    channel_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    persisted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Add persisted column if migrating from old schema
try { db.exec("ALTER TABLE sessions ADD COLUMN persisted INTEGER DEFAULT 0"); } catch {}

// Add cwd column if migrating from old schema
try { db.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT DEFAULT NULL"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS cwd_history (
    path TEXT PRIMARY KEY,
    last_used TEXT DEFAULT (datetime('now'))
  )
`);

const getSession = db.prepare("SELECT * FROM sessions WHERE channel_id = ?");

const upsertSession = db.prepare(`
  INSERT INTO sessions (channel_id, session_id, persisted)
  VALUES (?, ?, 0)
  ON CONFLICT(channel_id) DO UPDATE SET
    session_id = excluded.session_id,
    persisted = 0,
    updated_at = datetime('now')
`);

const markPersisted = db.prepare(
  "UPDATE sessions SET persisted = 1, updated_at = datetime('now') WHERE channel_id = ?"
);

const deleteSession = db.prepare("DELETE FROM sessions WHERE channel_id = ?");

const setCwd = db.prepare(
  "UPDATE sessions SET cwd = ?, updated_at = datetime('now') WHERE channel_id = ?"
);

const getCwdHistory = db.prepare(
  "SELECT path, last_used FROM cwd_history ORDER BY last_used DESC"
);

const addCwdHistory = db.prepare(`
  INSERT INTO cwd_history (path, last_used) VALUES (?, datetime('now'))
  ON CONFLICT(path) DO UPDATE SET last_used = datetime('now')
`);

module.exports = {
  getSession: (channelId) => getSession.get(channelId),
  upsertSession: (channelId, sessionId) => upsertSession.run(channelId, sessionId),
  markPersisted: (channelId) => markPersisted.run(channelId),
  deleteSession: (channelId) => deleteSession.run(channelId),
  setCwd: (channelId, cwd) => setCwd.run(cwd, channelId),
  getCwdHistory: () => getCwdHistory.all(),
  addCwdHistory: (path) => addCwdHistory.run(path),
  db,
};
