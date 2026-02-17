/**
 * Claude CLI streaming handler with agentic task visualization.
 *
 * Spawns the Claude CLI, parses NDJSON events, streams text to Slack via
 * chatStream (with chat.update fallback), emits TaskUpdateChunks for tool
 * calls, and logs usage on completion.
 */

const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const {
  getTeachings, upsertSession, addUsageLog,
} = require("../db");
const {
  buildBlocks, buildStopOnlyBlocks, buildFeedbackBlock, buildDisclaimerBlock,
} = require("../ui/blocks");

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
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

/**
 * Map Claude tool names to human-readable status messages.
 */
const TOOL_STATUS_MAP = {
  Read: "is reading files...",
  Write: "is writing code...",
  Edit: "is editing code...",
  Bash: "is running commands...",
  Glob: "is searching files...",
  Grep: "is searching code...",
  WebFetch: "is fetching web content...",
  WebSearch: "is searching the web...",
  Task: "is delegating a task...",
};

/**
 * Build a human-readable title for a completed tool call.
 * @param {string} toolName
 * @param {object} toolInput - Parsed JSON input
 * @returns {string}
 */
function toolTitle(toolName, toolInput) {
  try {
    switch (toolName) {
      case "Read":
        return `Read ${toolInput.file_path || "file"}`;
      case "Write":
        return `Write ${toolInput.file_path || "file"}`;
      case "Edit":
        return `Edit ${toolInput.file_path || "file"}`;
      case "Bash": {
        const cmd = toolInput.command || "";
        return `Run: ${cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd}`;
      }
      case "Glob":
        return `Search: ${toolInput.pattern || "files"}`;
      case "Grep":
        return `Search: ${toolInput.pattern || "code"}`;
      default:
        return `${toolName}`;
    }
  } catch {
    return toolName;
  }
}

/**
 * Handle a Claude streaming session.
 *
 * @param {object} opts
 * @param {string} opts.channelId
 * @param {string} opts.threadTs
 * @param {string} opts.userText
 * @param {string} opts.userId
 * @param {object} opts.client - Slack WebClient
 * @param {string} opts.spawnCwd
 * @param {boolean} opts.isResume
 * @param {string} opts.sessionId
 * @param {Function} opts.setStatus - Assistant setStatus utility
 * @param {Map} opts.activeProcesses
 * @param {string|null} opts.cachedTeamId
 */
