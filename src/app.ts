#!/usr/bin/env bun

import path from "path";
import fs from "fs";
import os from "os";
import dotenv from "dotenv";

// --- Environment loading (precedence: real env > --env-file > ~/.compass/.env > local .env) ---
// Snapshot real env vars so we can restore them after file-based loading
const realEnv = { ...process.env };

// 1. Local .env (lowest priority)
dotenv.config();

// 2. Home-dir config (overrides local .env)
const homeEnv = path.join(os.homedir(), ".compass", ".env");
if (fs.existsSync(homeEnv)) {
  dotenv.config({ path: homeEnv, override: true });
}

// 3. --env-file flag (overrides home-dir)
const envFileIdx = process.argv.indexOf("--env-file");
if (envFileIdx !== -1 && process.argv[envFileIdx + 1]) {
  const custom = path.resolve(process.argv[envFileIdx + 1]);
  if (!fs.existsSync(custom)) {
    console.error(`Error: env file not found: ${custom}`);
    process.exit(1);
  }
  dotenv.config({ path: custom, override: true });
}

// 4. Restore real env vars (always highest priority)
Object.assign(process.env, realEnv);
// -----------------------------------------------------------------------------------------

import { App } from "@slack/bolt";
import { execFileSync } from "child_process";
import {
  getSession, upsertSession, setCwd, getCwdHistory, addCwdHistory,
  getChannelDefault, setChannelDefault,
  addTeaching, getTeachings, removeTeaching,
  getStaleWorktrees, getActiveWorktrees, markWorktreeCleaned,
  addFeedback, getWorktree, touchWorktree, upsertWorktree,
  getDueReminders, updateNextTrigger, deactivateReminder,
} from "./db.ts";
import { randomUUID } from "crypto";
import { CronExpressionParser } from "cron-parser";
import { removeWorktree, hasUncommittedChanges, detectGitRepo, createWorktree, copyEnvFiles } from "./lib/worktree.ts";
import { buildHomeBlocks } from "./ui/blocks.ts";
import { createAssistant } from "./handlers/assistant.ts";
import { handleClaudeStream } from "./handlers/stream.ts";
import { log, logErr, toSqliteDatetime } from "./lib/log.ts";
import type { ActiveProcessMap, Ref } from "./types.ts";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Track active claude processes per thread
const activeProcesses: ActiveProcessMap = new Map();

// Shared refs so assistant.js can read the cached team_id
const cachedTeamIdRef: Ref<string | null> = { value: null };
const cachedBotUserIdRef: Ref<string | null> = { value: null };

// ── Register Assistant ──────────────────────────────────────

const assistant = createAssistant(activeProcesses, cachedTeamIdRef, cachedBotUserIdRef);
app.assistant(assistant);

// ── Feedback action handler ─────────────────────────────────

app.action("response_feedback", async ({ action, ack, body }: any) => {
  await ack();
  const [sentiment, sessionKey] = action.value.split(":");
  const userId = body.user?.id;
  const messageTs = body.message?.ts;
  log(null, `Feedback: sentiment=${sentiment} session=${sessionKey} user=${userId} ts=${messageTs}`);
  try {
    addFeedback(sessionKey, userId, sentiment, messageTs);
  } catch (err: any) {
    logErr(null, `Failed to log feedback: ${err.message}`);
  }
});

// ── Stop button ─────────────────────────────────────────────

app.action("stop_claude", async ({ action, ack, body }: any) => {
  await ack();
  const threadKey = action.value;
  log(threadKey, `Stop button pressed by user=${body.user?.id}`);

  const proc = activeProcesses.get(threadKey);
  if (proc) {
    log(threadKey, `Killing claude process pid=${proc.pid}`);
    proc.kill("SIGTERM");
  } else {
    log(threadKey, `No active process to stop`);
  }
});

// ── $cwd action handlers ────────────────────────────────────

