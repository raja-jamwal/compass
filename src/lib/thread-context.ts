/**
 * Thread context extraction for bot mentions.
 *
 * When the bot is @mentioned in a thread, fetches the "gap" messages —
 * messages between the bot's last reply and the current mention — so
 * Claude has context of the conversation it missed.
 */

import { log, logErr } from "./log.ts";

const MAX_GAP_MESSAGES = 50;

export interface ThreadMessage {
  user?: string;
  text?: string;
  ts: string;
  bot_id?: string;
}

/**
 * Pure logic: extract gap messages from a list of thread messages.
 *
 * Walks backwards from the end, collecting messages until it hits one
 * from the bot (identified by `bot_id` field or `user === botUserId`).
 * The current mention message is excluded. Returns up to 50 messages
 * in chronological order.
 */
export function extractGapMessages(
  messages: ThreadMessage[],
  currentMessageTs: string,
  botUserId: string | null,
): ThreadMessage[] {
  // Filter out the current mention message
  const filtered = messages.filter((m) => m.ts !== currentMessageTs);

  const gap: ThreadMessage[] = [];
  for (let i = filtered.length - 1; i >= 0; i--) {
    const msg = filtered[i];
    if (msg.bot_id || (botUserId && msg.user === botUserId)) break;
    gap.unshift(msg);
    if (gap.length >= MAX_GAP_MESSAGES) break;
  }

  return gap;
}

/**
 * Format gap messages into a context string for Claude's prompt.
 */
export function formatGapMessages(gap: ThreadMessage[]): string {
  if (gap.length === 0) return "";

  const lines = gap.map((m) => `<@${m.user || "unknown"}>: ${m.text || ""}`);
  return (
    "[Thread context — messages since my last reply]\n" +
    lines.join("\n") +
    "\n\n---\n"
  );
}

/**
 * Fetch thread replies from Slack and return formatted gap context.
 *
 * Returns an empty string if there are no gap messages or if the
 * mention is not in a thread.
 */
export async function fetchThreadContext(
  client: any,
  channelId: string,
  threadTs: string,
  currentMessageTs: string,
  botUserId: string | null,
): Promise<string> {
  try {
    log(channelId, `Fetching thread context: threadTs=${threadTs} currentTs=${currentMessageTs} botUserId=${botUserId}`);

    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 200,
    });

    const messages: ThreadMessage[] = result.messages || [];
    log(channelId, `Thread replies: ${messages.length} message(s) fetched`);

    const gap = extractGapMessages(messages, currentMessageTs, botUserId);
    log(channelId, `Thread context: ${gap.length} gap message(s) found`);

    const formatted = formatGapMessages(gap);
    if (formatted) {
      log(channelId, `Thread context injected (${formatted.length} chars)`);
    }

    return formatted;
  } catch (err: any) {
    logErr(channelId, `Failed to fetch thread context: ${err.message}`);
    return "";
  }
}
