import { describe, test, expect } from "bun:test";
import {
  buildBlocks, buildStopOnlyBlocks, buildFeedbackBlock,
  buildDisclaimerBlock, buildSuggestedPrompts,
} from "../src/ui/blocks.ts";

describe("buildBlocks", () => {
  test("renders text section without stop button", () => {
    const blocks = buildBlocks("Hello world", "thread-1", false);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("section");
    expect(blocks[0].text.text).toBe("Hello world");
  });

  test("renders text section with stop button", () => {
    const blocks = buildBlocks("Hello", "thread-1", true);
    expect(blocks.length).toBe(2);
    expect(blocks[1].type).toBe("actions");
    expect(blocks[1].elements[0].action_id).toBe("stop_claude");
    expect(blocks[1].elements[0].value).toBe("thread-1");
  });

  test("uses space for empty text", () => {
    const blocks = buildBlocks("", "thread-1", false);
    expect(blocks[0].text.text).toBe(" ");
  });
});

describe("buildStopOnlyBlocks", () => {
  test("returns actions block with stop button", () => {
    const blocks = buildStopOnlyBlocks("thread-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("actions");
    expect(blocks[0].elements[0].style).toBe("danger");
    expect(blocks[0].elements[0].value).toBe("thread-1");
  });
});

describe("buildFeedbackBlock", () => {
  test("returns context_actions with feedback buttons", () => {
    const block = buildFeedbackBlock("sess-1");
    expect(block.type).toBe("context_actions");
    expect(block.elements[0].positive_button.value).toBe("positive:sess-1");
    expect(block.elements[0].negative_button.value).toBe("negative:sess-1");
  });
});

describe("buildDisclaimerBlock", () => {
  test("returns context block with disclaimer text", () => {
    const block = buildDisclaimerBlock();
    expect(block.type).toBe("context");
    expect(block.elements[0].text).toContain("Verify important information");
  });
});

describe("buildSuggestedPrompts", () => {
  test("includes 4 prompts", () => {
    const { prompts } = buildSuggestedPrompts(null);
    expect(prompts.length).toBe(4);
    expect(prompts[0].title).toBeDefined();
    expect(prompts[0].message).toBeDefined();
  });

  test("title includes cwd when provided", () => {
    const { title } = buildSuggestedPrompts("/home/project");
    expect(title).toContain("/home/project");
  });

  test("title uses default when cwd is null", () => {
    const { title } = buildSuggestedPrompts(null);
    expect(title).toBe("What would you like to do?");
  });
});
