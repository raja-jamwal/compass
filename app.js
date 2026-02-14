require("dotenv").config();
const { App } = require("@slack/bolt");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { getSession, upsertSession, setCwd, getCwdHistory, addCwdHistory } = require("./db");

const CLAUDE_PATH = "/Users/dev/.local/bin/claude";
const UPDATE_INTERVAL_MS = 750;

function ts() {
  return new Date().toISOString();
}

function log(channel, ...args) {
  console.log(`${ts()} [${channel || "system"}]`, ...args);
}

function logErr(channel, ...args) {
  console.error(`${ts()} [${channel || "system"}]`, ...args);
}

// Build blocks with text and an optional Stop button
function buildBlocks(text, threadKey, showStop) {
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: text || " " } },
  ];
  if (showStop) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Stop" },
          style: "danger",
          action_id: "stop_claude",
          value: threadKey,
        },
      ],
    });
  }
  return blocks;
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Track active claude processes per channel
const activeProcesses = new Map();

// Handle Stop button click
app.action("stop_claude", async ({ action, ack, client, body }) => {
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

// Handle directory selection from $cwd picker
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

// Handle "Add new" button from $cwd picker — opens modal
app.action("cwd_add_new", async ({ action, ack, client, body }) => {
  await ack();
  // value contains JSON with channelId and threadTs
  const meta = JSON.parse(action.value);

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

// /cwd slash command — opens modal to set working directory
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

// Handle CWD modal submission
app.view("cwd_modal", async ({ view, ack, client }) => {
  const meta = JSON.parse(view.private_metadata);
  const { channelId, threadTs } = meta;
  const values = view.state.values;

  const inputVal = values.cwd_input_block?.cwd_input?.value;
  const selectVal = values.cwd_select_block?.cwd_select?.selected_option?.value;

  // Text input takes priority if filled
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

app.message(async ({ message, client }) => {
  log(message.channel, `Incoming message event: user=${message.user} subtype=${message.subtype || "none"} bot_id=${message.bot_id || "none"} ts=${message.ts} thread_ts=${message.thread_ts} text="${message.text}"`);

  if (message.subtype || message.bot_id) {
    log(message.channel, `Skipping message: subtype=${message.subtype} bot_id=${message.bot_id}`);
    return;
  }

  const channelId = message.channel;
  const threadTs = message.thread_ts || message.ts;
  const userText = message.text;

  // Handle $cwd command
  if (userText?.match(/^\$cwd(\s|$)/i)) {
    const pathArg = userText.replace(/^\$cwd\s*/i, "").trim();

    // $cwd /path/to/dir — set directly
    if (pathArg) {
      if (!getSession(threadTs)) {
        upsertSession(threadTs, "pending");
      }
      setCwd(threadTs, pathArg);
      addCwdHistory(pathArg);
      log(channelId, `CWD set via $cwd to: ${pathArg}`);
      try {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Working directory set to \`${pathArg}\``,
        });
        log(channelId, `CWD confirmation message sent`);
      } catch (err) {
        logErr(channelId, `Failed to send CWD confirmation: ${err.message}`);
      }
      return;
    }

    // Bare $cwd — show interactive directory picker
    const history = getCwdHistory();
    log(channelId, `$cwd picker requested, history_count=${history.length}`);

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "Set Working Directory" },
      },
      { type: "divider" },
    ];

    if (history.length > 0) {
      blocks.push(
        {
          type: "section",
          text: { type: "mrkdwn", text: "*Recent directories:*" },
        },
        {
          type: "actions",
          block_id: "cwd_picker_block",
          elements: [
            {
              type: "static_select",
              action_id: "cwd_pick",
              placeholder: { type: "plain_text", text: "Choose a directory..." },
              options: history.map((h) => ({
                text: { type: "plain_text", text: h.path },
                value: h.path,
              })),
            },
          ],
        },
        { type: "divider" },
      );
    }

    blocks.push(
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
      const resp = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        blocks,
        text: "Set working directory",
      });
      log(channelId, `$cwd picker message sent: ok=${resp.ok} ts=${resp.ts}`);
    } catch (err) {
      logErr(channelId, `Failed to send $cwd picker: ${err.message}`);
    }
    return;
  }

  // If already processing in this thread, let the user know
  if (activeProcesses.has(threadTs)) {
    const existing = activeProcesses.get(threadTs);
    log(channelId, `Rejecting message — already processing (active pid=${existing.pid})`);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "Still processing the previous message...",
    });
    return;
  }

  // Look up or create session (keyed by thread)
  // Session ID is only considered valid if set by Claude's system.init event.
  // Until then it stays "pending" — we never resume a "pending" session.
  const session = getSession(threadTs);
  let sessionId;
  let isResume = false;

  if (session && session.session_id && session.session_id !== "pending") {
    sessionId = session.session_id;
    isResume = true;
    log(channelId, `Resuming session: ${sessionId} thread=${threadTs}`);
  } else {
    sessionId = randomUUID();
    // Don't store this UUID — keep DB as "pending" until Claude confirms via system.init
    if (!session) {
      upsertSession(threadTs, "pending");
    }
    log(channelId, `New session: ${sessionId} thread=${threadTs}`);
  }

  // Check if CWD is set — require it before spawning Claude
  const currentSession = getSession(threadTs);
  if (!currentSession?.cwd) {
    log(channelId, `No CWD set, blocking message`);
    try {
      const resp = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "No working directory set. Send `$cwd` to pick one, or `$cwd /path/to/dir` to set directly.",
      });
      log(channelId, `CWD gating message sent: ok=${resp.ok} ts=${resp.ts}`);
    } catch (err) {
      logErr(channelId, `Failed to send CWD gating message: ${err.message}`);
    }
    return;
  }

  // Post initial placeholder message with Stop button
  log(channelId, `Posting placeholder "Thinking..." message in thread=${message.ts}`);
  const initialMsg = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "Thinking...",
    blocks: buildBlocks("Thinking...", threadTs, true),
  });
  const messageTs = initialMsg.ts;
  log(channelId, `Placeholder posted: ts=${messageTs}`);

  // Build claude args
  const args = [
    "-p", userText,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions"
  ];

  if (isResume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  log(channelId, `Spawning claude: ${CLAUDE_PATH} ${args.join(" ")}`);

  // Spawn claude process — strip CLAUDECODE env to avoid nesting error
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = spawn(CLAUDE_PATH, args, { env, cwd: currentSession.cwd, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.end(); // close stdin so claude doesn't block waiting for input
  activeProcesses.set(threadTs, proc);

  let accumulatedText = "";
  let lastUpdateTime = 0;
  let updateCount = 0;
  let deltaCount = 0;
  let buffer = "";
  let stopped = false;
  const startTime = Date.now();

  log(channelId, `Claude process started: pid=${proc.pid}, session=${sessionId}, resume=${isResume}`);

  proc.stdout.on("data", (chunk) => {
    const raw = chunk.toString();
    buffer += raw;
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete last line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);

        // Log every event type we receive
        if (data.type === "system") {
          log(channelId, `stream: type=system subtype=${data.subtype} session_id=${data.session_id} model=${data.model || "n/a"}`);
          if (data.subtype === "init" && data.session_id) {
            const oldId = sessionId;
            sessionId = data.session_id;
            upsertSession(threadTs, data.session_id);
            log(channelId, `Session ID updated: ${oldId} -> ${data.session_id}`);
          }
        } else if (data.type === "stream_event") {
          const evt = data.event;
          if (evt?.type === "message_start") {
            log(channelId, `stream: message_start model=${evt.message?.model} id=${evt.message?.id}`);
          } else if (evt?.type === "content_block_start") {
            log(channelId, `stream: content_block_start index=${evt.index} type=${evt.content_block?.type}`);
          } else if (evt?.type === "content_block_delta" && evt?.delta?.type === "text_delta") {
            deltaCount++;
            accumulatedText += evt.delta.text;

            // Log every 10th delta to avoid spam, but always log first
            if (deltaCount === 1 || deltaCount % 10 === 0) {
              log(channelId, `stream: text_delta #${deltaCount}, accumulated length=${accumulatedText.length} chars`);
            }

            // Throttle Slack updates — include Stop button while streaming
            const now = Date.now();
            if (now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
              lastUpdateTime = now;
              updateCount++;
              log(channelId, `chat.update #${updateCount}: ${accumulatedText.length} chars, elapsed=${now - startTime}ms`);
              client.chat
                .update({
                  channel: channelId,
                  ts: messageTs,
                  text: accumulatedText,
                  blocks: buildBlocks(accumulatedText, threadTs, true),
                })
                .catch((err) => {
                  logErr(channelId, `chat.update failed: ${err.message}`);
                });
            }
          } else if (evt?.type === "content_block_stop") {
            log(channelId, `stream: content_block_stop index=${evt.index}`);
          } else if (evt?.type === "message_delta") {
            log(channelId, `stream: message_delta stop_reason=${evt.delta?.stop_reason}`);
          } else if (evt?.type === "message_stop") {
            log(channelId, `stream: message_stop`);
          } else {
            log(channelId, `stream: stream_event type=${evt?.type}`);
          }
        } else if (data.type === "assistant") {
          const content = data.message?.content;
          const textLen = content?.[0]?.text?.length || 0;
          log(channelId, `stream: assistant message, content_length=${textLen} chars`);
        } else if (data.type === "result") {
          const elapsed = Date.now() - startTime;
          log(channelId, `stream: result subtype=${data.subtype} is_error=${data.is_error} duration_ms=${data.duration_ms} api_ms=${data.duration_api_ms} turns=${data.num_turns} cost=$${data.total_cost_usd?.toFixed(4)} session=${data.session_id}`);
          log(channelId, `stream: total deltas=${deltaCount}, slack updates=${updateCount}, wall_time=${elapsed}ms`);
        } else {
          log(channelId, `stream: unknown type=${data.type}`);
        }
      } catch (err) {
        logErr(channelId, `Failed to parse stream line: ${err.message} — raw: ${line.substring(0, 200)}`);
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    logErr(channelId, `claude stderr: ${chunk.toString().trim()}`);
  });

  proc.on("error", (err) => {
    logErr(channelId, `claude process error: ${err.message}`);
    activeProcesses.delete(threadTs);
  });

  proc.on("close", async (code, signal) => {
    activeProcesses.delete(threadTs);
    stopped = signal === "SIGTERM";
    const elapsed = Date.now() - startTime;

    log(channelId, `Claude process exited: code=${code} signal=${signal} pid=${proc.pid} elapsed=${elapsed}ms stopped=${stopped}`);
    log(channelId, `Final stats: deltas=${deltaCount}, slack_updates=${updateCount}, text_length=${accumulatedText.length}`);

    let finalText;
    if (stopped) {
      finalText = accumulatedText
        ? accumulatedText + "\n\n_Stopped by user._"
        : "_Stopped by user._";
    } else {
      finalText = accumulatedText || (code !== 0 ? "Something went wrong." : "No response.");
    }

    // Final update — remove Stop button
    log(channelId, `Sending final chat.update (${finalText.length} chars, stop button removed)`);
    await client.chat
      .update({
        channel: channelId,
        ts: messageTs,
        text: finalText,
        blocks: buildBlocks(finalText, threadTs, false),
      })
      .catch((err) => {
        logErr(channelId, `Final chat.update failed: ${err.message}`);
      });

    log(channelId, `Done processing message from user=${message.user}`);
  });
});

(async () => {
  log(null, `Starting Slack bot...`);
  log(null, `Claude path: ${CLAUDE_PATH}`);
  log(null, `Update interval: ${UPDATE_INTERVAL_MS}ms`);
  await app.start();
  log(null, `Slack bot is running in Socket Mode`);
})();
