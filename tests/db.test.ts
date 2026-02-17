import { describe, test, expect, beforeEach } from "bun:test";
import { createDatabase } from "../src/db.ts";

function freshDb() {
  return createDatabase(":memory:");
}

describe("sessions", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("getSession returns null for unknown channel", () => {
    expect(db.getSession("C999")).toBeNull();
  });

  test("upsertSession creates and retrieves a session", () => {
    db.upsertSession("C1", "sess-abc");
    const s = db.getSession("C1");
    expect(s).not.toBeNull();
    expect(s!.channel_id).toBe("C1");
    expect(s!.session_id).toBe("sess-abc");
    expect(s!.persisted).toBe(0);
  });

  test("upsertSession updates existing session", () => {
    db.upsertSession("C1", "sess-1");
    db.upsertSession("C1", "sess-2");
    const s = db.getSession("C1");
    expect(s!.session_id).toBe("sess-2");
    expect(s!.persisted).toBe(0);
  });

  test("markPersisted sets persisted flag", () => {
    db.upsertSession("C1", "sess-1");
    db.markPersisted("C1");
    expect(db.getSession("C1")!.persisted).toBe(1);
  });

  test("upsert after markPersisted resets persisted to 0", () => {
    db.upsertSession("C1", "sess-1");
    db.markPersisted("C1");
    db.upsertSession("C1", "sess-2");
    expect(db.getSession("C1")!.persisted).toBe(0);
  });

  test("deleteSession removes session", () => {
    db.upsertSession("C1", "sess-1");
    db.deleteSession("C1");
    expect(db.getSession("C1")).toBeNull();
  });

  test("setCwd updates session cwd", () => {
    db.upsertSession("C1", "sess-1");
    db.setCwd("C1", "/home/project");
    expect(db.getSession("C1")!.cwd).toBe("/home/project");
  });

  test("getAllActiveSessions returns sessions ordered by updated_at", () => {
    db.upsertSession("C1", "s1");
    db.upsertSession("C2", "s2");
    db.upsertSession("C3", "s3");
    const all = db.getAllActiveSessions();
    expect(all.length).toBe(3);
  });
});

describe("cwd_history", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("getCwdHistory is empty initially", () => {
    expect(db.getCwdHistory()).toEqual([]);
  });

  test("addCwdHistory adds and retrieves path", () => {
    db.addCwdHistory("/home/project");
    const history = db.getCwdHistory();
    expect(history.length).toBe(1);
    expect(history[0].path).toBe("/home/project");
  });

  test("addCwdHistory upserts on duplicate path", () => {
    db.addCwdHistory("/home/project");
    db.addCwdHistory("/home/project");
    expect(db.getCwdHistory().length).toBe(1);
  });
});

describe("channel_defaults", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("getChannelDefault returns null for unknown channel", () => {
    expect(db.getChannelDefault("C999")).toBeNull();
  });

  test("setChannelDefault creates and retrieves default", () => {
    db.setChannelDefault("C1", "/home/project", "U1");
    const d = db.getChannelDefault("C1");
    expect(d!.cwd).toBe("/home/project");
    expect(d!.set_by).toBe("U1");
  });

  test("setChannelDefault upserts on conflict", () => {
    db.setChannelDefault("C1", "/old", "U1");
    db.setChannelDefault("C1", "/new", "U2");
    const d = db.getChannelDefault("C1");
    expect(d!.cwd).toBe("/new");
    expect(d!.set_by).toBe("U2");
  });
});

describe("teachings", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("getTeachings returns empty for fresh db", () => {
    expect(db.getTeachings()).toEqual([]);
  });

  test("addTeaching + getTeachings round-trip", () => {
    db.addTeaching("Use bun not node", "U1");
    db.addTeaching("Always test", "U2");
    const teachings = db.getTeachings();
    expect(teachings.length).toBe(2);
    expect(teachings[0].instruction).toBe("Use bun not node");
    expect(teachings[1].instruction).toBe("Always test");
  });

  test("removeTeaching soft-deletes", () => {
    db.addTeaching("Remove me", "U1");
    const id = db.getTeachings()[0].id;
    db.removeTeaching(id);
    expect(db.getTeachings()).toEqual([]);
  });

  test("getTeachingCount reflects active teachings", () => {
    expect(db.getTeachingCount().count).toBe(0);
    db.addTeaching("one", "U1");
    db.addTeaching("two", "U1");
    expect(db.getTeachingCount().count).toBe(2);
    db.removeTeaching(db.getTeachings()[0].id);
    expect(db.getTeachingCount().count).toBe(1);
  });

  test("teachings are scoped by workspace_id", () => {
    db.addTeaching("default teaching", "U1", "default");
    db.addTeaching("team teaching", "U1", "team-a");
    expect(db.getTeachings("default").length).toBe(1);
    expect(db.getTeachings("team-a").length).toBe(1);
    expect(db.getTeachings("team-b").length).toBe(0);
  });
});

