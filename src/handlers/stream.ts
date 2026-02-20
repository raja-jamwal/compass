/**
 * Claude CLI streaming handler with agentic task visualization.
 *
 * Spawns the Claude CLI, parses NDJSON events, streams text to Slack via
 * chatStream (with chat.update fallback), emits TaskUpdateChunks for tool
 * calls, and logs usage on completion.
 *
 * Supports two display modes:
 *   - "plan"     – used when Claude enters plan mode (EnterPlanMode tool).
 *                  Shows a plan_update title + grouped task_update steps.
 *   - "timeline" – default mode for normal tool-use / implementation.
 *                  Shows individual task cards interleaved with streamed text.
 *
 * The display mode is detected from the first content_block_start event and
 * the streamer is created lazily so we can pick the right mode.
 */

import { spawn } from "child_process";
import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getTeachings, upsertSession, addUsageLog } from "../db.ts";
import {
  buildBlocks, buildStopOnlyBlocks, buildFeedbackBlock, buildDisclaimerBlock,
} from "../ui/blocks.ts";
import { log, logErr } from "../lib/log.ts";
import type { HandleClaudeStreamOpts } from "../types.ts";

// ── Temporary debug: dump raw NDJSON to file ──────────────────
const STREAM_DEBUG = process.env.STREAM_DEBUG === "1";
const STREAM_DEBUG_FILE = join(import.meta.dir, "..", "stream-debug.jsonl");

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const UPDATE_INTERVAL_MS = 750;

/** Tools that are internal / meta and should be hidden or shown differently */
const HIDDEN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);

const TOOL_STATUS_MAP: Record<string, string> = {
  Read: "is reading files...",
  Write: "is writing code...",
  Edit: "is editing code...",
  Bash: "is running commands...",
  Glob: "is searching files...",
  Grep: "is searching code...",
  WebFetch: "is fetching web content...",
  WebSearch: "is searching the web...",
  Task: "is running a sub-agent...",
  EnterPlanMode: "is planning...",
  ExitPlanMode: "is finalizing the plan...",
  TaskCreate: "is creating tasks...",
  TaskUpdate: "is updating tasks...",
  TodoWrite: "is updating tasks...",
  NotebookEdit: "is editing a notebook...",
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
      case "Task": {
        const desc = toolInput.description || toolInput.subagent_type || "task";
        return `Sub-agent: ${desc}`;
      }
      case "AskUserQuestion": {
        const q = toolInput.questions?.[0]?.question;
        return q ? `Question: ${q}` : "Asking a question...";
      }
      case "EnterPlanMode":
        return "Entering plan mode";
      case "ExitPlanMode":
        return "Plan ready";
      case "TaskCreate":
      case "TodoWrite":
        return `Create task: ${toolInput.subject || toolInput.description || "task"}`;
      case "TaskUpdate":
        return `Update task: ${toolInput.subject || toolInput.status || "task"}`;
      default:
        return `${toolName}`;
    }
  } catch {
    return toolName;
  }
}

const MAX_OUTPUT_LEN = 120;

/**
 * Extract a brief output summary from a tool result for display on task cards.
 * Returns null if there's nothing meaningful to show.
 */
function extractToolOutput(resultSummary: any, contentBlock: any): string | null {
  // Try the top-level tool_use_result summary first (concise)
  let text: string | null = null;
  if (typeof resultSummary === "string" && resultSummary.length > 0) {
    text = resultSummary;
  } else if (resultSummary?.message) {
    text = resultSummary.message;
  }

  // Fall back to the content block's content field
  if (!text && contentBlock?.content) {
    const raw = typeof contentBlock.content === "string"
      ? contentBlock.content
      : JSON.stringify(contentBlock.content);
    // Count lines for file/search results
    const lines = raw.split("\n");
    if (lines.length > 3) {
      text = `${lines.length} lines`;
    } else if (raw.length > 0 && raw.length <= MAX_OUTPUT_LEN) {
      text = raw;
    }
  }

  if (!text) return null;
  // Strip "Error: " prefix noise from non-interactive tool stubs
  if (text.startsWith("Error: ")) text = text.slice(7);
  // Truncate
  return text.length > MAX_OUTPUT_LEN ? text.slice(0, MAX_OUTPUT_LEN - 3) + "..." : text;
}