app.action("cwd_pick", async ({ action, ack, client, body }: any) => {
  await ack();
  const channelId = body.channel?.id || body.container?.channel_id;
  const { path: chosenPath, threadTs, isTopLevel } = JSON.parse(action.selected_option.value);

  const sessionKey = threadTs || channelId;
  if (!getSession(sessionKey)) {
    upsertSession(sessionKey, "pending");
  }
  setCwd(sessionKey, chosenPath);
  addCwdHistory(chosenPath);
  // Reset session so next message starts fresh (can't --resume in a different CWD)
  upsertSession(sessionKey, "pending");
  markWorktreeCleaned(sessionKey);
  if (isTopLevel) {
    setChannelDefault(channelId, chosenPath, body.user?.id);
    log(channelId, `Channel default CWD set via picker to: ${chosenPath} (session reset)`);
  } else {
    log(channelId, `CWD set via picker to: ${chosenPath} (thread=${threadTs}, session reset)`);
  }

  const confirmText = isTopLevel
    ? `Working directory set to \`${chosenPath}\` (default for this channel)`
    : `Working directory set to \`${chosenPath}\``;
  await client.chat.postEphemeral({
    channel: channelId,
    thread_ts: threadTs,
    user: body.user?.id,
    text: confirmText,
  });
});

app.action("cwd_add_new", async ({ action, ack, client, body }: any) => {
  await ack();
  const meta = JSON.parse(action.value);
  log(meta.channelId, `cwd_add_new: opening modal user=${body.user?.id} thread=${meta.threadTs}`);

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "cwd_modal",
      private_metadata: JSON.stringify(meta),
      title: { type: "plain_text", text: "Set Working Directory" },
      submit: { type: "plain_text", text: "Set" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "cwd_input_block",
          element: {
            type: "plain_text_input",
            action_id: "cwd_input",
            placeholder: { type: "plain_text", text: "/path/to/project" },
          },
          label: { type: "plain_text", text: "Directory path" },
        },
      ],
    },
  });
});

// ── /cwd slash command ──────────────────────────────────────

app.command("/cwd", async ({ command, ack, client }: any) => {
  await ack();
  const history = getCwdHistory();
  log(command.channel_id, `/cwd command invoked by user=${command.user_id}, history_count=${history.length}`);

  const blocks: any[] = [];

  if (history.length > 0) {
    blocks.push({
      type: "input",
      block_id: "cwd_select_block",
      optional: true,
      element: {
        type: "static_select",
        action_id: "cwd_select",
        placeholder: { type: "plain_text", text: "Choose a previous directory" },
        options: history.map((h) => ({
          text: { type: "plain_text", text: h.path },
          value: h.path,
        })),
      },
      label: { type: "plain_text", text: "Previous directories" },
    });
  }

  blocks.push({
    type: "input",
    block_id: "cwd_input_block",
    optional: true,
    element: {
      type: "plain_text_input",
      action_id: "cwd_input",
      placeholder: { type: "plain_text", text: "/path/to/project" },
    },
    label: { type: "plain_text", text: "Or enter a new path" },
  });

  await client.views.open({
    trigger_id: command.trigger_id,
    view: {
      type: "modal",
      callback_id: "cwd_modal",
      private_metadata: JSON.stringify({ channelId: command.channel_id, isTopLevel: true }),
      title: { type: "plain_text", text: "Set Working Directory" },
      submit: { type: "plain_text", text: "Set" },
      close: { type: "plain_text", text: "Cancel" },
      blocks,
    },
  });
});

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

// ── Modal submissions ───────────────────────────────────────

app.view("cwd_modal", async ({ view, ack, client }: any) => {
  const meta = JSON.parse(view.private_metadata);
  const { channelId, threadTs, isTopLevel } = meta;
  const values = view.state.values;

  const inputVal = values.cwd_input_block?.cwd_input?.value;
  const selectVal = values.cwd_select_block?.cwd_select?.selected_option?.value;
  const chosenPath = inputVal || selectVal;

  if (!chosenPath) {
    await ack({
      response_action: "errors",
      errors: {
        cwd_input_block: "Please enter a path or select one from the dropdown.",
      },
    });
    return;
  }

  await ack();

  addCwdHistory(chosenPath);
  if (isTopLevel) {
    setChannelDefault(channelId, chosenPath, view.user?.id);
    log(channelId, `Channel default CWD set to: ${chosenPath}`);
    // Also set thread session CWD if we're in a thread (top-level $cwd in channel)
    if (threadTs) {
      if (!getSession(threadTs)) upsertSession(threadTs, "pending");
      setCwd(threadTs, chosenPath);
      // Reset session so next message starts fresh
      upsertSession(threadTs, "pending");
      markWorktreeCleaned(threadTs);
    }
  } else {
    const sessionKey = threadTs || channelId;
    if (!getSession(sessionKey)) upsertSession(sessionKey, "pending");
    setCwd(sessionKey, chosenPath);
    // Reset session so next message starts fresh
    upsertSession(sessionKey, "pending");
    markWorktreeCleaned(sessionKey);
    log(channelId, `CWD set to: ${chosenPath} (thread=${threadTs}, session reset)`);
  }

  const confirmText = isTopLevel
    ? `Working directory set to \`${chosenPath}\` (default for this channel)`
    : `Working directory set to \`${chosenPath}\``;
  await client.chat.postEphemeral({
    channel: channelId,
    thread_ts: threadTs,
    user: view.user?.id,
    text: confirmText,
  });
});

