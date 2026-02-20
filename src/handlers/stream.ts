/**
 * Claude CLI streaming handler with agentic task visualization.
 *
 * Spawns the Claude CLI, parses NDJSON events, streams text to Slack via
 * chatStream (with chat.update fallback), emits TaskUpdateChunks for tool
 * calls, and logs usage on completion.
 */

import { spawn } from "child_process";
import { getTeachings, upsertSession, addUsageLog } from "../db.ts";
import {
  buildBlocks, buildStopOnlyBlocks, buildFeedbackBlock, buildDisclaimerBlock,
} from "../ui/blocks.ts";
import { log, logErr } from "../lib/log.ts";
import type { HandleClaudeStreamOpts } from "../types.ts";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const UPDATE_INTERVAL_MS = 750;

const TOOL_STATUS_MAP: Record<string, string> = {
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

export function toolTitle(toolName: string, toolInput: any): string {
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

export async function handleClaudeStream(opts: HandleClaudeStreamOpts): Promise<void> {
  const {
    channelId, threadTs, userText, userId, client,
    spawnCwd, isResume, setStatus,
    activeProcesses, cachedTeamId, botUserId,
  } = opts;
  let { sessionId } = opts;

  // ── Status + lazy stop-button carrier ───────────────────────
  await setStatus("is thinking...");

  // Stop button is posted lazily: after first stream content (so it appears
  // below the streaming text) or before first fallback chat.update.
  let stopMsgTs: string | undefined;
  let stopBtnPromise: Promise<void>;
  function ensureStopButton(): Promise<void> {
    if (!stopBtnPromise) {
      stopBtnPromise = client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: " ",
        blocks: buildStopOnlyBlocks(threadTs),
      }).then((res: any) => {
        stopMsgTs = res.ts;
        log(channelId, `Stop-button carrier posted: ts=${stopMsgTs}`);
      }).catch((err: any) => {
        logErr(channelId, `Failed to post stop button: ${err.message}`);
      });
    }
    return stopBtnPromise;
  }

  // ── Create chat streamer (lazy — starts on first append) ──
  let streamer: any = null;
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
    } catch (err: any) {
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
  const env: Record<string, string | undefined> = { ...process.env };
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

  const proc = spawn(CLAUDE_PATH, args, { env: env as NodeJS.ProcessEnv, cwd: spawnCwd, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin!.end();
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
  let resultData: any = null;
  const startTime = Date.now();

  // Tool tracking for agentic visualization
  const activeTools = new Map<number, { name: string; inputJson: string; taskId: string }>();
  let taskIdCounter = 0;
  let thinkingTaskDone = false;

  // ── Start stream immediately for instant visual feedback ──
  if (!streamFailed) {
    appendChain = appendChain.then(() => {
      streamerActive = true;
      log(channelId, `Streamer activated: initial "Thinking..." indicator`);
      return streamer.append({
        chunks: [{
          type: "task_update",
          id: "thinking",
          title: "Thinking...",
          status: "in_progress",
        }],
      });
    }).catch((err: any) => {
      logErr(channelId, `Initial stream start failed, using fallback: ${err.message}`);
      streamerActive = false;
      streamFailed = true;
    });
  }

  log(channelId, `Claude process started: pid=${proc.pid}, session=${sessionId}, resume=${isResume}, streaming=${!streamFailed}`);

  proc.stdout!.on("data", (chunk: Buffer) => {
    const raw = chunk.toString();
    jsonBuffer += raw;
    const lines = jsonBuffer.split("\n");
    jsonBuffer = lines.pop()!;

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

            // Complete the initial "Thinking..." indicator
            if (!thinkingTaskDone && !streamFailed) {
              thinkingTaskDone = true;
              appendChain = appendChain.then(() =>
                streamer.append({
                  chunks: [{ type: "task_update", id: "thinking", title: "Thinking", status: "complete" }],
                })
              ).catch(() => {});
            }

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
                ).catch((err: any) => {
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
                appendChain = appendChain.then(async () => {
                  if (!streamerActive) {
                    streamerActive = true;
                    log(channelId, `Streamer activated: first append`);
                  }
                  await streamer.append({ markdown_text: deltaText });
                  // Post stop button after first successful append (appears below stream)
                  ensureStopButton();
                }).catch((err: any) => {
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
                  lastUpdatePromise = ensureStopButton().then(() => {
                    if (!stopMsgTs) return;
                    return client.chat.update({
                      channel: channelId,
                      ts: stopMsgTs,
                      text: accumulatedText,
                      blocks: buildBlocks(accumulatedText, threadTs, true),
                    });
                  }).catch((err: any) => logErr(channelId, `chat.update failed: ${err.message}`));
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

              let parsedInput: any = {};
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
                ).catch((err: any) => {
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
          if (data.is_error && data.result) {
            logErr(channelId, `stream: error detail: ${typeof data.result === "string" ? data.result : JSON.stringify(data.result)}`);
          }
          log(channelId, `stream: total deltas=${deltaCount}, slack updates=${updateCount}, wall_time=${elapsed}ms`);
        } else {
          log(channelId, `stream: unknown type=${data.type}`);
        }
      } catch (err: any) {
        logErr(channelId, `Failed to parse stream line: ${err.message} — raw: ${line.substring(0, 200)}`);
      }
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    logErr(channelId, `claude stderr: ${chunk.toString().trim()}`);
  });

  proc.on("error", (err) => {
    logErr(channelId, `claude process error: ${err.message}`);
    activeProcesses.delete(threadTs);
  });

  return new Promise<void>((resolve) => {
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
        } catch (err: any) {
          logErr(channelId, `Failed to log usage: ${err.message}`);
        }
      }

      // ── Finalize streaming or fallback ─────────────────
      const finalizationBlocks = [buildFeedbackBlock(threadTs), buildDisclaimerBlock()];

      log(channelId, `Finalize path: streamFailed=${streamFailed} streamerActive=${streamerActive}`);
      if (!streamFailed && streamerActive) {
        await appendChain;

        // Complete the thinking indicator if it never got resolved
        if (!thinkingTaskDone) {
          thinkingTaskDone = true;
          await streamer.append({
            chunks: [{ type: "task_update", id: "thinking", title: "Thinking", status: "complete" }],
          }).catch(() => {});
        }

        if (stopped) {
          await streamer.append({ markdown_text: "\n\n_Stopped by user._" }).catch(() => {});
        }

        // Finalize stream as a durable message with feedback/disclaimer blocks
        try {
          await streamer.stop({ blocks: finalizationBlocks });
          log(channelId, `Stream finalized with blocks (${accumulatedText.length} chars)`);
        } catch (err: any) {
          logErr(channelId, `streamer.stop failed: ${err.message}`);
        }

        // Delete only the stop-button carrier
        if (stopMsgTs) {
          await client.chat.delete({ channel: channelId, ts: stopMsgTs }).catch((err: any) => {
            logErr(channelId, `Failed to delete stop button carrier: ${err.message}`);
          });
        }
      } else if (!streamFailed && !streamerActive) {
        const text = stopped
          ? "_Stopped by user._"
          : code !== 0 ? "Something went wrong." : "No response.";
        log(channelId, `No text produced, final message: "${text}"`);
        if (stopMsgTs) {
          await client.chat.update({
            channel: channelId,
            ts: stopMsgTs,
            text,
            blocks: [...buildBlocks(text, threadTs, false), ...finalizationBlocks],
          }).catch((err: any) => logErr(channelId, `Final update failed: ${err.message}`));
        } else {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text,
            blocks: [...buildBlocks(text, threadTs, false), ...finalizationBlocks],
          }).catch((err: any) => logErr(channelId, `Final postMessage failed: ${err.message}`));
        }
      } else {
        // Fallback: chat.update mode
        let finalText: string;
        if (stopped) {
          finalText = accumulatedText
            ? accumulatedText + "\n\n_Stopped by user._"
            : "_Stopped by user._";
        } else {
          finalText = accumulatedText || (code !== 0 ? "Something went wrong." : "No response.");
        }

        await lastUpdatePromise;
        await ensureStopButton();

        log(channelId, `Sending final chat.update (${finalText.length} chars)`);
        if (stopMsgTs) {
          await client.chat
            .update({
              channel: channelId,
              ts: stopMsgTs,
              text: finalText,
              blocks: [...buildBlocks(finalText, threadTs, false), ...finalizationBlocks],
            })
            .catch((err: any) => logErr(channelId, `Final chat.update failed: ${err.message}`));
        } else {
          await client.chat
            .postMessage({
              channel: channelId,
              thread_ts: threadTs,
              text: finalText,
              blocks: [...buildBlocks(finalText, threadTs, false), ...finalizationBlocks],
            })
            .catch((err: any) => logErr(channelId, `Final postMessage failed: ${err.message}`));
        }
      }

      // Clear Assistant status indicator
      await setStatus("").catch(() => {});

      log(channelId, `Done processing message from user=${userId}`);
      resolve();
    });
  });
}