describe("usage_logs", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("getRecentUsage returns empty initially", () => {
    expect(db.getRecentUsage()).toEqual([]);
  });

  test("addUsageLog + getRecentUsage round-trip", () => {
    db.addUsageLog("thread-1", "U1", "claude-3", 100, 200, 0.05, 1000, 3);
    const logs = db.getRecentUsage();
    expect(logs.length).toBe(1);
    expect(logs[0].session_key).toBe("thread-1");
    expect(logs[0].input_tokens).toBe(100);
    expect(logs[0].output_tokens).toBe(200);
    expect(logs[0].total_cost_usd).toBeCloseTo(0.05);
    expect(logs[0].num_turns).toBe(3);
  });

  test("getRecentUsage respects limit", () => {
    for (let i = 0; i < 5; i++) {
      db.addUsageLog(`t-${i}`, "U1", "claude-3", 10, 20, 0.01, 100, 1);
    }
    expect(db.getRecentUsage(3).length).toBe(3);
    expect(db.getRecentUsage(10).length).toBe(5);
  });
});

describe("worktrees", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("getWorktree returns null for unknown session", () => {
    expect(db.getWorktree("unknown")).toBeNull();
  });

  test("upsertWorktree creates and retrieves worktree", () => {
    db.upsertWorktree("thread-1", "/repo", "/repo/trees/branch", "slack/branch");
    const wt = db.getWorktree("thread-1");
    expect(wt!.repo_path).toBe("/repo");
    expect(wt!.worktree_path).toBe("/repo/trees/branch");
    expect(wt!.branch_name).toBe("slack/branch");
    expect(wt!.cleaned_up).toBe(0);
  });

  test("upsertWorktree updates existing and resets cleaned_up", () => {
    db.upsertWorktree("thread-1", "/repo", "/old", "old-branch");
    db.markWorktreeCleaned("thread-1");
    expect(db.getWorktree("thread-1")!.cleaned_up).toBe(1);

    db.upsertWorktree("thread-1", "/repo", "/new", "new-branch");
    const wt = db.getWorktree("thread-1");
    expect(wt!.worktree_path).toBe("/new");
    expect(wt!.cleaned_up).toBe(0);
  });

  test("getActiveWorktrees excludes cleaned up", () => {
    db.upsertWorktree("t1", "/r", "/w1", "b1");
    db.upsertWorktree("t2", "/r", "/w2", "b2");
    db.markWorktreeCleaned("t1");
    const active = db.getActiveWorktrees();
    expect(active.length).toBe(1);
    expect(active[0].session_key).toBe("t2");
  });
});

describe("feedback", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("addFeedback inserts without error", () => {
    expect(() => {
      db.addFeedback("thread-1", "U1", "positive", "1234.5678");
    }).not.toThrow();
  });
});

describe("reminders", () => {
  let db: ReturnType<typeof createDatabase>;
  beforeEach(() => { db = freshDb(); });

  test("getActiveReminders returns empty initially", () => {
    expect(db.getActiveReminders("U1")).toEqual([]);
  });

  test("addReminder + getActiveReminders round-trip", () => {
    db.addReminder("C1", "U1", "B1", "standup", "remind standup", "0 9 * * *", 0, "2025-01-01 09:00:00");
    const reminders = db.getActiveReminders("U1");
    expect(reminders.length).toBe(1);
    expect(reminders[0].content).toBe("standup");
    expect(reminders[0].cron_expression).toBe("0 9 * * *");
  });

  test("deactivateReminder hides from active list", () => {
    db.addReminder("C1", "U1", "B1", "test", "test", null, 1, "2025-01-01 09:00:00");
    const id = db.getActiveReminders("U1")[0].id;
    db.deactivateReminder(id);
    expect(db.getActiveReminders("U1")).toEqual([]);
  });

  test("updateNextTrigger changes trigger time", () => {
    db.addReminder("C1", "U1", "B1", "test", "test", "0 9 * * *", 0, "2025-01-01 09:00:00");
    const id = db.getActiveReminders("U1")[0].id;
    db.updateNextTrigger("2025-01-02 09:00:00", id);
    expect(db.getActiveReminders("U1")[0].next_trigger_at).toBe("2025-01-02 09:00:00");
  });
});
