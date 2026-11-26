import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pstackExtension from "../extensions/pstack/index.ts";
import { preferredAskTool } from "../extensions/pstack/interaction.ts";

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type Entry = { type: string; customType?: string; data?: unknown };

function createMockHost(activeTools: string[] = []) {
  const handlers = new Map<string, EventHandler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const statusCalls: Array<{ key: string; value: string | undefined }> = [];

  const api = {
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
    getActiveTools() {
      return activeTools;
    },
  };

  function makeCtx(options: { hasUI?: boolean; entries?: Entry[]; ui?: Record<string, unknown> } = {}) {
    return {
      hasUI: options.hasUI ?? false,
      sessionManager: {
        getBranch() {
          return options.entries ?? [];
        },
      },
      ui: {
        setStatus(key: string, value: string | undefined) {
          statusCalls.push({ key, value });
        },
        ...options.ui,
      },
    };
  }

  return {
    api: api as unknown as ExtensionAPI,
    handlers,
    appended,
    statusCalls,
    makeCtx,
    async emit(eventName: string, event: unknown, ctx: unknown) {
      const list = handlers.get(eventName) ?? [];
      let last: unknown;
      for (const handler of list) last = await handler(event, ctx);
      return last;
    },
  };
}

function modeEntry(enabled: boolean): Entry {
  return { type: "custom", customType: "pstack-mode", data: { enabled } };
}

const RESET: Entry = { type: "reset_boundary" };
const ENABLED: Entry[] = [modeEntry(true)];
const DISABLED: Entry[] = [modeEntry(false)];

function injected(result: unknown): string[] | undefined {
  return (result as { systemPrompt?: string[] } | undefined)?.systemPrompt;
}

describe("interaction", () => {
  test("preferredAskTool detects active ask tool", () => {
    expect(preferredAskTool({})).toBeUndefined();
    expect(preferredAskTool({ getActiveTools: () => ["read", "bash"] })).toBeUndefined();
    expect(preferredAskTool({ getActiveTools: () => ["read", "ask", "bash"] })).toBe("ask");
  });
});

describe("pstackExtension", () => {
  test("tracks sticky Poteto Mode and keeps system prompt segments", async () => {
    const host = createMockHost(["read", "ask"]);
    pstackExtension(host.api);

    const noUi = host.makeCtx({ hasUI: false });
    expect(await host.emit("before_agent_start", { systemPrompt: ["BASE"] }, noUi)).toBeUndefined();

    const ui = host.makeCtx({ hasUI: true });
    expect(await host.emit("before_agent_start", { systemPrompt: ["BASE", "TAIL"] }, ui)).toEqual({
      systemPrompt: ["BASE", "TAIL", "When you need user input, use the ask tool."],
    });

    await host.emit("input", { text: "/skill:poteto-mode-other" }, noUi);
    expect(host.appended).toEqual([]);

    await host.emit("input", { text: "/skill:poteto-mode" }, noUi);
    await host.emit("input", { text: "/skill:poteto-mode fix the bug" }, noUi);
    expect(host.appended).toEqual([
      { customType: "pstack-mode", data: { enabled: true } },
      { customType: "pstack-mode", data: { enabled: true } },
    ]);

    const result = await host.emit("before_agent_start", { systemPrompt: ["BASE", "TAIL"] }, noUi);
    const prompt = injected(result);
    expect(prompt?.slice(0, 2)).toEqual(["BASE", "TAIL"]);
    expect(prompt).toHaveLength(3);
    expect(prompt?.[2]).toContain("Pstack Poteto Mode is enabled for this session.");
    expect(prompt?.[2]).toContain("Read the full skill at");
    expect(prompt?.[2]).toContain(path.join("skills", "poteto-mode", "SKILL.md"));
  });

  test("updates status immediately when the skill command is submitted", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    await host.emit("input", { text: "/skill:poteto-mode do the work" }, ctx);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });
    expect(host.appended).toEqual([{ customType: "pstack-mode", data: { enabled: true } }]);
  });

  test("restores state across session switches", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const enabledCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    const emptyCtx = host.makeCtx({ hasUI: true, entries: [] });

    await host.emit("session_start", {}, enabledCtx);
    expect(injected(await host.emit("before_agent_start", { systemPrompt: ["A"] }, enabledCtx))).toHaveLength(2);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });

    await host.emit("session_switch", { reason: "resume" }, emptyCtx);
    expect(await host.emit("before_agent_start", { systemPrompt: ["A"] }, emptyCtx)).toBeUndefined();
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });

    await host.emit("session_switch", { reason: "resume" }, enabledCtx);
    expect(injected(await host.emit("before_agent_start", { systemPrompt: ["A"] }, enabledCtx))).toHaveLength(2);
  });

  test("restores state on branch and tree navigation", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const enabledCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    const disabledCtx = host.makeCtx({ hasUI: true, entries: DISABLED });

    await host.emit("session_start", {}, enabledCtx);
    await host.emit("session_branch", { reason: "branch" }, disabledCtx);
    expect(await host.emit("before_agent_start", { systemPrompt: ["A"] }, disabledCtx)).toBeUndefined();
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });

    await host.emit("session_tree", { newLeafId: "x", oldLeafId: "y" }, enabledCtx);
    expect(injected(await host.emit("before_agent_start", { systemPrompt: ["A"] }, enabledCtx))).toHaveLength(2);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });
  });

  test("does not revive Poteto Mode across a reset boundary", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const clearedCtx = host.makeCtx({ hasUI: true, entries: [...ENABLED, RESET] });

    await host.emit("session_clear", {}, clearedCtx);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });
    expect(await host.emit("before_agent_start", { systemPrompt: ["A"] }, clearedCtx)).toBeUndefined();

    await host.emit("session_start", {}, clearedCtx);
    expect(await host.emit("before_agent_start", { systemPrompt: ["A"] }, clearedCtx)).toBeUndefined();

    const reenabledCtx = host.makeCtx({ hasUI: true, entries: [...ENABLED, RESET, ...ENABLED] });
    await host.emit("session_start", {}, reenabledCtx);
    expect(injected(await host.emit("before_agent_start", { systemPrompt: ["A"] }, reenabledCtx))).toHaveLength(2);
  });

  test("ignores malformed mode entry data", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const invalid = [undefined, null, "true", 123, [], { enabled: "true" }];

    for (const data of invalid) {
      const ctx = host.makeCtx({
        hasUI: true,
        entries: [{ type: "custom", customType: "pstack-mode", data }],
      });
      await host.emit("session_start", {}, ctx);
      expect(await host.emit("before_agent_start", { systemPrompt: ["A"] }, ctx)).toBeUndefined();
      expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });
    }

    const enabledCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, enabledCtx);
    expect(injected(await host.emit("before_agent_start", { systemPrompt: ["A"] }, enabledCtx))).toHaveLength(2);
  });

  test("restores the newest mode marker", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: [modeEntry(true), modeEntry(false)] });

    await host.emit("session_start", {}, ctx);
    expect(await host.emit("before_agent_start", { systemPrompt: ["A"] }, ctx)).toBeUndefined();
  });

  test("ignores mode markers on non-custom entries", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({
      hasUI: true,
      entries: [{ type: "message", customType: "pstack-mode", data: { enabled: true } }],
    });

    await host.emit("session_start", {}, ctx);
    expect(await host.emit("before_agent_start", { systemPrompt: ["A"] }, ctx)).toBeUndefined();
  });
});
