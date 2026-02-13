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

module.exports = {
  getSession: (channelId) => getSession.get(channelId),
  upsertSession: (channelId, sessionId) => upsertSession.run(channelId, sessionId),
  markPersisted: (channelId) => markPersisted.run(channelId),
  deleteSession: (channelId) => deleteSession.run(channelId),
  db,
};