app.view("teaching_modal", async ({ view, ack, client, body }: any) => {
  log(null, `teaching_modal: submission by user=${body.user?.id}`);
  const instruction = view.state.values.teaching_input_block.teaching_input.value;
  if (!instruction?.trim()) {
    log(null, `teaching_modal: rejected empty instruction`);
    await ack({
      response_action: "errors",
      errors: { teaching_input_block: "Please enter an instruction." },
    });
    return;
  }
  await ack();
  addTeaching(instruction.trim(), body.user.id);
  log(null, `Teaching added via Home: "${instruction.trim()}" by user=${body.user.id}`);

  try {
    await client.views.publish({
      user_id: body.user.id,
      view: { type: "home", blocks: buildHomeBlocks(activeProcesses) },
    });
  } catch (err: any) {
    logErr(null, `Failed to refresh Home after teaching add: ${err.message}`);
  }
});

// ── App Home dashboard ──────────────────────────────────────

app.event("app_home_opened", async ({ event, client }: any) => {
  if (event.tab !== "home") return;
  log(null, `App Home opened by user=${event.user}`);

  try {
    await client.views.publish({
      user_id: event.user,
      view: { type: "home", blocks: buildHomeBlocks(activeProcesses) },
    });
  } catch (err: any) {
    logErr(null, `Failed to publish App Home: ${err.message}`);
  }
});

app.action("home_view_teachings", async ({ ack, client, body }: any) => {
  await ack();
  log(null, `Home: "View Teachings" clicked by user=${body.user?.id}`);
  const teachings = getTeachings("default");
  log(null, `Home: fetched ${teachings.length} teachings for modal`);
  const blocks = teachings.length > 0
    ? teachings.map((t) => ({
        type: "section",
        text: { type: "mrkdwn", text: `*#${t.id}* \u2014 ${t.instruction}\n_Added by <@${t.added_by}> on ${t.created_at}_` },
      }))
    : [{ type: "section", text: { type: "mrkdwn", text: "No teachings yet." } }];

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      title: { type: "plain_text", text: "Team Teachings" },
      close: { type: "plain_text", text: "Close" },
      blocks,
    },
  });
});

app.action("home_add_teaching", async ({ ack, client, body }: any) => {
  await ack();
  log(null, `Home: "Add Teaching" clicked by user=${body.user?.id}`);
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "teaching_modal",
      title: { type: "plain_text", text: "Add Teaching" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "teaching_input_block",
          element: {
            type: "plain_text_input",
            action_id: "teaching_input",
            multiline: true,
            placeholder: { type: "plain_text", text: "e.g., Use TypeScript for all new files" },
          },
          label: { type: "plain_text", text: "Team convention or instruction" },
        },
      ],
    },
  });
});

// ── Channel @mention handler ────────────────────────────────

const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

