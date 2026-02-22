import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createCwdModalHandler } from "./cwd-modal.ts";

function makeDeps(overrides = {}) {
  return {
    addCwdHistory: mock(() => {}),
    setChannelDefault: mock(() => {}),
    getSession: mock(() => null),
    upsertSession: mock(() => {}),
    setCwd: mock(() => {}),
    markWorktreeCleaned: mock(() => {}),
    ...overrides,
  };
}

function makeView({ inputVal, selectVal, channelId = "C123", threadTs, isTopLevel = true }: {
  inputVal?: string;
  selectVal?: string;
  channelId?: string;
  threadTs?: string;
  isTopLevel?: boolean;
}) {
  return {
    private_metadata: JSON.stringify({ channelId, threadTs, isTopLevel }),
    state: {
      values: {
        cwd_input_block: { cwd_input: { value: inputVal ?? null } },
        cwd_select_block: { cwd_select: { selected_option: selectVal ? { value: selectVal } : null } },
      },
    },
  };
}

function makeArgs(view: any, userId = "U456") {
  return {
    view,
    ack: mock(() => Promise.resolve()),
    client: { chat: { postEphemeral: mock(() => Promise.resolve({ ok: true })) } },
    body: { user: { id: userId } },
  };
}

describe("cwd_modal handler", () => {
  it("uses body.user.id (not view.user) for postEphemeral", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/projects/foo", isTopLevel: true });
    const args = makeArgs(view, "U_REAL_USER");

    await handler(args);

    expect(args.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ user: "U_REAL_USER" }),
    );
  });

  it("uses body.user.id for setChannelDefault on top-level", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/code", isTopLevel: true });
    const args = makeArgs(view, "U789");

    await handler(args);

    expect(deps.setChannelDefault).toHaveBeenCalledWith("C123", "/code", "U789");
  });

  it("returns validation error when no path is provided", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({});
    const args = makeArgs(view);

    await handler(args);

    expect(args.ack).toHaveBeenCalledWith({
      response_action: "errors",
      errors: { cwd_input_block: "Please enter a path or select one from the dropdown." },
    });
    expect(args.client.chat.postEphemeral).not.toHaveBeenCalled();
  });

  it("prefers text input over select", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/typed/path", selectVal: "/selected/path", isTopLevel: true });
    const args = makeArgs(view);

    await handler(args);

    expect(deps.addCwdHistory).toHaveBeenCalledWith("/typed/path");
    expect(args.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("/typed/path") }),
    );
  });

  it("falls back to select value when input is empty", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ selectVal: "/selected/path", isTopLevel: true });
    const args = makeArgs(view);

    await handler(args);

    expect(deps.addCwdHistory).toHaveBeenCalledWith("/selected/path");
  });

  it("sets thread CWD when top-level with threadTs", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/code", isTopLevel: true, threadTs: "T100" });
    const args = makeArgs(view);

    await handler(args);

    expect(deps.setChannelDefault).toHaveBeenCalled();
    expect(deps.upsertSession).toHaveBeenCalledWith("T100", "pending");
    expect(deps.setCwd).toHaveBeenCalledWith("T100", "/code");
    expect(deps.markWorktreeCleaned).toHaveBeenCalledWith("T100");
  });

  it("uses threadTs as session key for non-top-level", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/code", isTopLevel: false, threadTs: "T200" });
    const args = makeArgs(view);

    await handler(args);

    expect(deps.setChannelDefault).not.toHaveBeenCalled();
    expect(deps.setCwd).toHaveBeenCalledWith("T200", "/code");
    expect(deps.markWorktreeCleaned).toHaveBeenCalledWith("T200");
  });

  it("falls back to channelId as session key when no threadTs", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/code", isTopLevel: false, channelId: "C999" });
    const args = makeArgs(view);

    await handler(args);

    expect(deps.setCwd).toHaveBeenCalledWith("C999", "/code");
  });

  it("skips upsertSession if session already exists", async () => {
    const deps = makeDeps({ getSession: mock(() => ({ channel_id: "T300", session_id: "existing" })) });
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/code", isTopLevel: false, threadTs: "T300" });
    const args = makeArgs(view);

    await handler(args);

    // upsertSession should only be called once (the reset), not for initial creation
    const calls = (deps.upsertSession as any).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["T300", "pending"]);
  });

  it("sends ephemeral with correct channel and thread_ts", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/code", isTopLevel: false, channelId: "C555", threadTs: "T555" });
    const args = makeArgs(view, "U111");

    await handler(args);

    expect(args.client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C555",
      thread_ts: "T555",
      user: "U111",
      text: "Working directory set to `/code`",
    });
  });

  it("shows 'default for this channel' text for top-level", async () => {
    const deps = makeDeps();
    const handler = createCwdModalHandler(deps);
    const view = makeView({ inputVal: "/code", isTopLevel: true });
    const args = makeArgs(view);

    await handler(args);

    expect(args.client.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("default for this channel") }),
    );
  });
});
