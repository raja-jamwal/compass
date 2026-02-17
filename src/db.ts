import { Database } from "bun:sqlite";
import path from "path";
import type {
  SessionRow, CwdHistoryRow, ChannelDefaultRow, TeachingRow,
  ReminderRow, UsageLogRow, WorktreeRow, TeachingCountRow,
} from "./types.ts";

// ── Factory ─────────────────────────────────────────────────

export function createDatabase(dbPath: string) {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");

  // ── Core tables ───────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      channel_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      persisted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrations for sessions table
  try { db.exec("ALTER TABLE sessions ADD COLUMN persisted INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN cwd TEXT DEFAULT NULL"); } catch {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT NULL"); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS cwd_history (
      path TEXT PRIMARY KEY,
      last_used TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_defaults (
      channel_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      set_by TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── Phase 1 tables ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instruction TEXT NOT NULL,
      added_by TEXT NOT NULL,
      workspace_id TEXT DEFAULT 'default',
      created_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'general',
      commit_hash TEXT,
      added_by TEXT NOT NULL,
      session_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_code TEXT UNIQUE NOT NULL,
      session_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      shared_by TEXT NOT NULL,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS watched_channels (
      channel_id TEXT PRIMARY KEY,
      added_by TEXT NOT NULL,
      watch_mode TEXT DEFAULT 'errors',
      rate_limit_minutes INTEGER DEFAULT 30,
      last_triggered_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      snapshot_name TEXT,
      git_stash_ref TEXT,
      git_branch TEXT,
      worktree_path TEXT,
      files_changed TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      workspace_id TEXT DEFAULT 'default',
      added_by TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(server_name, workspace_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sentiment TEXT NOT NULL,
      message_ts TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      session_key TEXT PRIMARY KEY,
      repo_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      locked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_active_at TEXT DEFAULT (datetime('now')),
      cleaned_up INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      content TEXT NOT NULL,
      original_input TEXT NOT NULL,
      cron_expression TEXT,
      one_time INTEGER DEFAULT 0,
      next_trigger_at TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── Prepared statements ───────────────────────────────────
  const _getSession = db.prepare("SELECT * FROM sessions WHERE channel_id = ?");
  const _upsertSession = db.prepare(`
    INSERT INTO sessions (channel_id, session_id, persisted)
    VALUES (?, ?, 0)
    ON CONFLICT(channel_id) DO UPDATE SET
      session_id = excluded.session_id,
      persisted = 0,
      updated_at = datetime('now')
  `);
  const _markPersisted = db.prepare(
    "UPDATE sessions SET persisted = 1, updated_at = datetime('now') WHERE channel_id = ?"
  );
  const _deleteSession = db.prepare("DELETE FROM sessions WHERE channel_id = ?");
  const _setCwd = db.prepare(
    "UPDATE sessions SET cwd = ?, updated_at = datetime('now') WHERE channel_id = ?"
  );
  const _getCwdHistory = db.prepare(
    "SELECT path, last_used FROM cwd_history ORDER BY last_used DESC"
  );
  const _addCwdHistory = db.prepare(`
    INSERT INTO cwd_history (path, last_used) VALUES (?, datetime('now'))
    ON CONFLICT(path) DO UPDATE SET last_used = datetime('now')
  `);
  const _getAllActiveSessions = db.prepare(
    "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 20"
  );
  const _getChannelDefault = db.prepare(
    "SELECT * FROM channel_defaults WHERE channel_id = ?"
  );
  const _setChannelDefault = db.prepare(`
    INSERT INTO channel_defaults (channel_id, cwd, set_by)
    VALUES (?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      cwd = excluded.cwd,
      set_by = excluded.set_by,
      updated_at = datetime('now')
  `);
  const _addReminder = db.prepare(`
    INSERT INTO reminders (channel_id, user_id, bot_id, content, original_input, cron_expression, one_time, next_trigger_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const _getDueReminders = db.prepare(
    "SELECT * FROM reminders WHERE active = 1 AND next_trigger_at <= datetime('now')"
  );
  const _updateNextTrigger = db.prepare(
    "UPDATE reminders SET next_trigger_at = ? WHERE id = ?"
  );
  const _deactivateReminder = db.prepare(
    "UPDATE reminders SET active = 0 WHERE id = ?"
  );
  const _getActiveReminders = db.prepare(
    "SELECT * FROM reminders WHERE active = 1 AND user_id = ? ORDER BY next_trigger_at"
  );
  const _addTeaching = db.prepare(`
    INSERT INTO team_knowledge (instruction, added_by, workspace_id)
    VALUES (?, ?, ?)
  `);
  const _getTeachings = db.prepare(
    "SELECT id, instruction, added_by, created_at FROM team_knowledge WHERE workspace_id = ? AND active = 1 ORDER BY id"
  );
  const _removeTeaching = db.prepare(
    "UPDATE team_knowledge SET active = 0 WHERE id = ?"
  );
  const _getTeachingCount = db.prepare(
    "SELECT COUNT(*) as count FROM team_knowledge WHERE workspace_id = ? AND active = 1"
  );
  const _addUsageLog = db.prepare(`
    INSERT INTO usage_logs (session_key, user_id, model, input_tokens, output_tokens, total_cost_usd, duration_ms, num_turns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const _getRecentUsage = db.prepare(
    "SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT ?"
  );
  const _upsertWorktree = db.prepare(`
    INSERT INTO worktrees (session_key, repo_path, worktree_path, branch_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      repo_path = excluded.repo_path,
      worktree_path = excluded.worktree_path,
      branch_name = excluded.branch_name,
      last_active_at = datetime('now'),
      cleaned_up = 0
  `);
  const _getWorktree = db.prepare(
    "SELECT * FROM worktrees WHERE session_key = ?"
  );
  const _touchWorktree = db.prepare(
    "UPDATE worktrees SET last_active_at = datetime('now') WHERE session_key = ?"
  );
  const _markWorktreeCleaned = db.prepare(
    "UPDATE worktrees SET cleaned_up = 1 WHERE session_key = ?"
  );
  const _getStaleWorktrees = db.prepare(
    "SELECT * FROM worktrees WHERE cleaned_up = 0 AND last_active_at < datetime('now', '-' || ? || ' minutes')"
  );
  const _getActiveWorktrees = db.prepare(
    "SELECT * FROM worktrees WHERE cleaned_up = 0"
  );
  const _addFeedback = db.prepare(`
    INSERT INTO feedback (session_key, user_id, sentiment, message_ts)
    VALUES (?, ?, ?, ?)
  `);

  // ── Return all accessors ──────────────────────────────────
  return {
    db,
    getSession(channelId: string): SessionRow | null {
      return _getSession.get(channelId) as SessionRow | null;
    },
    upsertSession(channelId: string, sessionId: string): void {
      _upsertSession.run(channelId, sessionId);
    },
    markPersisted(channelId: string): void {
      _markPersisted.run(channelId);
    },
    deleteSession(channelId: string): void {
      _deleteSession.run(channelId);
    },
    setCwd(channelId: string, cwd: string): void {
      _setCwd.run(cwd, channelId);
    },
    getCwdHistory(): CwdHistoryRow[] {
      return _getCwdHistory.all() as CwdHistoryRow[];
    },
    addCwdHistory(p: string): void {
      _addCwdHistory.run(p);
    },
    getAllActiveSessions(): SessionRow[] {
      return _getAllActiveSessions.all() as SessionRow[];
    },
    getChannelDefault(channelId: string): ChannelDefaultRow | null {
      return _getChannelDefault.get(channelId) as ChannelDefaultRow | null;
    },
    setChannelDefault(channelId: string, cwd: string, setBy: string): void {
      _setChannelDefault.run(channelId, cwd, setBy);
    },
    addTeaching(instruction: string, addedBy: string, workspaceId: string = "default"): void {
      _addTeaching.run(instruction, addedBy, workspaceId);
    },
    getTeachings(workspaceId: string = "default"): TeachingRow[] {
      return _getTeachings.all(workspaceId) as TeachingRow[];
    },
    removeTeaching(id: number): void {
      _removeTeaching.run(id);
    },
    getTeachingCount(workspaceId: string = "default"): TeachingCountRow {
      return _getTeachingCount.get(workspaceId) as TeachingCountRow;
    },
    addUsageLog(
      sessionKey: string, userId: string, model: string | null,
      inputTokens: number, outputTokens: number, cost: number,
      durationMs: number, numTurns: number
    ): void {
      _addUsageLog.run(sessionKey, userId, model, inputTokens, outputTokens, cost, durationMs, numTurns);
    },
    getRecentUsage(limit: number = 10): UsageLogRow[] {
      return _getRecentUsage.all(limit) as UsageLogRow[];
    },
    upsertWorktree(sessionKey: string, repoPath: string, worktreePath: string, branchName: string): void {
      _upsertWorktree.run(sessionKey, repoPath, worktreePath, branchName);
    },
    getWorktree(sessionKey: string): WorktreeRow | null {
      return _getWorktree.get(sessionKey) as WorktreeRow | null;
    },
    touchWorktree(sessionKey: string): void {
      _touchWorktree.run(sessionKey);
    },
    markWorktreeCleaned(sessionKey: string): void {
      _markWorktreeCleaned.run(sessionKey);
    },
    getStaleWorktrees(idleMinutes: number): WorktreeRow[] {
      return _getStaleWorktrees.all(idleMinutes) as WorktreeRow[];
    },
    getActiveWorktrees(): WorktreeRow[] {
      return _getActiveWorktrees.all() as WorktreeRow[];
    },
    addFeedback(sessionKey: string, userId: string, sentiment: string, messageTs: string): void {
      _addFeedback.run(sessionKey, userId, sentiment, messageTs);
    },
    addReminder(
      channelId: string, userId: string, botId: string, content: string,
      originalInput: string, cronExpression: string | null, oneTime: number, nextTriggerAt: string
    ): void {
      _addReminder.run(channelId, userId, botId, content, originalInput, cronExpression, oneTime, nextTriggerAt);
    },
    getDueReminders(): ReminderRow[] {
      return _getDueReminders.all() as ReminderRow[];
    },
    updateNextTrigger(nextTriggerAt: string, id: number): void {
      _updateNextTrigger.run(nextTriggerAt, id);
    },
    deactivateReminder(id: number): void {
      _deactivateReminder.run(id);
    },
    getActiveReminders(userId: string): ReminderRow[] {
      return _getActiveReminders.all(userId) as ReminderRow[];
    },
  };
}

// ── Default instance (production) ───────────────────────────

const defaultDb = createDatabase(path.join(import.meta.dir, "..", "sessions.db"));

export const {
  db,
  getSession, upsertSession, markPersisted, deleteSession,
  setCwd, getCwdHistory, addCwdHistory, getAllActiveSessions,
  getChannelDefault, setChannelDefault,
  addTeaching, getTeachings, removeTeaching, getTeachingCount,
  addUsageLog, getRecentUsage,
  upsertWorktree, getWorktree, touchWorktree, markWorktreeCleaned,
  getStaleWorktrees, getActiveWorktrees,
  addFeedback,
  addReminder, getDueReminders, updateNextTrigger, deactivateReminder, getActiveReminders,
} = defaultDb;
