require("dotenv").config();
const { App } = require("@slack/bolt");
const {
  getSession, upsertSession, setCwd, getCwdHistory, addCwdHistory,
  addTeaching, getTeachings, removeTeaching,
  getStaleWorktrees, getActiveWorktrees, markWorktreeCleaned,
  addFeedback, getWorktree, touchWorktree, upsertWorktree,
} = require("./db");
const { randomUUID } = require("crypto");
const { removeWorktree, hasUncommittedChanges, detectGitRepo, createWorktree, copyEnvFiles } = require("./worktree");
const { buildHomeBlocks } = require("./blocks");
const { createAssistant } = require("./assistant");
const { handleClaudeStream } = require("./stream-handler");

function ts() {
  return new Date().toISOString();
}

function log(channel, ...args) {
  console.log(`${ts()} [${channel || "system"}]`, ...args);
}

function logErr(channel, ...args) {
  console.error(`${ts()} [${channel || "system"}]`, ...args);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Track active claude processes per thread
const activeProcesses = new Map();

// Shared ref so assistant.js can read the cached team_id
const cachedTeamIdRef = { value: null };

// ── Register Assistant ──────────────────────────────────────

const assistant = createAssistant(activeProcesses, cachedTeamIdRef);
app.assistant(assistant);

// ── Feedback action handler ─────────────────────────────────

app.action("response_feedback", async ({ action, ack, body }) => {
  await ack();
  const [sentiment, sessionKey] = action.value.split(":");
  const userId = body.user?.id;
  const messageTs = body.message?.ts;
  log(null, `Feedback: sentiment=${sentiment} session=${sessionKey} user=${userId} ts=${messageTs}`);
  try {
    addFeedback(sessionKey, userId, sentiment, messageTs);
  } catch (err) {
    logErr(null, `Failed to log feedback: ${err.message}`);
  }
});

// ── Stop button ─────────────────────────────────────────────

app.action("stop_claude", async ({ action, ack, body }) => {
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

app.action("cwd_pick", async ({ action, ack, client, body }) => {
  await ack();
  const channelId = body.channel?.id || body.container?.channel_id;
  const threadTs = body.message?.thread_ts || body.message?.ts;
  const chosenPath = action.selected_option.value;

  const sessionKey = threadTs || channelId;
  if (!getSession(sessionKey)) {
    upsertSession(sessionKey, "pending");
  }
  setCwd(sessionKey, chosenPath);
  addCwdHistory(chosenPath);
  log(channelId, `CWD set via picker to: ${chosenPath} (thread=${threadTs})`);

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `Working directory set to \`${chosenPath}\``,
  });
});

app.action("cwd_add_new", async ({ action, ack, client, body }) => {
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

app.command("/cwd", async ({ command, ack, client }) => {
  await ack();
  const history = getCwdHistory();
  log(command.channel_id, `/cwd command invoked by user=${command.user_id}, history_count=${history.length}`);

  const blocks = [];

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
      private_metadata: JSON.stringify({ channelId: command.channel_id }),
      title: { type: "plain_text", text: "Set Working Directory" },
      submit: { type: "plain_text", text: "Set" },
      close: { type: "plain_text", text: "Cancel" },
      blocks,
    },
  });
});

// ── Modal submissions ───────────────────────────────────────

app.view("cwd_modal", async ({ view, ack, client }) => {
  const meta = JSON.parse(view.private_metadata);
  const { channelId, threadTs } = meta;
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

  const sessionKey = threadTs || channelId;
  if (!getSession(sessionKey)) {
    upsertSession(sessionKey, "pending");
  }
  setCwd(sessionKey, chosenPath);
  addCwdHistory(chosenPath);
  log(channelId, `CWD set to: ${chosenPath} (thread=${threadTs})`);

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `Working directory set to \`${chosenPath}\``,
  });
});

app.view("teaching_modal", async ({ view, ack, client, body }) => {
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
  } catch (err) {
    logErr(null, `Failed to refresh Home after teaching add: ${err.message}`);
  }
});

// ── App Home dashboard ──────────────────────────────────────

app.event("app_home_opened", async ({ event, client }) => {
  if (event.tab !== "home") return;
  log(null, `App Home opened by user=${event.user}`);

  try {
    await client.views.publish({
      user_id: event.user,
      view: { type: "home", blocks: buildHomeBlocks(activeProcesses) },
    });
  } catch (err) {
    logErr(null, `Failed to publish App Home: ${err.message}`);
  }
});