app.event("app_mention", async ({ event, client }: any) => {
  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userId = event.user;
  const rawText = event.text || "";
  // Strip the bot mention from text: "<@U12345> hello" -> "hello"
  const userText = rawText.replace(/<@[A-Za-z0-9]+>/g, "").trim();

  log(channelId, `app_mention: user=${userId} ts=${event.ts} thread_ts=${threadTs} raw="${rawText}" text="${userText}"`);

  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(userId) && userId !== cachedBotUserIdRef.value) {
    log(channelId, `Blocked unauthorized user=${userId}`);
    return;
  }

  // ── $cwd command ──────────────────────────────────────────
  if (userText.match(/^\$cwd(\s|$)/i)) {
    const pathArg = userText.replace(/^\$cwd\s*/i, "").trim();
    const isTopLevel = !event.thread_ts;
    log(channelId, `$cwd command: pathArg="${pathArg}" isTopLevel=${isTopLevel}`);
    if (pathArg) {
      if (!getSession(threadTs)) upsertSession(threadTs, "pending");
      setCwd(threadTs, pathArg);
      addCwdHistory(pathArg);
      // Reset session so next message starts fresh (can't --resume in a different CWD)
      upsertSession(threadTs, "pending");
      markWorktreeCleaned(threadTs);
      if (isTopLevel) {
        setChannelDefault(channelId, pathArg, userId);
        log(channelId, `Channel default CWD set to: ${pathArg} (session reset)`);
      } else {
        log(channelId, `Thread CWD set to: ${pathArg} (session reset)`);
      }
      const confirmText = isTopLevel
        ? `Working directory set to \`${pathArg}\` (default for this channel)`
        : `Working directory set to \`${pathArg}\``;
      try {
        await client.chat.postEphemeral({ channel: channelId, thread_ts: threadTs, user: userId, text: confirmText });
      } catch (err: any) {
        logErr(channelId, `$cwd set reply failed: ${err.message}`);
      }
    } else {
      // Bare $cwd — show interactive directory picker
      const history = getCwdHistory();
      log(channelId, `$cwd picker requested, history_count=${history.length}`);

      const pickerBlocks: any[] = [
        { type: "header", text: { type: "plain_text", text: "Set Working Directory" } },
        { type: "divider" },
      ];

      if (history.length > 0) {
        pickerBlocks.push(
          { type: "section", text: { type: "mrkdwn", text: "*Recent directories:*" } },
          {
            type: "actions",
            block_id: "cwd_picker_block",
            elements: [{
              type: "static_select",
              action_id: "cwd_pick",
              placeholder: { type: "plain_text", text: "Choose a directory..." },
              options: history.map((h) => ({
                text: { type: "plain_text", text: h.path },
                value: JSON.stringify({ path: h.path, threadTs, isTopLevel }),
              })),
            }],
          },
          { type: "divider" },
        );
      }

      pickerBlocks.push(
        {
          type: "section",
          text: { type: "mrkdwn", text: "Enter a new path:" },
          accessory: {
            type: "button",
            action_id: "cwd_add_new",
            text: { type: "plain_text", text: "Add new..." },
            style: "primary",
            value: JSON.stringify({ channelId, threadTs, isTopLevel }),
          },
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: "Or send `$cwd /path/to/dir` to set directly" },
          ],
        },
      );

      try {
        await client.chat.postEphemeral({
          channel: channelId,
          thread_ts: threadTs,
          user: userId,
          blocks: pickerBlocks,
          text: "Set working directory",
        });
        log(channelId, `$cwd picker sent (ephemeral to user=${userId})`);
      } catch (err: any) {
        logErr(channelId, `$cwd picker reply failed: ${err.message}`);
      }
    }
    return;
  }

  // ── $teach command ────────────────────────────────────────
  if (userText.match(/^\$teach(\s|$)/i)) {
    const teachArg = userText.replace(/^\$teach\s*/i, "").trim();
    log(channelId, `$teach command: arg="${teachArg}"`);
    try {
      if (!teachArg || teachArg === "help") {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "`$teach <instruction>` — add\n`$teach list` — view all\n`$teach remove <id>` — remove" });
        return;
      }
      if (teachArg === "list") {
        const teachings = getTeachings("default");
        const text = teachings.length > 0
          ? teachings.map((t) => `#${t.id} — ${t.instruction}`).join("\n")
          : "No teachings yet.";
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
        return;
      }
      const removeMatch = teachArg.match(/^remove\s+(\d+)$/i);
      if (removeMatch) {
        removeTeaching(parseInt(removeMatch[1], 10));
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `Teaching #${removeMatch[1]} removed.` });
        return;
      }
      const instruction = teachArg.replace(/^["']|["']$/g, "");
      addTeaching(instruction, userId);
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `Learned: _${instruction}_` });
    } catch (err: any) {
      logErr(channelId, `$teach reply failed: ${err.message}`);
    }
    return;
  }

  await processMessage({ channelId, threadTs, userText, userId, client });
});

interface ProcessMessageOpts {
  channelId: string;
  threadTs: string;
  userText: string;
  userId: string;
  client: any;
}

/**
 * Core message processing: session lookup, CWD gate, worktree setup, Claude spawn.
 * Called from app_mention handler and reminder polling loop.
 */
