import type { ChildProcess } from "child_process";

// ── Database row types ──────────────────────────────────────

export interface SessionRow {
  channel_id: string;
  session_id: string;
  persisted: number;
  cwd: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CwdHistoryRow {
  path: string;
  last_used: string;
}

export interface ChannelDefaultRow {
  channel_id: string;
  cwd: string;
  set_by: string | null;
  updated_at: string;
}

export interface TeachingRow {
  id: number;
  instruction: string;
  added_by: string;
  workspace_id: string;
  created_at: string;
  active: number;
}

export interface ReminderRow {
  id: number;
  channel_id: string;
  user_id: string;
  bot_id: string;
  content: string;
  original_input: string;
  cron_expression: string | null;
  one_time: number;
  next_trigger_at: string;
  active: number;
  created_at: string;
}

export interface UsageLogRow {
  id: number;
  session_key: string;
  user_id: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  created_at: string;
}

export interface WorktreeRow {
  session_key: string;
  repo_path: string;
  worktree_path: string;
  branch_name: string;
  locked: number;
  created_at: string;
  last_active_at: string;
  cleaned_up: number;
}

export interface FeedbackRow {
  id: number;
  session_key: string;
  user_id: string;
  sentiment: string;
  message_ts: string | null;
  created_at: string;
}

export interface TeachingCountRow {
  count: number;
}

// ── Runtime types ───────────────────────────────────────────

export type ActiveProcessMap = Map<string, ChildProcess>;

export interface Ref<T> {
  value: T;
}

export interface HandleClaudeStreamOpts {
  channelId: string;
  threadTs: string;
  userText: string;
  userId: string;
  client: any;
  spawnCwd: string;
  isResume: boolean;
  sessionId: string;
  setStatus: (status: string) => Promise<void>;
  activeProcesses: ActiveProcessMap;
  cachedTeamId: string | null;
  botUserId: string | null;
}

export interface GitInfo {
  isGit: boolean;
  repoRoot: string | null;
}

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
}