app.action("home_view_teachings", async ({ ack, client, body }) => {
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

app.action("home_add_teaching", async ({ ack, client, body }) => {
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

app.event("app_mention", async ({ event, client }) => {
  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const userId = event.user;
  const rawText = event.text || "";
  // Strip the bot mention from text: "<@U12345> hello" -> "hello"
  const userText = rawText.replace(/<@[A-Za-z0-9]+>/g, "").trim();

  log(channelId, `app_mention: user=${userId} ts=${event.ts} thread_ts=${threadTs} raw="${rawText}" text="${userText}"`);

  if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(userId)) {
    log(channelId, `Blocked unauthorized user=${userId}`);
    return;
  }

  // ── $cwd command ──────────────────────────────────────────
  if (userText.match(/^\$cwd(\s|$)/i)) {
    const pathArg = userText.replace(/^\$cwd\s*/i, "").trim();
    log(channelId, `$cwd command: pathArg="${pathArg}"`);
    if (pathArg) {
      if (!getSession(threadTs)) upsertSession(threadTs, "pending");
      setCwd(threadTs, pathArg);
      addCwdHistory(pathArg);
      log(channelId, `CWD set via $cwd to: ${pathArg}`);
      try {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `Working directory set to \`${pathArg}\`` });
      } catch (err) {
        logErr(channelId, `$cwd set reply failed: ${err.message}`);
      }
    } else {
      // Bare $cwd — show interactive directory picker
      const history = getCwdHistory();
      log(channelId, `$cwd picker requested, history_count=${history.length}`);

      const pickerBlocks = [
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
                value: h.path,
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
            value: JSON.stringify({ channelId, threadTs }),
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
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          blocks: pickerBlocks,
          text: "Set working directory",
        });
        log(channelId, `$cwd picker sent`);
      } catch (err) {
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
    } catch (err) {
      logErr(channelId, `$teach reply failed: ${err.message}`);
    }
    return;
  }

  // ── Guard: already processing ─────────────────────────────
  if (activeProcesses.has(threadTs)) {
    log(channelId, `Rejecting — already processing`);
    try {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "Still processing the previous message..." });
    } catch (err) {
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
  let sessionId;
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

  // ── CWD gate ──────────────────────────────────────────────
  const currentSession = getSession(threadTs);
  if (!currentSession?.cwd) {
    log(channelId, `No CWD set, blocking`);
    try {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "No working directory set. Send `$cwd /path/to/dir` to set one." });
    } catch (err) {
      logErr(channelId, `CWD gate reply failed: ${err.message}`);
    }
    return;
  }

  // ── Worktree setup ────────────────────────────────────────
  let spawnCwd = currentSession.cwd;
  const existingWt = getWorktree(threadTs);
  if (existingWt && !existingWt.cleaned_up) {
    spawnCwd = existingWt.worktree_path;
    touchWorktree(threadTs);
    log(channelId, `Reusing worktree: ${spawnCwd}`);
  } else {
    const gitInfo = detectGitRepo(currentSession.cwd);
    log(channelId, `Git detection: cwd=${currentSession.cwd} isGit=${gitInfo.isGit}`);
    if (gitInfo.isGit) {
      try {
        const { worktreePath, branchName } = createWorktree(gitInfo.repoRoot, threadTs);
        copyEnvFiles(currentSession.cwd, worktreePath);
        upsertWorktree(threadTs, gitInfo.repoRoot, worktreePath, branchName);
        spawnCwd = worktreePath;
        log(channelId, `Created worktree: ${worktreePath}`);
      } catch (err) {
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
  });
});

// ── Startup ─────────────────────────────────────────────────

(async () => {
  log(null, `Starting Slack bot...`);

  // Cache team ID for chatStream
  try {
    const authResult = await app.client.auth.test();
    cachedTeamIdRef.value = authResult.team_id;
    log(null, `Cached team_id: ${cachedTeamIdRef.value}`);
  } catch (err) {
    logErr(null, `Failed to cache team_id (streaming will use fallback): ${err.message}`);
  }

  await app.start();
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
        } catch (err) {
          logErr(null, `Failed to clean worktree ${wt.worktree_path}: ${err.message}`);
        }
      }
    } catch (err) {
      logErr(null, `Worktree cleanup error: ${err.message}`);
    }
  }, 60 * 60 * 1000);
})();
