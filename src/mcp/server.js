#!/usr/bin/env node

/**
 * Claude-slacker MCP Server
 *
 * Exposes bot management tools (reminders, teachings, etc.) via MCP stdio transport.
 * Can run standalone or be spawned by the Claude CLI as an MCP server.
 *
 * Usage:
 *   node mcp-server.js            # stdio transport (for Claude CLI)
 *   ./setup.sh                    # register in user MCP config
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = require("zod");
const { CronExpressionParser } = require("cron-parser");

// ── Database ────────────────────────────────────────────────
const {
  addReminder,
  getDueReminders,
  updateNextTrigger,
  deactivateReminder,
  getActiveReminders,
  addTeaching,
  getTeachings,
  removeTeaching,
  getTeachingCount,
  getChannelDefault,
  setChannelDefault,
} = require("../db");

// ── Helpers ─────────────────────────────────────────────────

function toSqliteDatetime(d) {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

// Context defaults from env (injected by stream-handler when spawning Claude CLI)
const DEFAULT_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || null;
const DEFAULT_USER_ID = process.env.SLACK_USER_ID || null;
const DEFAULT_BOT_USER_ID = process.env.SLACK_BOT_USER_ID || null;

// ── Server ──────────────────────────────────────────────────

const server = new McpServer({
  name: "claude-slacker",
  version: "1.0.0",
});

// ── Reminder tools ──────────────────────────────────────────

server.registerTool(
  "claude_bot_create_reminder",
  {
    description:
      "Create a scheduled reminder. For recurring reminders, provide a 5-field cron expression. For one-time reminders, provide an ISO 8601 datetime. The reminder will trigger Claude in the specified Slack channel at the scheduled time.",
    inputSchema: {
      channel_id: z.string().optional().describe("Slack channel ID (auto-detected from session context)"),
      user_id: z.string().optional().describe("Slack user ID (auto-detected from session context)"),
      bot_id: z.string().optional().describe("Bot user ID (auto-detected from session context)"),
      content: z.string().describe("The task/action Claude should perform when the reminder fires"),
      cron: z
        .string()
        .optional()
        .describe("5-field cron expression for recurring reminders (e.g. '0 9 * * 1-5' for weekdays at 9am)"),
      one_time_at: z
        .string()
        .optional()
        .describe("ISO 8601 datetime for one-time reminders (e.g. '2026-02-17T15:00:00Z')"),
    },
  },
  async (params) => {
    const channel_id = params.channel_id || DEFAULT_CHANNEL_ID;
    const user_id = params.user_id || DEFAULT_USER_ID;
    const bot_id = params.bot_id || DEFAULT_BOT_USER_ID;

    if (!channel_id || !user_id || !bot_id) {
      return { content: [{ type: "text", text: "Error: Missing channel_id, user_id, or bot_id and no session context available." }] };
    }

    const { content, cron, one_time_at } = params;

    if (!cron && !one_time_at) {
      return { content: [{ type: "text", text: "Error: Provide either 'cron' (recurring) or 'one_time_at' (one-time)." }] };
    }

    let nextTriggerAt;
    let cronExpression = null;
    let oneTime = 0;

    if (cron) {
      try {
        const interval = CronExpressionParser.parse(cron);
        nextTriggerAt = toSqliteDatetime(interval.next().toDate());
        cronExpression = cron;
      } catch (err) {
        return { content: [{ type: "text", text: `Error: Invalid cron expression "${cron}": ${err.message}` }] };
      }
    } else {
      const triggerDate = new Date(one_time_at);
      if (isNaN(triggerDate.getTime())) {
        return { content: [{ type: "text", text: `Error: Invalid datetime "${one_time_at}".` }] };
      }
      if (triggerDate <= new Date()) {
        return { content: [{ type: "text", text: "Error: That time is in the past. Specify a future time." }] };
      }
      nextTriggerAt = toSqliteDatetime(triggerDate);
      oneTime = 1;
    }

    const originalInput = cron ? `[MCP] ${content} (cron: ${cron})` : `[MCP] ${content} (at: ${one_time_at})`;
    addReminder(channel_id, user_id, bot_id, content, originalInput, cronExpression, oneTime, nextTriggerAt);

    const scheduleDesc = cronExpression ? `recurring (cron: ${cronExpression})` : "one-time";
    return {
      content: [
        {
          type: "text",
          text: `Reminder created.\nContent: ${content}\nSchedule: ${scheduleDesc}\nNext trigger: ${nextTriggerAt}\nChannel: ${channel_id}`,
        },
      ],
    };
  }
);

server.registerTool(
  "claude_bot_list_reminders",
  {
    description: "List all active reminders for a user.",
    inputSchema: {
      user_id: z.string().optional().describe("Slack user ID (auto-detected from session context)"),
    },
  },
  async (params) => {
    const user_id = params.user_id || DEFAULT_USER_ID;
    if (!user_id) {
      return { content: [{ type: "text", text: "Error: Missing user_id and no session context available." }] };
    }
    const reminders = getActiveReminders(user_id);
    if (reminders.length === 0) {
      return { content: [{ type: "text", text: "No active reminders." }] };
    }

    const lines = reminders.map((r) => {
      const schedule = r.cron_expression ? `cron: ${r.cron_expression}` : "one-time";
      return `#${r.id} — ${r.content} (${schedule}, next: ${r.next_trigger_at}, channel: ${r.channel_id})`;
    });

    return { content: [{ type: "text", text: `Active reminders:\n${lines.join("\n")}` }] };
  }
);

server.registerTool(
  "claude_bot_delete_reminder",
  {
    description: "Deactivate/delete a reminder by its ID.",
    inputSchema: {
      reminder_id: z.number().describe("The reminder ID to deactivate"),
    },
  },
  async ({ reminder_id }) => {
    deactivateReminder(reminder_id);
    return { content: [{ type: "text", text: `Reminder #${reminder_id} deactivated.` }] };
  }
);

// ── Teaching tools ──────────────────────────────────────────

server.registerTool(
  "claude_bot_add_teaching",
  {
    description:
      "Add a team knowledge instruction. Teachings are injected into all future Claude sessions as system prompts, letting you customize bot behavior across the workspace.",
    inputSchema: {
      instruction: z.string().describe("The instruction/teaching to add"),
      added_by: z.string().optional().describe("Slack user ID (auto-detected from session context)"),
      workspace_id: z.string().optional().describe("Workspace ID (defaults to 'default')"),
    },
  },
  async ({ instruction, added_by, workspace_id }) => {
    const userId = added_by || DEFAULT_USER_ID;
    if (!userId) {
      return { content: [{ type: "text", text: "Error: Missing added_by and no session context available." }] };
    }
    addTeaching(instruction, userId, workspace_id || "default");
    const count = getTeachingCount(workspace_id || "default");
    return {
      content: [{ type: "text", text: `Teaching added. Total active teachings: ${count.count}` }],
    };
  }
);

server.registerTool(
  "claude_bot_list_teachings",
  {
    description: "List all active team knowledge instructions.",
    inputSchema: {
      workspace_id: z.string().optional().describe("Workspace ID (defaults to 'default')"),
    },
  },
  async ({ workspace_id }) => {
    const teachings = getTeachings(workspace_id || "default");
    if (teachings.length === 0) {
      return { content: [{ type: "text", text: "No active teachings." }] };
    }

    const lines = teachings.map(
      (t) => `#${t.id} — ${t.instruction} (by ${t.added_by}, ${t.created_at})`
    );
    return { content: [{ type: "text", text: `Active teachings:\n${lines.join("\n")}` }] };
  }
);

server.registerTool(
  "claude_bot_remove_teaching",
  {
    description: "Remove a team knowledge instruction by its ID.",
    inputSchema: {
      teaching_id: z.number().describe("The teaching ID to remove"),
    },
  },
  async ({ teaching_id }) => {
    removeTeaching(teaching_id);
    return { content: [{ type: "text", text: `Teaching #${teaching_id} removed.` }] };
  }
);

// ── Channel default CWD tools ───────────────────────────────

server.registerTool(
  "claude_bot_get_channel_cwd",
  {
    description: "Get the default working directory for a Slack channel.",
    inputSchema: {
      channel_id: z.string().optional().describe("Slack channel ID (auto-detected from session context)"),
    },
  },
  async (params) => {
    const channel_id = params.channel_id || DEFAULT_CHANNEL_ID;
    if (!channel_id) {
      return { content: [{ type: "text", text: "Error: Missing channel_id and no session context available." }] };
    }
    const result = getChannelDefault(channel_id);
    if (!result) {
      return { content: [{ type: "text", text: `No default CWD set for channel ${channel_id}.` }] };
    }
    return {
      content: [
        {
          type: "text",
          text: `Channel ${channel_id} default CWD: ${result.cwd} (set by ${result.set_by}, updated ${result.updated_at})`,
        },
      ],
    };
  }
);

server.registerTool(
  "claude_bot_set_channel_cwd",
  {
    description: "Set the default working directory for a Slack channel.",
    inputSchema: {
      channel_id: z.string().optional().describe("Slack channel ID (auto-detected from session context)"),
      cwd: z.string().describe("Absolute path to set as the default working directory"),
      set_by: z.string().optional().describe("Slack user ID (auto-detected from session context)"),
    },
  },
  async ({ channel_id, cwd, set_by }) => {
    const resolvedChannel = channel_id || DEFAULT_CHANNEL_ID;
    const resolvedUser = set_by || DEFAULT_USER_ID;
    if (!resolvedChannel) {
      return { content: [{ type: "text", text: "Error: Missing channel_id and no session context available." }] };
    }
    setChannelDefault(resolvedChannel, cwd, resolvedUser);
    return { content: [{ type: "text", text: `Channel ${resolvedChannel} default CWD set to: ${cwd}` }] };
  }
);

// ── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("claude-slacker MCP server running on stdio");
}

main().catch((err) => {
  console.error("MCP server fatal error:", err);
  process.exit(1);
});
