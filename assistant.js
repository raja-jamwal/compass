/**
 * Slack Assistant handler — threadStarted + userMessage.
 *
 * Uses the Bolt Assistant class to intercept all IM thread messages,
 * providing suggested prompts, thread titles, status indicators,
 * and delegating to the stream handler for Claude invocations.
 */

const { Assistant } = require("@slack/bolt");
const { randomUUID } = require("crypto");
const {
  getSession, upsertSession, setCwd, getCwdHistory, addCwdHistory,
  addTeaching, getTeachings, removeTeaching, getTeachingCount,
  getWorktree, touchWorktree, upsertWorktree,
} = require("./db");
const {
  detectGitRepo, createWorktree, copyEnvFiles,
} = require("./worktree");
const { buildSuggestedPrompts } = require("./blocks");
const { handleClaudeStream } = require("./stream-handler");

const ALLOWED_USERS = new Set(
  (process.env.ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

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
 * Create the Assistant instance.
 *
 * @param {Map} activeProcesses
 * @param {{ value: string|null }} cachedTeamIdRef
 * @returns {Assistant}
 */
function createAssistant(activeProcesses, cachedTeamIdRef, cachedBotUserIdRef) {
  return new Assistant({
    threadStarted: async ({ event, setSuggestedPrompts }) => {
      const threadTs = event.assistant_thread?.thread_ts;
      log(null, `Assistant threadStarted: thread=${threadTs}`);

      const session = threadTs ? getSession(threadTs) : null;
      try {
        await setSuggestedPrompts(buildSuggestedPrompts(session?.cwd));
      } catch (err) {
        logErr(null, `Failed to set suggested prompts: ${err.message}`);
      }
    },

    userMessage: async ({ message, client, say, setStatus, setTitle, setSuggestedPrompts }) => {
      const channelId = message.channel;
      const threadTs = message.thread_ts || message.ts;
      const userText = message.text;

      log(channelId, `Assistant userMessage: user=${message.user} ts=${message.ts} thread_ts=${threadTs} text="${userText}"`);

      // ── Guards ──────────────────────────────────────────
      if (message.subtype || message.bot_id) {
        log(channelId, `Skipping: subtype=${message.subtype} bot_id=${message.bot_id}`);
        return;
      }

      if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(message.user)) {
        log(channelId, `Blocked unauthorized user=${message.user}`);
        return;
      }

      // ── $cwd command ────────────────────────────────────
      if (userText?.match(/^\$cwd(\s|$)/i)) {
        const pathArg = userText.replace(/^\$cwd\s*/i, "").trim();

        if (pathArg) {
          if (!getSession(threadTs)) {
            upsertSession(threadTs, "pending");
          }
          setCwd(threadTs, pathArg);
          addCwdHistory(pathArg);
          log(channelId, `CWD set via $cwd to: ${pathArg}`);
          try {
            await say(`Working directory set to \`${pathArg}\``);
            // Update suggested prompts with CWD context
            await setSuggestedPrompts(buildSuggestedPrompts(pathArg));
          } catch (err) {
            logErr(channelId, `Failed to send CWD confirmation: ${err.message}`);
          }
          return;
        }

        // Bare $cwd — show interactive directory picker
        const history = getCwdHistory();
        log(channelId, `$cwd picker requested, history_count=${history.length}`);

        const blocks = [
          { type: "header", text: { type: "plain_text", text: "Set Working Directory" } },
          { type: "divider" },
        ];

        if (history.length > 0) {
          blocks.push(
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
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            blocks,
            text: "Set working directory",
          });
          log(channelId, `$cwd picker sent`);
        } catch (err) {
          logErr(channelId, `Failed to send $cwd picker: ${err.message}`);
        }
        return;
      }

      // ── $teach command ──────────────────────────────────
      if (userText?.match(/^\$teach(\s|$)/i)) {
        const teachArg = userText.replace(/^\$teach\s*/i, "").trim();
        log(channelId, `$teach command: arg="${teachArg || "(empty)"}" user=${message.user}`);

        if (!teachArg || teachArg === "help") {
          log(channelId, `$teach: showing help`);
          try {
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              blocks: [
                { type: "header", text: { type: "plain_text", text: "Team Knowledge Base" } },
                { type: "divider" },
                { type: "section", text: { type: "mrkdwn", text: "*Usage:*\n\u2022 `$teach <instruction>` \u2014 add a team convention\n\u2022 `$teach list` \u2014 view all active teachings\n\u2022 `$teach remove <id>` \u2014 remove a teaching by ID" } },
                { type: "context", elements: [{ type: "mrkdwn", text: "Teachings are injected into every Claude session as team conventions." }] },
              ],
              text: "Team Knowledge Base help",
            });
          } catch (err) {
            logErr(channelId, `$teach help: failed: ${err.message}`);
          }
          return;
        }

        if (teachArg === "list") {
          const teachings = getTeachings("default");
          log(channelId, `$teach list: ${teachings.length} active teachings`);
          if (teachings.length === 0) {
            try {
              await say("No teachings yet. Add one with `$teach <instruction>`.");
            } catch (err) {
              logErr(channelId, `$teach list (empty): failed: ${err.message}`);
            }
            return;
          }
          const list = teachings.map((t) => `*#${t.id}* \u2014 ${t.instruction} _(added by <@${t.added_by}>)_`).join("\n");
          try {
            await client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              blocks: [
                { type: "header", text: { type: "plain_text", text: "Team Teachings" } },
                { type: "divider" },
                { type: "section", text: { type: "mrkdwn", text: list } },
                { type: "context", elements: [{ type: "mrkdwn", text: `${teachings.length} active teaching(s)` }] },
              ],
              text: `${teachings.length} teachings`,
            });
          } catch (err) {
            logErr(channelId, `$teach list: failed: ${err.message}`);
          }
          return;
        }

        const removeMatch = teachArg.match(/^remove\s+(\d+)$/i);
        if (removeMatch) {
          const id = parseInt(removeMatch[1], 10);
          log(channelId, `$teach remove: id=${id}`);
          removeTeaching(id);
          try {
            await say(`Teaching #${id} removed.`);
          } catch (err) {
            logErr(channelId, `$teach remove: failed: ${err.message}`);
          }
          return;
        }

        // $teach <instruction>
        const instruction = teachArg.replace(/^["']|["']$/g, "");
        log(channelId, `$teach add: "${instruction}" user=${message.user}`);
        addTeaching(instruction, message.user);
        const count = getTeachingCount("default");
        log(channelId, `$teach: now ${count.count} active teaching(s)`);
        try {
          await say(`Learned: _${instruction}_\n(${count.count} active teaching${count.count !== 1 ? "s" : ""})`);
        } catch (err) {
          logErr(channelId, `$teach add: failed: ${err.message}`);
        }
        return;
      }

      // ── Guard: already processing ─────────────────────
      if (activeProcesses.has(threadTs)) {
        const existing = activeProcesses.get(threadTs);
        log(channelId, `Rejecting — already processing (pid=${existing.pid})`);
        await say("Still processing the previous message...");
        return;
      }

      // ── Session lookup ────────────────────────────────
      const session = getSession(threadTs);
      let sessionId;
      let isResume = false;

      if (session && session.session_id && session.session_id !== "pending") {
        sessionId = session.session_id;
        isResume = true;
        log(channelId, `Resuming session: ${sessionId}`);
      } else {
        sessionId = randomUUID();
        if (!session) {
          upsertSession(threadTs, "pending");
        }
        log(channelId, `New session: ${sessionId}`);
      }

      // ── CWD gate ──────────────────────────────────────
      const currentSession = getSession(threadTs);
      if (!currentSession?.cwd) {
        log(channelId, `No CWD set, blocking`);
        try {
          await say("No working directory set. Send `$cwd` to pick one, or `$cwd /path/to/dir` to set directly.");
          await setSuggestedPrompts(buildSuggestedPrompts(null));
        } catch (err) {
          logErr(channelId, `CWD gating: failed: ${err.message}`);
        }
        return;
      }

      // ── Set thread title from first message ───────────
      if (!isResume) {
        const titleText = userText.length > 60 ? userText.slice(0, 57) + "..." : userText;
        try {
          await setTitle(titleText);
          log(channelId, `Thread title set: "${titleText}"`);
        } catch (err) {
          logErr(channelId, `Failed to set title: ${err.message}`);
        }
      }

      // ── Worktree setup ────────────────────────────────
      let spawnCwd = currentSession.cwd;
      const existingWt = getWorktree(threadTs);
      log(channelId, `Worktree lookup: thread=${threadTs} existingWt=${existingWt ? `path=${existingWt.worktree_path} cleaned=${existingWt.cleaned_up}` : "none"}`);

      if (existingWt && !existingWt.cleaned_up) {
        spawnCwd = existingWt.worktree_path;
        touchWorktree(threadTs);
        log(channelId, `Reusing worktree: ${spawnCwd}`);
      } else {
        const gitInfo = detectGitRepo(currentSession.cwd);
        log(channelId, `Git detection: cwd=${currentSession.cwd} isGit=${gitInfo.isGit} repoRoot=${gitInfo.repoRoot}`);
        if (gitInfo.isGit) {
          try {
            const { worktreePath, branchName } = createWorktree(gitInfo.repoRoot, threadTs);
            copyEnvFiles(currentSession.cwd, worktreePath);
            upsertWorktree(threadTs, gitInfo.repoRoot, worktreePath, branchName);
            spawnCwd = worktreePath;
            log(channelId, `Created worktree: ${worktreePath} branch=${branchName}`);
          } catch (err) {
            logErr(channelId, `Worktree creation failed, using raw CWD: ${err.message}`);
          }
        } else {
          log(channelId, `Not a git repo, using raw CWD: ${spawnCwd}`);
        }
      }

      // ── Delegate to stream handler ────────────────────
      await handleClaudeStream({
        channelId,
        threadTs,
        userText,
        userId: message.user,
        client,
        spawnCwd,
        isResume,
        sessionId,
        setStatus,
        activeProcesses,
        cachedTeamId: cachedTeamIdRef.value,
        botUserId: cachedBotUserIdRef.value,
      });
    },
  });
}

module.exports = { createAssistant };
