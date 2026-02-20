import { describe, test, expect } from "bun:test";
import { extractGapMessages, formatGapMessages, type ThreadMessage } from "../src/lib/thread-context.ts";

const BOT_USER_ID = "U_BOT";

function msg(user: string, text: string, ts: string, extra?: Partial<ThreadMessage>): ThreadMessage {
  return { user, text, ts, ...extra };
}

describe("extractGapMessages", () => {
  test("returns gap messages after bot's last reply", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "Let's refactor auth", "1.0"),
      msg(BOT_USER_ID, "Sure, here's my suggestion", "2.0"),
      msg("U2", "What about JWT?", "3.0"),
      msg("U3", "Yeah JWT makes sense", "4.0"),
      msg("U1", "@bot thoughts on JWT?", "5.0"),
    ];

    const gap = extractGapMessages(messages, "5.0", BOT_USER_ID);
    expect(gap).toHaveLength(2);
    expect(gap[0].text).toBe("What about JWT?");
    expect(gap[1].text).toBe("Yeah JWT makes sense");
  });

  test("returns up to 50 messages when no bot message exists", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "Let's discuss the deploy", "1.0"),
      msg("U2", "I think staging is broken", "2.0"),
      msg("U3", "Let me check", "3.0"),
      msg("U1", "@bot can you help?", "4.0"),
    ];

    const gap = extractGapMessages(messages, "4.0", BOT_USER_ID);
    expect(gap).toHaveLength(3);
    expect(gap[0].text).toBe("Let's discuss the deploy");
    expect(gap[1].text).toBe("I think staging is broken");
    expect(gap[2].text).toBe("Let me check");
  });

  test("returns empty when bot message is right before the mention", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "Hey", "1.0"),
      msg(BOT_USER_ID, "Hello!", "2.0"),
      msg("U1", "@bot do more", "3.0"),
    ];

    const gap = extractGapMessages(messages, "3.0", BOT_USER_ID);
    expect(gap).toHaveLength(0);
  });

  test("stops at the most recent bot message when multiple exist", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "First question", "1.0"),
      msg(BOT_USER_ID, "First answer", "2.0"),
      msg("U2", "Follow up", "3.0"),
      msg(BOT_USER_ID, "Second answer", "4.0"),
      msg("U3", "Another topic", "5.0"),
      msg("U1", "@bot help", "6.0"),
    ];

    const gap = extractGapMessages(messages, "6.0", BOT_USER_ID);
    expect(gap).toHaveLength(1);
    expect(gap[0].text).toBe("Another topic");
  });

  test("caps at 50 gap messages", () => {
    const messages: ThreadMessage[] = [];
    for (let i = 0; i < 60; i++) {
      messages.push(msg("U1", `Message ${i}`, `${i}.0`));
    }
    messages.push(msg("U1", "@bot help", "100.0"));

    const gap = extractGapMessages(messages, "100.0", BOT_USER_ID);
    expect(gap).toHaveLength(50);
    // Should be the last 50 messages (indices 10-59)
    expect(gap[0].text).toBe("Message 10");
    expect(gap[49].text).toBe("Message 59");
  });

  test("excludes the current mention message", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "Hey", "1.0"),
      msg("U1", "@bot help me", "2.0"),
    ];

    const gap = extractGapMessages(messages, "2.0", BOT_USER_ID);
    expect(gap).toHaveLength(1);
    expect(gap[0].text).toBe("Hey");
    // The mention itself should not appear
    expect(gap.find((m) => m.ts === "2.0")).toBeUndefined();
  });

  test("identifies bot by bot_id field", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "Start", "1.0"),
      msg("U_OTHER", "Bot reply", "2.0", { bot_id: "B123" }),
      msg("U2", "After bot", "3.0"),
      msg("U1", "@bot hi", "4.0"),
    ];

    const gap = extractGapMessages(messages, "4.0", BOT_USER_ID);
    expect(gap).toHaveLength(1);
    expect(gap[0].text).toBe("After bot");
  });

  test("identifies bot by user field matching botUserId", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "Before", "1.0"),
      msg(BOT_USER_ID, "Bot says hi", "2.0"),
      msg("U2", "After", "3.0"),
      msg("U1", "@bot yo", "4.0"),
    ];

    const gap = extractGapMessages(messages, "4.0", BOT_USER_ID);
    expect(gap).toHaveLength(1);
    expect(gap[0].text).toBe("After");
  });

  test("returns empty for empty messages array", () => {
    const gap = extractGapMessages([], "1.0", BOT_USER_ID);
    expect(gap).toHaveLength(0);
  });

  test("returns empty when thread has only the mention", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "@bot help", "1.0"),
    ];

    const gap = extractGapMessages(messages, "1.0", BOT_USER_ID);
    expect(gap).toHaveLength(0);
  });

  test("works when botUserId is null (uses bot_id only)", () => {
    const messages: ThreadMessage[] = [
      msg("U1", "Start", "1.0"),
      msg("U_ANY", "Bot reply", "2.0", { bot_id: "B456" }),
      msg("U2", "Gap msg", "3.0"),
      msg("U1", "@bot hi", "4.0"),
    ];

    const gap = extractGapMessages(messages, "4.0", null);
    expect(gap).toHaveLength(1);
    expect(gap[0].text).toBe("Gap msg");
  });
});

describe("formatGapMessages", () => {
  test("returns empty string for no gap messages", () => {
    expect(formatGapMessages([])).toBe("");
  });

  test("formats messages with user mentions and header", () => {
    const gap: ThreadMessage[] = [
      msg("U1", "Use JWT for auth", "1.0"),
      msg("U2", "Agreed", "2.0"),
    ];

    const result = formatGapMessages(gap);
    expect(result).toContain("[Thread context");
    expect(result).toContain("<@U1>: Use JWT for auth");
    expect(result).toContain("<@U2>: Agreed");
    expect(result).toEndWith("---\n");
  });

  test("handles missing user with 'unknown'", () => {
    const gap: ThreadMessage[] = [
      { ts: "1.0", text: "Hello" },
    ];

    const result = formatGapMessages(gap);
    expect(result).toContain("<@unknown>: Hello");
  });

  test("handles missing text gracefully", () => {
    const gap: ThreadMessage[] = [
      { ts: "1.0", user: "U1" },
    ];

    const result = formatGapMessages(gap);
    expect(result).toContain("<@U1>: ");
  });
});