async function processMessage({ channelId, threadTs, userText, userId, client }: ProcessMessageOpts): Promise<void> {
  // ── Guard: already processing ─────────────────────────────
  if (activeProcesses.has(threadTs)) {
    log(channelId, `Rejecting — already processing`);
    try {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "Still processing the previous message..." });
    } catch (err: any) {
      logErr(channelId, `Busy reply failed: ${err.message}`);
    }
    return;
  }

  if (!userText) {
    log(channelId, `Empty mention, ignoring`);
    return;
  }

  // ── Session lookup ────────────────────────────────────────
  const session = getSession(threadTs);
  let sessionId: string;
  let isResume = false;
  if (session && session.session_id && session.session_id !== "pending") {
    sessionId = session.session_id;
    isResume = true;
    log(channelId, `Resuming session: ${sessionId}`);
  } else {
    sessionId = randomUUID();
    if (!session) upsertSession(threadTs, "pending");
    log(channelId, `New session: ${sessionId}`);
  }

  // ── CWD gate (thread CWD → channel default → block) ─────
  const currentSession = getSession(threadTs);
  let effectiveCwd = currentSession?.cwd;

  if (!effectiveCwd) {
    const channelDefault = getChannelDefault(channelId);
    if (channelDefault?.cwd) {
      effectiveCwd = channelDefault.cwd;
      // Inherit: write channel default into this thread's session
      if (!currentSession) upsertSession(threadTs, "pending");
      setCwd(threadTs, effectiveCwd);
      log(channelId, `Inherited channel default CWD: ${effectiveCwd}`);
    }
  }

  if (!effectiveCwd) {
    log(channelId, `No CWD set, blocking`);
    try {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "No working directory set. Send `$cwd /path/to/dir` to set one." });
    } catch (err: any) {
      logErr(channelId, `CWD gate reply failed: ${err.message}`);
    }
    return;
  }

  // ── Worktree setup ────────────────────────────────────────
  let spawnCwd = effectiveCwd;
  const existingWt = getWorktree(threadTs);
  if (existingWt && !existingWt.cleaned_up) {
    spawnCwd = existingWt.worktree_path;
    touchWorktree(threadTs);
    log(channelId, `Reusing worktree: ${spawnCwd}`);
  } else {
    const gitInfo = detectGitRepo(effectiveCwd);
    log(channelId, `Git detection: cwd=${effectiveCwd} isGit=${gitInfo.isGit}`);
    if (gitInfo.isGit) {
      try {
        const { worktreePath, branchName } = createWorktree(gitInfo.repoRoot!, threadTs);
        copyEnvFiles(effectiveCwd, worktreePath);
        upsertWorktree(threadTs, gitInfo.repoRoot!, worktreePath, branchName);
        spawnCwd = worktreePath;
        log(channelId, `Created worktree: ${worktreePath}`);
      } catch (err: any) {
        logErr(channelId, `Worktree creation failed: ${err.message}`);
      }
    }
  }

  // ── Delegate to stream handler (no-op setStatus for channels) ─
  await handleClaudeStream({
    channelId, threadTs, userText, userId, client,
    spawnCwd, isResume, sessionId,
    setStatus: async () => {},
    activeProcesses,
    cachedTeamId: cachedTeamIdRef.value,
    botUserId: cachedBotUserIdRef.value,
  });
}

// ── Startup ─────────────────────────────────────────────────

