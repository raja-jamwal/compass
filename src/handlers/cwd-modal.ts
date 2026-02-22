import { log } from "../lib/log.ts";

interface CwdModalDeps {
  addCwdHistory: (path: string) => void;
  setChannelDefault: (channelId: string, cwd: string, setBy: string) => void;
  getSession: (key: string) => unknown;
  upsertSession: (key: string, sessionId: string) => void;
  setCwd: (key: string, cwd: string) => void;
  markWorktreeCleaned: (key: string) => void;
}

export function createCwdModalHandler(deps: CwdModalDeps) {
  return async ({ view, ack, client, body }: any) => {
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

    deps.addCwdHistory(chosenPath);
    if (isTopLevel) {
      deps.setChannelDefault(channelId, chosenPath, body.user.id);
      log(channelId, `Channel default CWD set to: ${chosenPath}`);
      if (threadTs) {
        if (!deps.getSession(threadTs)) deps.upsertSession(threadTs, "pending");
        deps.setCwd(threadTs, chosenPath);
        deps.upsertSession(threadTs, "pending");
        deps.markWorktreeCleaned(threadTs);
      }
    } else {
      const sessionKey = threadTs || channelId;
      if (!deps.getSession(sessionKey)) deps.upsertSession(sessionKey, "pending");
      deps.setCwd(sessionKey, chosenPath);
      deps.upsertSession(sessionKey, "pending");
      deps.markWorktreeCleaned(sessionKey);
      log(channelId, `CWD set to: ${chosenPath} (thread=${threadTs}, session reset)`);
    }

    const confirmText = isTopLevel
      ? `Working directory set to \`${chosenPath}\` (default for this channel)`
      : `Working directory set to \`${chosenPath}\``;
    await client.chat.postEphemeral({
      channel: channelId,
      thread_ts: threadTs,
      user: body.user.id,
      text: confirmText,
    });
  };
}
