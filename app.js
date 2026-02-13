require("dotenv").config();
const { App } = require("@slack/bolt");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const { getSession, upsertSession } = require("./db");

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

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Track active claude processes per channel
const activeProcesses = new Map();

app.message(async ({ message, client }) => {
  log(message.channel, `Incoming message event: user=${message.user} subtype=${message.subtype || "none"} bot_id=${message.bot_id || "none"} text="${message.text}"`);

  if (message.subtype || message.bot_id) {
    log(message.channel, `Skipping message: subtype=${message.subtype} bot_id=${message.bot_id}`);
    return;
  }

  const channelId = message.channel;
  const userText = message.text;

  // If already processing in this channel, let the user know
  if (activeProcesses.has(channelId)) {
    const existing = activeProcesses.get(channelId);
    log(channelId, `Rejecting message — already processing (active pid=${existing.pid})`);
    await client.chat.postMessage({
      channel: channelId,
      text: "Still processing the previous message...",
    });
    return;
  }

  // Look up or create session
  const session = getSession(channelId);
  let sessionId;
  let isResume = false;

  if (session) {
    sessionId = session.session_id;
    isResume = true;
    log(channelId, `Found existing session: ${sessionId} (created=${session.created_at}, updated=${session.updated_at})`);
  } else {
    sessionId = randomUUID();
    upsertSession(channelId, sessionId);
    log(channelId, `Created new session: ${sessionId}`);
  }

  // Post initial placeholder message
  log(channelId, `Posting placeholder "Thinking..." message in thread=${message.ts}`);
  const initialMsg = await client.chat.postMessage({
    channel: channelId,
    thread_ts: message.ts,
    text: "Thinking...",
  });
  const messageTs = initialMsg.ts;
  log(channelId, `Placeholder posted: ts=${messageTs}`);

  // Build claude args
  const args = [
    "-p", userText,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
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

  const proc = spawn(CLAUDE_PATH, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.end(); // close stdin so claude doesn't block waiting for input
  activeProcesses.set(channelId, proc);

  let accumulatedText = "";
  let lastUpdateTime = 0;
  let updateCount = 0;
  let deltaCount = 0;
  let buffer = "";
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
            upsertSession(channelId, data.session_id);
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

            // Throttle Slack updates
            const now = Date.now();
            if (now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
              lastUpdateTime = now;
              updateCount++;
              log(channelId, `chat.update #${updateCount}: ${accumulatedText.length} chars, elapsed=${now - startTime}ms`);
              client.chat
                .update({ channel: channelId, ts: messageTs, text: accumulatedText })
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
    activeProcesses.delete(channelId);
  });

  proc.on("close", async (code, signal) => {
    activeProcesses.delete(channelId);
    const elapsed = Date.now() - startTime;

    log(channelId, `Claude process exited: code=${code} signal=${signal} pid=${proc.pid} elapsed=${elapsed}ms`);
    log(channelId, `Final stats: deltas=${deltaCount}, slack_updates=${updateCount}, text_length=${accumulatedText.length}`);

    const finalText =
      accumulatedText || (code !== 0 ? "Something went wrong." : "No response.");

    log(channelId, `Sending final chat.update (${finalText.length} chars)`);
    await client.chat
      .update({ channel: channelId, ts: messageTs, text: finalText })
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