(async () => {
  // Validate CLAUDE_PATH exists before starting
  const claudePath = process.env.CLAUDE_PATH || "claude";
  // Check if it's an absolute path that exists, or resolve via Bun.which
  if (path.isAbsolute(claudePath)) {
    if (!fs.existsSync(claudePath)) {
      console.error(`ERROR: CLAUDE_PATH not found: ${claudePath}`);
      process.exit(1);
    }
  } else if (!Bun.which(claudePath)) {
    console.error(`ERROR: CLAUDE_PATH "${claudePath}" not found in PATH. Set CLAUDE_PATH in .env to the full path of the claude binary.`);
    process.exit(1);
  }
  log(null, `Claude CLI found: ${claudePath}`);

  // Register MCP server (idempotent — overwrites if already exists)
  try {
    const mcpServerPath = path.join(import.meta.dir, "mcp", "server.ts");
    const mcpEnv: Record<string, string | undefined> = { ...process.env };
    delete mcpEnv.CLAUDECODE; // avoid nested-session check
    execFileSync(claudePath, [
      "mcp", "add",
      "--transport", "stdio",
      "--scope", "user",
      "compass",
      "--",
      "bun", mcpServerPath,
    ], { encoding: "utf-8", timeout: 10000, env: mcpEnv as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    log(null, `MCP server registered: compass -> ${mcpServerPath}`);
  } catch (err: any) {
    logErr(null, `Failed to register MCP server (non-fatal): ${err.message}`);
  }

  log(null, `Starting Slack bot...`);

  // Cache team ID and bot user ID
  try {
    const authResult = await app.client.auth.test();
    cachedTeamIdRef.value = authResult.team_id ?? null;
    cachedBotUserIdRef.value = authResult.user_id ?? null;
    log(null, `Cached team_id: ${cachedTeamIdRef.value}, bot_user_id: ${cachedBotUserIdRef.value}`);
  } catch (err: any) {
    logErr(null, `Failed to cache team_id/bot_user_id: ${err.message}`);
  }

  await app.start();

  console.log(`
   _____
  / ____|
 | |     ___  _ __ ___  _ __   __ _ ___ ___
 | |    / _ \\| '_ \` _ \\| '_ \\ / _\` / __/ __|
 | |___| (_) | | | | | | |_) | (_| \\__ \\__ \\
  \\_____\\___/|_| |_| |_| .__/ \\__,_|___/___/
                        | |
                        |_|
`);

  log(null, `Slack bot is running in Socket Mode`);

  // Worktree cleanup: every hour, remove worktrees idle >24h
  setInterval(() => {
    try {
      const stale = getStaleWorktrees(1440);
      log(null, `Worktree cleanup: found ${stale.length} stale worktree(s) (idle >24h)`);
      for (const wt of stale) {
        if (activeProcesses.has(wt.session_key)) continue;
        if (hasUncommittedChanges(wt.worktree_path)) {
          log(null, `Skipping stale worktree with uncommitted changes: ${wt.worktree_path}`);
          continue;
        }
        try {
          removeWorktree(wt.repo_path, wt.worktree_path, wt.branch_name);
          markWorktreeCleaned(wt.session_key);
          log(null, `Cleaned stale worktree: ${wt.worktree_path}`);
        } catch (err: any) {
          logErr(null, `Failed to clean worktree ${wt.worktree_path}: ${err.message}`);
        }
      }
    } catch (err: any) {
      logErr(null, `Worktree cleanup error: ${err.message}`);
    }
  }, 60 * 60 * 1000);

  // Reminder polling: fire due reminders
  async function pollReminders(): Promise<void> {
    try {
      const due = getDueReminders();
      if (due.length === 0) return;
      log(null, `Reminder poll: ${due.length} due reminder(s)`);

      for (const reminder of due) {
        try {
          // Post the reminder message in the channel
          const posted = await app.client.chat.postMessage({
            channel: reminder.channel_id,
            text: `<@${reminder.bot_id}> ${reminder.content}`,
          });
          log(null, `Reminder #${reminder.id} fired in channel=${reminder.channel_id}: "${reminder.content}"`);

          // Directly process the message (self-mentions don't trigger app_mention)
          const threadTs = posted.ts!;
          await processMessage({
            channelId: reminder.channel_id,
            threadTs,
            userText: reminder.content,
            userId: reminder.user_id,
            client: app.client,
          });

          if (reminder.one_time) {
            deactivateReminder(reminder.id);
            log(null, `Reminder #${reminder.id} deactivated (one-time)`);
          } else {
            try {
              const interval = CronExpressionParser.parse(reminder.cron_expression!);
              const nextTrigger = toSqliteDatetime(interval.next().toDate());
              updateNextTrigger(nextTrigger, reminder.id);
              log(null, `Reminder #${reminder.id} next trigger: ${nextTrigger}`);
            } catch (err: any) {
              logErr(null, `Failed to compute next trigger for reminder #${reminder.id}: ${err.message}`);
              deactivateReminder(reminder.id);
            }
          }
        } catch (err: any) {
          logErr(null, `Failed to fire reminder #${reminder.id}: ${err.message}`);
        }
      }
    } catch (err: any) {
      logErr(null, `Reminder poll error: ${err.message}`);
    }
  }

  // Fire any missed reminders immediately, then poll every 60s
  pollReminders();
  setInterval(pollReminders, 60 * 1000);
})();
