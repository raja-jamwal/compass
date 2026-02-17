import { describe, test, expect } from "bun:test";
import { toSqliteDatetime } from "../src/lib/log.ts";
import { branchNameFromThread } from "../src/lib/worktree.ts";
import { toolTitle } from "../src/handlers/stream.ts";

describe("toSqliteDatetime", () => {
  test("formats Date object to SQLite datetime", () => {
    const result = toSqliteDatetime(new Date("2025-06-15T14:30:45.123Z"));
    expect(result).toBe("2025-06-15 14:30:45");
  });

  test("formats ISO string to SQLite datetime", () => {
    const result = toSqliteDatetime("2025-01-01T00:00:00.000Z");
    expect(result).toBe("2025-01-01 00:00:00");
  });

  test("strips milliseconds and timezone", () => {
    const result = toSqliteDatetime(new Date("2025-12-31T23:59:59.999Z"));
    expect(result).not.toContain("T");
    expect(result).not.toContain("Z");
    expect(result).not.toContain(".");
  });
});

describe("branchNameFromThread", () => {
  test("replaces dot with dash and adds slack/ prefix", () => {
    expect(branchNameFromThread("1234567890.123456")).toBe("slack/1234567890-123456");
  });

  test("handles thread_ts without dot", () => {
    expect(branchNameFromThread("1234567890")).toBe("slack/1234567890");
  });
});

describe("toolTitle", () => {
  test("Read shows file path", () => {
    expect(toolTitle("Read", { file_path: "/src/app.ts" })).toBe("Read /src/app.ts");
  });

  test("Write shows file path", () => {
    expect(toolTitle("Write", { file_path: "/src/db.ts" })).toBe("Write /src/db.ts");
  });

  test("Edit shows file path", () => {
    expect(toolTitle("Edit", { file_path: "/src/types.ts" })).toBe("Edit /src/types.ts");
  });

  test("Bash truncates long commands", () => {
    const longCmd = "a".repeat(100);
    const title = toolTitle("Bash", { command: longCmd });
    expect(title.length).toBeLessThanOrEqual(65);
    expect(title).toContain("...");
  });

  test("Bash shows short commands fully", () => {
    expect(toolTitle("Bash", { command: "ls -la" })).toBe("Run: ls -la");
  });

  test("Glob shows pattern", () => {
    expect(toolTitle("Glob", { pattern: "**/*.ts" })).toBe("Search: **/*.ts");
  });

  test("Grep shows pattern", () => {
    expect(toolTitle("Grep", { pattern: "TODO" })).toBe("Search: TODO");
  });

  test("unknown tool returns tool name", () => {
    expect(toolTitle("CustomTool", {})).toBe("CustomTool");
  });

  test("handles missing input gracefully", () => {
    expect(toolTitle("Read", {})).toBe("Read file");
    expect(toolTitle("Bash", {})).toBe("Run: ");
  });
});
