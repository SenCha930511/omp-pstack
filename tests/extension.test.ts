import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pstackExtension from "../extensions/pstack/index.ts";
import { preferredAskTool } from "../extensions/pstack/interaction.ts";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

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

  function makeCtx(options: {
    hasUI?: boolean;
    entries?: Array<{ type: string; customType?: string; data?: unknown }>;
    ui?: Record<string, unknown>;
  } = {}) {
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

describe("interaction", () => {
  test("preferredAskTool detects active ask tool", () => {
    expect(preferredAskTool({})).toBeUndefined();
    expect(preferredAskTool({ getActiveTools: () => ["read", "bash"] })).toBeUndefined();
    expect(preferredAskTool({ getActiveTools: () => ["read", "ask", "bash"] })).toBe("ask");
  });
});

describe("pstackExtension", () => {
  test("tracks sticky Poteto Mode and injects prompt sections", async () => {
    const host = createMockHost(["read", "ask"]);
    pstackExtension(host.api);

    const noUiCtx = host.makeCtx({ hasUI: false });
    expect(
      await host.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }, noUiCtx),
    ).toBeUndefined();
    expect(await host.emit("before_agent_start", { systemPrompt: ["BASE"] }, noUiCtx)).toBeUndefined();

    const uiCtx = host.makeCtx({ hasUI: true });
    expect(await host.emit("before_agent_start", { systemPrompt: ["BASE"] }, uiCtx)).toEqual({
      systemPrompt: ["BASE\n\nWhen you need user input, use the ask tool."],
    });

    await host.emit("input", { text: "/skill:poteto-mode-other" }, noUiCtx);
    expect(host.appended).toEqual([]);

    await host.emit("input", { text: "/skill:poteto-mode" }, noUiCtx);
    await host.emit("input", { text: "/skill:poteto-mode fix the bug" }, noUiCtx);
    expect(host.appended).toEqual([
      { customType: "pstack-mode", data: { enabled: true } },
      { customType: "pstack-mode", data: { enabled: true } },
    ]);

    const injected = (await host.emit("before_agent_start", { systemPrompt: ["BASE"] }, noUiCtx)) as {
      systemPrompt: string[];
    };
    expect(injected.systemPrompt[0]).toContain("Pstack Poteto Mode is enabled for this session.");
    expect(injected.systemPrompt[0]).toContain(path.join("skills", "poteto-mode", "SKILL.md"));

    const resumeDisabledCtx = host.makeCtx({
      hasUI: true,
      entries: [
        { type: "message", customType: "pstack-mode", data: { enabled: true } },
        { type: "custom", customType: "pstack-mode", data: { enabled: true } },
        { type: "custom", customType: "pstack-mode", data: { enabled: false } },
      ],
    });
    await host.emit("session_start", {}, resumeDisabledCtx);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });

    const resumeEnabledCtx = host.makeCtx({
      hasUI: true,
      entries: [{ type: "custom", customType: "pstack-mode", data: { enabled: true } }],
    });
    await host.emit("session_start", {}, resumeEnabledCtx);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });
  });
});