export async function handleClaudeStream(opts: HandleClaudeStreamOpts): Promise<void> {
  const {
    channelId, threadTs, userText, userId, client,
    spawnCwd, isResume, setStatus,
    activeProcesses, cachedTeamId, botUserId,
  } = opts;
  let { sessionId } = opts;

  // ── Thinking indicator (instant feedback) ──
  await setStatus({
    status: "is thinking...",
    loading_messages: [
      "Thinking...",
      "Processing your request...",
      "Working on it...",
    ],
  });

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

  // ── Streamer ──────────────────────────────────────────────
  // Assistant threads: created lazily (native setStatus provides instant feedback
  // while we detect plan vs timeline mode from the first content event).
  // Channel @mentions: created eagerly with a "Thinking" in_progress task
  // (no native setStatus available, so the stream IS the thinking indicator).
  let streamer: any = null;
  let displayMode: "plan" | "timeline" | null = null;
  let streamerActive = false;
  let streamFailed = !cachedTeamId;

  if (!cachedTeamId) {
    log(channelId, `No cached team_id, using chat.update fallback`);
  }

  function initStreamer(mode: "plan" | "timeline") {
    if (streamer) return;
    displayMode = mode;
    try {
      streamer = client.chatStream({
        channel: channelId,
        thread_ts: threadTs,
        recipient_team_id: cachedTeamId,
        recipient_user_id: userId,
        task_display_mode: mode,
      });
      log(channelId, `Streamer created: task_display_mode=${mode}`);
    } catch (err: any) {
      logErr(channelId, `Streamer creation failed (${mode}): ${err.message}`);
      streamFailed = true;
    }
  }

  /**
   * Ensure the streamer exists (defaults to timeline if not yet created),
   * then append chunks/text. Handles the appendChain serialization.
   */
  function safeAppend(payload: any) {
    if (streamFailed) return;
    if (!streamer) initStreamer("timeline");
    appendChain = appendChain.then(async () => {
      if (!streamerActive) {
        streamerActive = true;
        log(channelId, `Streamer activated`);
      }
      await streamer.append(payload);
    }).catch((err: any) => {
      if (!streamFailed) {
        logErr(channelId, `Stream append failed: ${err.message}`);
        streamFailed = true;
      }
    });
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
  // Maps content_block index → tool info (including the tool_use_id for sub-agent correlation)
  const activeTools = new Map<number, {
    name: string;
    inputJson: string;
    taskId: string;
    toolUseId: string;
  }>();
  let taskIdCounter = 0;
  let thinkingTaskDone = false;
  let planModeActive = false;

  // Sub-agent tracking: maps a Task tool_use_id → its visual task info
  const subAgentTasks = new Map<string, { description: string; taskId: string }>();

  // Completed tool tracking: maps tool_use_id → task info so we can update
  // the task card with output/sources/error when the tool result arrives later.
  const completedTools = new Map<string, { taskId: string; name: string; title: string }>();

  log(channelId, `Claude process started: pid=${proc.pid}, session=${sessionId}, resume=${isResume}, streaming=${!streamFailed}`);

  // Clear debug file for this run
  if (STREAM_DEBUG) {
    writeFileSync(STREAM_DEBUG_FILE, "");
    log(channelId, `[STREAM_DEBUG] Dumping raw NDJSON to ${STREAM_DEBUG_FILE}`);
  }

  proc.stdout!.on("data", (chunk: Buffer) => {
    const raw = chunk.toString();
    jsonBuffer += raw;
    const lines = jsonBuffer.split("\n");
    jsonBuffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;

      // Dump every raw line to debug file
      if (STREAM_DEBUG) {
        try { appendFileSync(STREAM_DEBUG_FILE, line + "\n"); } catch {}
      }

      try {
        const data = JSON.parse(line);

        // ── system messages ────────────────────────────────
        if (data.type === "system") {
          log(channelId, `stream: type=system subtype=${data.subtype} session_id=${data.session_id} model=${data.model || "n/a"}`);
          if (data.subtype === "init" && data.session_id) {
            const oldId = sessionId;
            sessionId = data.session_id;
            upsertSession(threadTs, data.session_id);
            log(channelId, `Session ID updated: ${oldId} -> ${data.session_id}`);
          } else if (data.subtype === "status") {
            // Track permission mode changes (plan mode entry/exit)
            if (data.permissionMode === "plan") {
              planModeActive = true;
              log(channelId, `stream: plan mode activated (permissionMode=plan)`);
            } else if (planModeActive && data.permissionMode !== "plan") {
              planModeActive = false;
              log(channelId, `stream: plan mode deactivated (permissionMode=${data.permissionMode})`);
            }
          }

        // ── stream_event (raw Claude API events) ──────────
        } else if (data.type === "stream_event") {
          const evt = data.event;
          const parentId = data.parent_tool_use_id;

          // ── Sub-agent stream events: update parent task details ──
          if (parentId && subAgentTasks.has(parentId)) {
            // Sub-agent events are typically complete messages, but if any
            // stream_events leak through with a parent_tool_use_id, log them.
            if (evt?.type === "content_block_start" && evt.content_block?.type === "tool_use") {
              const subTool = evt.content_block.name;
              const parentTask = subAgentTasks.get(parentId)!;
              const detail = TOOL_STATUS_MAP[subTool] || `Using ${subTool}...`;
              safeAppend({
                chunks: [{
                  type: "task_update",
                  id: parentTask.taskId,
                  title: parentTask.description,
                  status: "in_progress" as const,
                  details: detail,
                }],
              });
            }
            continue; // don't process sub-agent stream_events as top-level
          }

          if (evt?.type === "message_start") {
            log(channelId, `stream: message_start model=${evt.message?.model} id=${evt.message?.id}`);

          } else if (evt?.type === "content_block_start") {
            const blockType = evt.content_block?.type;
            log(channelId, `stream: content_block_start index=${evt.index} type=${blockType}`);

            // ── Plan mode detection: create plan streamer before any other appends ──
            if (blockType === "tool_use" && evt.content_block.name === "EnterPlanMode" && !streamer) {
              initStreamer("plan");
              safeAppend({
                chunks: [{ type: "plan_update", title: "Planning..." }],
              });
              log(channelId, `Plan mode: created plan streamer with plan_update title`);
            }

            // ── Ensure streamer exists (defaults to timeline) ──
            // Skip for thinking blocks — no visual output, and creating the
            // streamer (chat.startStream) clears the native setStatus indicator.
            if (!streamer && !streamFailed && blockType !== "thinking") {
              initStreamer("timeline");
            }

            // ── Complete the "Thinking..." task (timeline only) ──
            // In timeline mode, we show a brief "Thinking" completed card.
            // In plan mode, the plan_update title is the indicator.
            // Skip for thinking blocks — the native setStatus indicator is still active.
            if (!thinkingTaskDone && !streamFailed && blockType !== "thinking") {
              thinkingTaskDone = true;
              if (displayMode === "timeline") {
                safeAppend({
                  chunks: [{ type: "task_update", id: "thinking", title: "Thinking", status: "complete" as const }],
                });
              }
            }

            // ── Track tool_use blocks for agentic visualization ──
            if (blockType === "tool_use") {
              const toolName = evt.content_block.name;
              const toolUseId = evt.content_block.id || "";
              const taskId = `task_${++taskIdCounter}`;
              activeTools.set(evt.index, { name: toolName, inputJson: "", taskId, toolUseId });

              // Update Slack status bar
              const statusMsg = TOOL_STATUS_MAP[toolName] || `is using ${toolName}...`;
              setStatus(statusMsg).catch(() => {});
              log(channelId, `Tool start: ${toolName} (index=${evt.index}, taskId=${taskId}, toolUseId=${toolUseId})`);

              // Emit in-progress task chunk (skip hidden/meta tools)
              if (!HIDDEN_TOOLS.has(toolName)) {
                safeAppend({
                  chunks: [{
                    type: "task_update",
                    id: taskId,
                    title: `Using ${toolName}...`,
                    status: "in_progress" as const,
                  }],
                });
              }
            }

            // ── Thinking block: show indicator ──
            if (blockType === "thinking") {
              log(channelId, `stream: thinking block started (index=${evt.index})`);
              if (displayMode === "plan") {
                setStatus("is planning...").catch(() => {});
              } else {
                setStatus("is thinking...").catch(() => {});
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

              // Ensure streamer + mark thinking done on first text
              if (!streamer && !streamFailed) initStreamer("timeline");
              if (!thinkingTaskDone && !streamFailed) {
                thinkingTaskDone = true;
                if (displayMode === "timeline") {
                  safeAppend({
                    chunks: [{ type: "task_update", id: "thinking", title: "Thinking", status: "complete" as const }],
                  });
                }
              }

              // Streaming path: use chatStream
              if (!streamFailed) {
                appendChain = appendChain.then(async () => {
                  if (!streamerActive) {
                    streamerActive = true;
                    log(channelId, `Streamer activated: first text append`);
                  }
                  await streamer.append({ markdown_text: deltaText });
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
            } else if (evt?.delta?.type === "thinking_delta") {
              // Extended thinking — no visual output, just log occasionally
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

              // ── Special handling: AskUserQuestion ──
              // Render the question + options as visible content so the user
              // sees what Claude wanted to ask (the tool itself errors in
              // non-interactive mode, but the question is still valuable).
              if (tool.name === "AskUserQuestion") {
                const questions = parsedInput.questions || [];
                const parts: string[] = [];
                for (const q of questions) {
                  if (q.question) parts.push(`> *${q.question}*`);
                  for (const opt of q.options || []) {
                    const desc = opt.description ? ` — ${opt.description}` : "";
                    parts.push(`>  • ${opt.label}${desc}`);
                  }
                }
                if (parts.length > 0) {
                  safeAppend({ markdown_text: "\n" + parts.join("\n") + "\n\n" });
                }
                // Mark the task complete with the question as title
                safeAppend({
                  chunks: [{
                    type: "task_update",
                    id: tool.taskId,
                    title,
                    status: "complete" as const,
                  }],
                });

              // ── Special handling: Task (sub-agent) ──
              } else if (tool.name === "Task") {
                const desc = parsedInput.description || parsedInput.subagent_type || "Sub-agent";
                subAgentTasks.set(tool.toolUseId, { description: `Sub-agent: ${desc}`, taskId: tool.taskId });
                log(channelId, `Sub-agent registered: toolUseId=${tool.toolUseId} desc="${desc}"`);
                // Don't mark complete yet — it completes when the sub-agent finishes
                // (we'll get a type=user tool_result for this toolUseId)
              } else if (HIDDEN_TOOLS.has(tool.name)) {
                // Hidden tools (EnterPlanMode, ExitPlanMode):
                // no task_update emitted on start, so nothing to complete.
                // But update plan title on ExitPlanMode
                if (tool.name === "ExitPlanMode" && displayMode === "plan") {
                  safeAppend({
                    chunks: [{ type: "plan_update", title: "Plan ready" }],
                  });
                }
              } else {
                // Normal tool: emit complete task chunk
                // Attach sources for web tools (WebFetch, WebSearch)
                const sources: { type: "url"; url: string; text: string }[] = [];
                if (tool.name === "WebFetch" && parsedInput.url) {
                  try {
                    const hostname = new URL(parsedInput.url).hostname;
                    sources.push({ type: "url", url: parsedInput.url, text: hostname });
                  } catch {
                    sources.push({ type: "url", url: parsedInput.url, text: parsedInput.url });
                  }
                }

                safeAppend({
                  chunks: [{
                    type: "task_update",
                    id: tool.taskId,
                    title,
                    status: "complete" as const,
                    ...(sources.length > 0 ? { sources } : {}),
                  }],
                });

                // Register for later output/error update when tool result arrives
                completedTools.set(tool.toolUseId, { taskId: tool.taskId, name: tool.name, title });
              }

              // Reset status to thinking/planning
              setStatus(planModeActive ? "is planning..." : "is thinking...").catch(() => {});
            }

          } else if (evt?.type === "message_delta") {
            log(channelId, `stream: message_delta stop_reason=${evt.delta?.stop_reason}`);
          } else if (evt?.type === "message_stop") {
            log(channelId, `stream: message_stop`);
          } else {
            log(channelId, `stream: stream_event type=${evt?.type}`);
          }

        // ── assistant messages (complete turn) ────────────
        } else if (data.type === "assistant") {
          const parentId = data.parent_tool_use_id;
          const content = data.message?.content;
          const model = data.message?.model || "unknown";

          if (parentId && subAgentTasks.has(parentId)) {
            // Sub-agent assistant message: extract tool calls to update details
            const parentTask = subAgentTasks.get(parentId)!;
            const toolCalls = (content || []).filter((c: any) => c.type === "tool_use");
            if (toolCalls.length > 0) {
              const toolNames = toolCalls.map((t: any) => t.name).join(", ");
              log(channelId, `stream: sub-agent (${model}) tools: ${toolNames} [parent=${parentId}]`);
              // Update the sub-agent task's details with what it's doing
              const lastTool = toolCalls[toolCalls.length - 1];
              let detail = TOOL_STATUS_MAP[lastTool.name] || `Using ${lastTool.name}...`;
              // Try to get a more specific detail from the tool input
              try {
                if (lastTool.name === "Read" && lastTool.input?.file_path) {
                  detail = `Reading ${lastTool.input.file_path.split("/").pop()}`;
                } else if (lastTool.name === "Grep" && lastTool.input?.pattern) {
                  detail = `Searching: ${lastTool.input.pattern}`;
                } else if (lastTool.name === "Glob" && lastTool.input?.pattern) {
                  detail = `Finding: ${lastTool.input.pattern}`;
                } else if (lastTool.name === "Bash" && lastTool.input?.command) {
                  const cmd = lastTool.input.command;
                  detail = `Running: ${cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd}`;
                }
              } catch {}
              safeAppend({
                chunks: [{
                  type: "task_update",
                  id: parentTask.taskId,
                  title: parentTask.description,
                  status: "in_progress" as const,
                  details: detail,
                }],
              });
            } else {
              const textLen = content?.[0]?.text?.length || 0;
              log(channelId, `stream: sub-agent (${model}) text response, len=${textLen} [parent=${parentId}]`);
            }
          } else {
            const textLen = content?.[0]?.text?.length || 0;
            log(channelId, `stream: assistant message (${model}), content_length=${textLen} chars`);
          }

        // ── user messages (tool results) ──────────────────
        } else if (data.type === "user") {
          const parentId = data.parent_tool_use_id;
          const resultSummary = data.tool_use_result;
          const content = data.message?.content;

          if (parentId && subAgentTasks.has(parentId)) {
            // Sub-agent tool result: update details
            const parentTask = subAgentTasks.get(parentId)!;
            // Check if this is the sub-agent's prompt (first user message) or a tool result
            const firstBlock = content?.[0];
            if (firstBlock?.type === "tool_result") {
              log(channelId, `stream: sub-agent tool result [parent=${parentId}]`);
            } else {
              log(channelId, `stream: sub-agent prompt delivered [parent=${parentId}]`);
            }
          } else if (parentId === null || parentId === undefined) {
            // Top-level tool result
            const firstBlock = content?.[0];
            const toolUseId = firstBlock?.tool_use_id;

            // Check if this completes a sub-agent Task
            if (toolUseId && subAgentTasks.has(toolUseId)) {
              const subTask = subAgentTasks.get(toolUseId)!;
              // Extract a brief output summary from the result
              const subOutput = extractToolOutput(resultSummary, firstBlock);
              log(channelId, `stream: sub-agent completed: ${subTask.description} [toolUseId=${toolUseId}]`);
              safeAppend({
                chunks: [{
                  type: "task_update",
                  id: subTask.taskId,
                  title: subTask.description,
                  status: "complete" as const,
                  details: undefined,
                  ...(subOutput ? { output: subOutput } : {}),
                }],
              });
              subAgentTasks.delete(toolUseId);

            // Update a completed tool's task card with output or error status
            } else if (toolUseId && completedTools.has(toolUseId)) {
              const completed = completedTools.get(toolUseId)!;
              completedTools.delete(toolUseId);

              const isError = firstBlock?.is_error === true;
              const output = extractToolOutput(resultSummary, firstBlock);

              // Extract sources from WebSearch results (URLs in the content)
              const sources: { type: "url"; url: string; text: string }[] = [];
              if (completed.name === "WebSearch" && firstBlock?.content) {
                const raw = typeof firstBlock.content === "string" ? firstBlock.content : "";
                const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
                let m: RegExpExecArray | null;
                while ((m = urlRegex.exec(raw)) !== null && sources.length < 4) {
                  sources.push({ type: "url", url: m[2], text: m[1] });
                }
              }

              if (isError || output || sources.length > 0) {
                log(channelId, `stream: tool result update taskId=${completed.taskId} error=${isError} sources=${sources.length}${output ? ` output="${output.substring(0, 60)}"` : ""}`);
                safeAppend({
                  chunks: [{
                    type: "task_update",
                    id: completed.taskId,
                    title: completed.title,
                    status: isError ? "error" as const : "complete" as const,
                    ...(output ? { output } : {}),
                    ...(sources.length > 0 ? { sources } : {}),
                  }],
                });
              } else {
                log(channelId, `stream: tool result (no output) [toolUseId=${toolUseId}]`);
              }
            } else {
              // Untracked tool result — just log
              const summary = typeof resultSummary === "string"
                ? resultSummary
                : resultSummary?.message || "";
              log(channelId, `stream: tool result${summary ? `: ${summary.substring(0, 80)}` : ""}`);
            }
          } else {
            log(channelId, `stream: user message (parent=${parentId})`);
          }

        // ── result (final) ────────────────────────────────
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
      log(channelId, `Final stats: deltas=${deltaCount}, slack_updates=${updateCount}, text_length=${accumulatedText.length}, streaming=${streamerActive}, mode=${displayMode}`);

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

      // ── Mark any remaining sub-agent tasks as complete ──
      for (const [id, sub] of subAgentTasks) {
        safeAppend({
          chunks: [{
            type: "task_update",
            id: sub.taskId,
            title: sub.description,
            status: "complete" as const,
          }],
        });
      }
      subAgentTasks.clear();

      // ── Finalize streaming or fallback ─────────────────
      const finalizationBlocks = [buildFeedbackBlock(threadTs), buildDisclaimerBlock()];

      log(channelId, `Finalize path: streamFailed=${streamFailed} streamerActive=${streamerActive}`);
      if (!streamFailed && streamerActive) {
        await appendChain;

        // Complete the thinking indicator if it never got resolved (timeline only)
        if (!thinkingTaskDone && displayMode === "timeline") {
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
          log(channelId, `Stream finalized with blocks (${accumulatedText.length} chars, mode=${displayMode})`);
        } catch (err: any) {
          logErr(channelId, `streamer.stop failed: ${err.message}`);
        }

        // Delete only the stop-button carrier
        if (stopMsgTs) {
          await client.chat.delete({ channel: channelId, ts: stopMsgTs }).catch((err: any) => {
            logErr(channelId, `Failed to delete stop button carrier: ${err.message}`);
          });
        }
      } else if (streamer && !streamerActive) {
        // Streamer was created but never activated (no content appended)
        const text = stopped
          ? "_Stopped by user._"
          : code !== 0 ? "Something went wrong." : "No response.";
        log(channelId, `No text produced, final message: "${text}"`);

        // Try to use the streamer for a clean message
        try {
          await streamer.append({ markdown_text: text });
          await streamer.stop({ blocks: finalizationBlocks });
        } catch {
          // Streamer failed, fall back to postMessage
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text,
            blocks: [...buildBlocks(text, threadTs, false), ...finalizationBlocks],
          }).catch((err: any) => logErr(channelId, `Final postMessage failed: ${err.message}`));
        }
      } else {
        // Fallback: chat.update mode (no streamer or stream failed)
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