async function handleClaudeStream(opts) {
  const {
    channelId, threadTs, userText, userId, client,
    spawnCwd, isResume, setStatus,
    activeProcesses, cachedTeamId, botUserId,
  } = opts;
  let { sessionId } = opts;

  // ── Post stop-button carrier (stop button only, status handles "thinking") ─
  log(channelId, `Posting stop-button carrier in thread=${threadTs}`);
  await setStatus("is thinking...");

  const stopMsg = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: " ",
    blocks: buildStopOnlyBlocks(threadTs),
  });
  const stopMsgTs = stopMsg.ts;
  log(channelId, `Stop-button carrier posted: ts=${stopMsgTs}`);

  // Re-set status after posting (postMessage clears status)
  await setStatus("is thinking...");

  // ── Create chat streamer (lazy — starts on first append) ──
  let streamer = null;
  if (cachedTeamId) {
    try {
      streamer = client.chatStream({
        channel: channelId,
        thread_ts: threadTs,
        recipient_team_id: cachedTeamId,
        recipient_user_id: userId,
        task_display_mode: "timeline",
      });
      log(channelId, `ChatStream created (lazy, task_display_mode=timeline)`);
    } catch (err) {
      logErr(channelId, `chatStream creation failed, using fallback: ${err.message}`);
    }
  } else {
    log(channelId, `No cached team_id, using chat.update fallback`);
  }

  // ── Build Claude args ─────────────────────────────────────
  const args = [
    "-p", userText,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ];

  // Append user-defined additional args from .env
  const additionalArgs = (process.env.CLAUDE_ADDITIONAL_ARGS || "").trim();
  if (additionalArgs) {
    args.push(...additionalArgs.split(/\s+/));
    log(channelId, `Additional claude args: ${additionalArgs}`);
  }

  if (isResume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  // Inject team teachings
  const teachings = getTeachings("default");
  if (teachings.length > 0) {
    const teachingText = teachings.map((t) => `- ${t.instruction}`).join("\n");
    args.push("--append-system-prompt", `\nTeam conventions:\n${teachingText}`);
    log(channelId, `Injecting ${teachings.length} teaching(s) via --append-system-prompt`);
  } else {
    log(channelId, `No teachings to inject`);
  }

  log(channelId, `Spawning claude: cwd=${spawnCwd} resume=${isResume}`);

  // ── Spawn Claude process ──────────────────────────────────
  const env = { ...process.env };
  delete env.CLAUDECODE;

  // Inject ENV_* variables: ENV_ANTHROPIC_KEY=xxx → ANTHROPIC_KEY=xxx
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith("ENV_") && key.length > 4) {
      env[key.slice(4)] = val;
    }
  }

  // Inject Slack context for MCP server tools
  env.SLACK_CHANNEL_ID = channelId;
  env.SLACK_USER_ID = userId;
  if (botUserId) env.SLACK_BOT_USER_ID = botUserId;

  const proc = spawn(CLAUDE_PATH, args, { env, cwd: spawnCwd, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.end();
  activeProcesses.set(threadTs, proc);

  let accumulatedText = "";
  let appendChain = Promise.resolve();
  let streamerActive = false;
  let streamFailed = !streamer;
  let lastUpdateTime = 0;
  let lastUpdatePromise = Promise.resolve();
  let updateCount = 0;
  let deltaCount = 0;
  let jsonBuffer = "";
  let stopped = false;
  let done = false;
  let resultData = null;
  const startTime = Date.now();

  // Tool tracking for agentic visualization
  const activeTools = new Map(); // index -> { name, inputJson, taskId }
  let taskIdCounter = 0;

  log(channelId, `Claude process started: pid=${proc.pid}, session=${sessionId}, resume=${isResume}, streaming=${!streamFailed}`);

  proc.stdout.on("data", (chunk) => {
    const raw = chunk.toString();
    jsonBuffer += raw;
    const lines = jsonBuffer.split("\n");
    jsonBuffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);

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

            // Track tool_use blocks for agentic visualization
            if (evt.content_block?.type === "tool_use") {
              const toolName = evt.content_block.name;
              const taskId = `task_${++taskIdCounter}`;
              activeTools.set(evt.index, { name: toolName, inputJson: "", taskId });

              // Update status
              const statusMsg = TOOL_STATUS_MAP[toolName] || `is using ${toolName}...`;
              setStatus(statusMsg).catch(() => {});
              log(channelId, `Tool start: ${toolName} (index=${evt.index}, taskId=${taskId})`);

              // Emit in-progress task chunk
              if (!streamFailed) {
                appendChain = appendChain.then(() =>
                  streamer.append({
                    chunks: [{
                      type: "task_update",
                      id: taskId,
                      title: `Using ${toolName}...`,
                      status: "in_progress",
                    }],
                  })
                ).catch((err) => {
                  if (!streamFailed) {
                    logErr(channelId, `Task chunk (in_progress) failed: ${err.message}`);
                  }
                });
              }
            }

          } else if (evt?.type === "content_block_delta") {
            if (evt?.delta?.type === "text_delta") {
              deltaCount++;
              const deltaText = evt.delta.text;
              accumulatedText += deltaText;

              if (deltaCount === 1 || deltaCount % 10 === 0) {
                log(channelId, `stream: text_delta #${deltaCount}, accumulated=${accumulatedText.length} chars`);
              }

              // Streaming path: use chatStream
              if (!streamFailed) {
                appendChain = appendChain.then(() => {
                  if (!streamerActive) {
                    streamerActive = true;
                    log(channelId, `Streamer activated: first append`);
                  }
                  return streamer.append({ markdown_text: deltaText });
                }).catch((err) => {
                  if (!streamFailed) {
                    logErr(channelId, `Streaming failed, falling back to chat.update: ${err.message}`);
                    streamFailed = true;
                  }
                });
              }

              // Fallback path: throttled chat.update
              if (streamFailed) {
                const now = Date.now();
                if (!done && now - lastUpdateTime >= UPDATE_INTERVAL_MS) {
                  lastUpdateTime = now;
                  updateCount++;
                  log(channelId, `chat.update #${updateCount}: ${accumulatedText.length} chars`);
                  lastUpdatePromise = client.chat
                    .update({
                      channel: channelId,
                      ts: stopMsgTs,
                      text: accumulatedText,
                      blocks: buildBlocks(accumulatedText, threadTs, true),
                    })
                    .catch((err) => logErr(channelId, `chat.update failed: ${err.message}`));
                }
              }
            } else if (evt?.delta?.type === "input_json_delta") {
              // Accumulate tool input JSON for title extraction
              const tool = activeTools.get(evt.index);
              if (tool) {
                tool.inputJson += evt.delta.partial_json || "";
              }
            }

          } else if (evt?.type === "content_block_stop") {
            log(channelId, `stream: content_block_stop index=${evt.index}`);

            // Complete tool task chunk
            const tool = activeTools.get(evt.index);
            if (tool) {
              activeTools.delete(evt.index);

              let parsedInput = {};
              try { parsedInput = JSON.parse(tool.inputJson); } catch {}
              const title = toolTitle(tool.name, parsedInput);
              log(channelId, `Tool complete: ${tool.name} -> "${title}"`);

              // Emit complete task chunk
              if (!streamFailed) {
                appendChain = appendChain.then(() =>
                  streamer.append({
                    chunks: [{
                      type: "task_update",
                      id: tool.taskId,
                      title,
                      status: "complete",
                    }],
                  })
                ).catch((err) => {
                  if (!streamFailed) {
                    logErr(channelId, `Task chunk (complete) failed: ${err.message}`);
                  }
                });
              }

              // Reset status to thinking
              setStatus("is thinking...").catch(() => {});
            }

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
          resultData = data;
          const elapsed = Date.now() - startTime;
          log(channelId, `stream: result subtype=${data.subtype} is_error=${data.is_error} duration_ms=${data.duration_ms} turns=${data.num_turns} cost=$${data.total_cost_usd?.toFixed(4)} session=${data.session_id}`);
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

  return new Promise((resolve) => {
    proc.on("close", async (code, signal) => {
      done = true;
      activeProcesses.delete(threadTs);
      stopped = signal === "SIGTERM";
      const elapsed = Date.now() - startTime;

      log(channelId, `Claude process exited: code=${code} signal=${signal} pid=${proc.pid} elapsed=${elapsed}ms stopped=${stopped}`);
      log(channelId, `Final stats: deltas=${deltaCount}, slack_updates=${updateCount}, text_length=${accumulatedText.length}, streaming=${streamerActive}`);

      // ── Usage logging ──────────────────────────────────
      if (resultData) {
        try {
          addUsageLog(
            threadTs, userId,
            resultData.model || null,
            resultData.input_tokens || 0,
            resultData.output_tokens || 0,
            resultData.total_cost_usd || 0,
            resultData.duration_ms || elapsed,
            resultData.num_turns || 0,
          );
          log(channelId, `Usage logged: cost=$${(resultData.total_cost_usd || 0).toFixed(4)} turns=${resultData.num_turns}`);
        } catch (err) {
          logErr(channelId, `Failed to log usage: ${err.message}`);
        }
      }

      // ── Finalize streaming or fallback ─────────────────
      const finalizationBlocks = [buildFeedbackBlock(threadTs), buildDisclaimerBlock()];

      log(channelId, `Finalize path: streamFailed=${streamFailed} streamerActive=${streamerActive}`);
      if (!streamFailed && streamerActive) {
        await appendChain;
        if (stopped) {
          await streamer.append({ markdown_text: "\n\n_Stopped by user._" }).catch(() => {});
        }

        // Stop the stream and capture its message ts
        let streamMsgTs;
        try {
          const stopResponse = await streamer.stop();
          streamMsgTs = stopResponse.ts;
          log(channelId, `Stream stopped: streamMsgTs=${streamMsgTs}`);
        } catch (err) {
          logErr(channelId, `streamer.stop failed: ${err.message}`);
        }

        // Delete the stream message and the stop-button carrier
        if (streamMsgTs) {
          await client.chat.delete({ channel: channelId, ts: streamMsgTs }).catch((err) => {
            logErr(channelId, `Failed to delete stream message: ${err.message}`);
          });
        }
        await client.chat.delete({ channel: channelId, ts: stopMsgTs }).catch(() => {});

        // Post a durable message with the full accumulated text
        const finalText = stopped
          ? (accumulatedText ? accumulatedText + "\n\n_Stopped by user._" : "_Stopped by user._")
          : (accumulatedText || "No response.");
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: finalText,
          blocks: [...buildBlocks(finalText, threadTs, false), ...finalizationBlocks],
        }).catch((err) => logErr(channelId, `Final postMessage failed: ${err.message}`));

        log(channelId, `Stream replaced with durable message (${finalText.length} chars)`);
      } else if (!streamFailed && !streamerActive) {
        const text = stopped
          ? "_Stopped by user._"
          : code !== 0 ? "Something went wrong." : "No response.";
        log(channelId, `No text produced, final message: "${text}"`);
        await client.chat.update({
          channel: channelId,
          ts: stopMsgTs,
          text,
          blocks: [...buildBlocks(text, threadTs, false), ...finalizationBlocks],
        }).catch((err) => logErr(channelId, `Final update failed: ${err.message}`));
      } else {
        // Fallback: chat.update mode
        let finalText;
        if (stopped) {
          finalText = accumulatedText
            ? accumulatedText + "\n\n_Stopped by user._"
            : "_Stopped by user._";
        } else {
          finalText = accumulatedText || (code !== 0 ? "Something went wrong." : "No response.");
        }

        await lastUpdatePromise;

        log(channelId, `Sending final chat.update (${finalText.length} chars)`);
        await client.chat
          .update({
            channel: channelId,
            ts: stopMsgTs,
            text: finalText,
            blocks: [...buildBlocks(finalText, threadTs, false), ...finalizationBlocks],
          })
          .catch((err) => logErr(channelId, `Final chat.update failed: ${err.message}`));
      }

      // Clear Assistant status indicator
      await setStatus("").catch(() => {});


      log(channelId, `Done processing message from user=${userId}`);
      resolve();
    });
  });
}

module.exports = { handleClaudeStream };
