import { describe, test, expect, mock } from "bun:test";

/**
 * Tests for the setStatus wiring used in channel @mentions.
 *
 * The setStatus function built in app.ts processMessage normalizes
 * string/object input and delegates to client.assistant.threads.setStatus.
 * We recreate the same logic here to test it in isolation.
 */

function createChannelSetStatus(
  client: any,
  channelId: string,
  threadTs: string,
) {
  return async (statusOrOpts: string | { status: string; loading_messages?: string[] }) => {
    const params = typeof statusOrOpts === "string"
      ? { status: statusOrOpts }
      : statusOrOpts;
    await client.assistant.threads.setStatus({
      channel_id: channelId,
      thread_ts: threadTs,
      ...params,
    });
  };
}

describe("channel setStatus", () => {
  test("string input — wraps as { status } and includes channel/thread", async () => {
    const calls: any[] = [];
    const client = {
      assistant: {
        threads: {
          setStatus: mock(async (args: any) => { calls.push(args); }),
        },
      },
    };

    const setStatus = createChannelSetStatus(client, "C123", "1234.5678");
    await setStatus("is reading files...");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channel_id: "C123",
      thread_ts: "1234.5678",
      status: "is reading files...",
    });
  });

  test("object input — spreads status + loading_messages with channel/thread", async () => {
    const calls: any[] = [];
    const client = {
      assistant: {
        threads: {
          setStatus: mock(async (args: any) => { calls.push(args); }),
        },
      },
    };

    const setStatus = createChannelSetStatus(client, "C456", "9999.1111");
    await setStatus({
      status: "is thinking...",
      loading_messages: ["Thinking...", "Working on it..."],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channel_id: "C456",
      thread_ts: "9999.1111",
      status: "is thinking...",
      loading_messages: ["Thinking...", "Working on it..."],
    });
  });

  test("empty string clears status", async () => {
    const calls: any[] = [];
    const client = {
      assistant: {
        threads: {
          setStatus: mock(async (args: any) => { calls.push(args); }),
        },
      },
    };

    const setStatus = createChannelSetStatus(client, "C789", "5555.6666");
    await setStatus("");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channel_id: "C789",
      thread_ts: "5555.6666",
      status: "",
    });
  });

  test("multiple calls accumulate correctly", async () => {
    const calls: any[] = [];
    const client = {
      assistant: {
        threads: {
          setStatus: mock(async (args: any) => { calls.push(args); }),
        },
      },
    };

    const setStatus = createChannelSetStatus(client, "C100", "1111.2222");
    await setStatus({ status: "is thinking...", loading_messages: ["Thinking..."] });
    await setStatus("is reading files...");
    await setStatus("");

    expect(calls).toHaveLength(3);
    expect(calls[0].status).toBe("is thinking...");
    expect(calls[0].loading_messages).toEqual(["Thinking..."]);
    expect(calls[1].status).toBe("is reading files...");
    expect(calls[1].loading_messages).toBeUndefined();
    expect(calls[2].status).toBe("");
  });
});
