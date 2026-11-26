import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import pstackExtension from "../extensions/pstack/index.ts";
import { preferredAskTool } from "../extensions/pstack/interaction.ts";

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type Entry = {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  firstKeptEntryId?: string;
  content?: unknown;
  display?: boolean;
};
type Command = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
};
type Message = {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  timestamp?: number;
};

function createMockHost(activeTools: string[] = []) {
  const handlers = new Map<string, EventHandler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const statusCalls: Array<{ key: string; value: string | undefined }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const commands = new Map<string, Command>();
  const sent: Array<{ content: string | unknown[]; options?: unknown }> = [];
  let sendError: Error | undefined;

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
    registerCommand(name: string, options: Command) {
      commands.set(name, options);
    },
    async sendUserMessage(content: string | unknown[], options?: unknown) {
      if (sendError) throw sendError;
      sent.push({ content, options });
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
        notify(message: string, type?: string) {
          notifications.push({ message, type });
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
    notifications,
    commands,
    sent,
    makeCtx,
    failSends(error: Error) {
      sendError = error;
    },
    async emit(eventName: string, event: unknown, ctx: unknown) {
      const list = handlers.get(eventName) ?? [];
      let last: unknown;
      for (const handler of list) last = await handler(event, ctx);
      return last;
    },
    async runCommand(name: string, args: string, ctx: unknown) {
      const command = commands.get(name);
      if (!command) throw new Error(`missing command ${name}`);
      return command.handler(args, ctx);
    },
  };
}

function modeEntry(enabled: boolean): Entry {
  return { type: "custom", customType: "pstack-mode", data: { enabled } };
}

function contextEntry(id = "ctx"): Entry {
  return { type: "custom_message", id, customType: "pstack-mode-context", content: "old", display: false };
}

const RESET: Entry = { type: "reset_boundary" };
const ENABLED: Entry[] = [modeEntry(true)];
const DISABLED: Entry[] = [modeEntry(false)];

function contextMessage(overrides: Partial<Message> = {}): Message {
  return {
    role: "custom",
    customType: "pstack-mode-context",
    content: "old",
    display: false,
    timestamp: 1,
    ...overrides,
  };
}

function userMessage(content = "hello"): Message {
  return { role: "user", content, timestamp: 2 };
}

function injected(
  result: unknown,
): { message?: { customType?: string; content?: string; display?: boolean }; systemPrompt?: unknown } | undefined {
  return result as
    | { message?: { customType?: string; content?: string; display?: boolean }; systemPrompt?: unknown }
    | undefined;
}

function messagesOf(result: unknown): Message[] {
  return (result as { messages: Message[] }).messages;
}

describe("interaction", () => {
  test("preferredAskTool detects active ask tool", () => {
    expect(preferredAskTool({ getActiveTools: () => ["read", "ask"] })).toBe("ask");
    expect(preferredAskTool({ getActiveTools: () => ["read", "bash"] })).toBeUndefined();
    expect(preferredAskTool({ getActiveTools: () => ["read", "ask", "bash"] })).toBe("ask");
    expect(preferredAskTool({})).toBeUndefined();
  });
});

describe("pstackExtension", () => {
  test("sticky command enables the mode without sending a message", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    await host.runCommand("poteto-mode", "sticky", ctx);

    expect(host.appended).toEqual([{ customType: "pstack-mode", data: { enabled: true } }]);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });
    expect(host.sent).toEqual([]);
    expect(host.notifications.at(-1)?.message).toBe("Poteto Mode sticky enabled for this session.");
  });

  test("repeated sticky does not append twice", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    await host.runCommand("poteto-mode", "sticky", ctx);
    await host.runCommand("poteto-mode", "sticky", ctx);

    expect(host.appended).toHaveLength(1);
    expect(host.notifications.at(-1)?.message).toBe("Poteto Mode sticky is already enabled.");
  });

  test("off disables the mode and filters the context message", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, ctx);

    expect(messagesOf(await host.emit("context", { messages: [userMessage()] }, ctx))).toHaveLength(2);

    await host.runCommand("poteto-mode", "off", ctx);
    expect(host.appended.at(-1)).toEqual({ customType: "pstack-mode", data: { enabled: false } });
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });

    expect(messagesOf(await host.emit("context", { messages: [contextMessage(), userMessage()] }, ctx))).toEqual([
      userMessage(),
    ]);
  });

  test("status reports on and off", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const onCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, onCtx);
    await host.runCommand("poteto-mode", "status", onCtx);
    expect(host.notifications.at(-1)?.message).toBe("Poteto Mode sticky is enabled.");

    const offCtx = host.makeCtx({ hasUI: true, entries: [] });
    await host.emit("session_start", {}, offCtx);
    await host.runCommand("poteto-mode", "status", offCtx);
    expect(host.notifications.at(-1)?.message).toBe("Poteto Mode sticky is disabled.");
  });

  test("empty arguments show usage without enabling", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    await host.runCommand("poteto-mode", "", ctx);

    expect(host.appended).toEqual([]);
    expect(host.notifications.at(-1)?.message).toContain("Poteto Mode sticky is disabled.");
    expect(host.notifications.at(-1)?.message).toContain("/poteto-mode sticky");
  });

  test("input rewrites a one-shot task and leaves control words alone", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    expect(await host.emit("input", { text: "/poteto-mode fix the bug" }, ctx)).toEqual({
      text: "/skill:poteto-mode fix the bug",
    });
    expect(await host.emit("input", { text: "/poteto-mode" }, ctx)).toBeUndefined();
    expect(await host.emit("input", { text: "/poteto-mode sticky" }, ctx)).toBeUndefined();
    expect(await host.emit("input", { text: "/poteto-mode off" }, ctx)).toBeUndefined();
    expect(await host.emit("input", { text: "/poteto-mode status" }, ctx)).toBeUndefined();
    expect(await host.emit("input", { text: "/poteto-mode disable" }, ctx)).toBeUndefined();
    expect(await host.emit("input", { text: "/poteto-mode stop" }, ctx)).toBeUndefined();
    expect(await host.emit("input", { text: "/poteto-mode-other" }, ctx)).toBeUndefined();
    expect(await host.emit("input", { text: "/skill:poteto-mode fix the bug" }, ctx)).toBeUndefined();
    expect(host.appended).toEqual([]);
    expect(host.statusCalls).toEqual([]);
  });

  test("before_agent_start returns a hidden context message", async () => {
    const host = createMockHost(["read", "ask"]);
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, ctx);

    const result = injected(
      await host.emit("before_agent_start", { prompt: "x", systemPrompt: ["BASE"] }, ctx),
    );

    expect(result?.systemPrompt).toBeUndefined();
    expect(result?.message?.customType).toBe("pstack-mode-context");
    expect(result?.message?.display).toBe(false);
    expect(result?.message?.content).toContain("Skill file:");
    expect(result?.message?.content).toContain("Skill directory:");
    expect(result?.message?.content).toContain("SKILL-INDEX.md");
    expect(result?.message?.content).toContain("# Poteto mode");
    expect(result?.message?.content).toContain("When you need user input, use the ask tool.");
  });

  test("before_agent_start omits the ask hint without UI or the ask tool", async () => {
    const noUiHost = createMockHost(["read", "ask"]);
    pstackExtension(noUiHost.api);
    const noUiCtx = noUiHost.makeCtx({ hasUI: false, entries: ENABLED });
    await noUiHost.emit("session_start", {}, noUiCtx);
    expect(injected(await noUiHost.emit("before_agent_start", {}, noUiCtx))?.message?.content).not.toContain(
      "When you need user input",
    );

    const noAskHost = createMockHost(["read"]);
    pstackExtension(noAskHost.api);
    const noAskCtx = noAskHost.makeCtx({ hasUI: true, entries: ENABLED });
    await noAskHost.emit("session_start", {}, noAskCtx);
    expect(injected(await noAskHost.emit("before_agent_start", {}, noAskCtx))?.message?.content).not.toContain(
      "When you need user input",
    );
  });

  test("context preserves an existing message and filters only its own type", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, ctx);

    const existing = contextMessage();
    const user = userMessage();
    const on = messagesOf(await host.emit("context", { messages: [existing, user] }, ctx));
    expect(on).toEqual([existing, user]);
    expect(on[0]).toBe(existing);

    const offCtx = host.makeCtx({ hasUI: true, entries: DISABLED });
    await host.emit("session_start", {}, offCtx);
    expect(messagesOf(await host.emit("context", { messages: [existing, user] }, offCtx))).toEqual([user]);
  });

  test("context inserts at the stable prefix and memoizes the message", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, ctx);
    const user = userMessage();

    const first = messagesOf(await host.emit("context", { messages: [user] }, ctx));
    expect(first).toHaveLength(2);
    expect(first[0]?.role).toBe("custom");
    expect(first[1]).toBe(user);

    const second = messagesOf(await host.emit("context", { messages: [user] }, ctx));
    expect(second[0]).toBe(first[0]);
    expect(second[0]?.timestamp).toBe(first[0]?.timestamp);

    const summary: Message = { role: "compactionSummary", content: "summary", timestamp: 3 };
    const third = messagesOf(await host.emit("context", { messages: [summary, user] }, ctx));
    expect(third[0]).toBe(summary);
    expect(third[1]?.role).toBe("custom");
    expect(third[2]).toBe(user);
  });

  test("compaction keeps an existing context message in the effective section", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({
      hasUI: true,
      entries: [contextEntry(), modeEntry(true), { type: "compaction", id: "c", firstKeptEntryId: "ctx" }],
    });
    await host.emit("session_start", {}, ctx);

    expect(await host.emit("before_agent_start", {}, ctx)).toBeUndefined();
  });

  test("context does not duplicate a message returned by before_agent_start", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, ctx);

    const prepared = injected(await host.emit("before_agent_start", {}, ctx));
    const injectedMessage: Message = {
      role: "custom",
      customType: prepared?.message?.customType,
      content: prepared?.message?.content,
      display: false,
      timestamp: 10,
    };
    const user = userMessage();

    expect(messagesOf(await host.emit("context", { messages: [injectedMessage, user] }, ctx))).toEqual([
      injectedMessage,
      user,
    ]);
  });

  test("restores state across session switches", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const enabledCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    const emptyCtx = host.makeCtx({ hasUI: true, entries: [] });

    await host.emit("session_start", {}, enabledCtx);
    expect(injected(await host.emit("before_agent_start", {}, enabledCtx))).toBeDefined();
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });

    await host.emit("session_switch", { reason: "resume" }, emptyCtx);
    expect(await host.emit("before_agent_start", {}, emptyCtx)).toBeUndefined();
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });

    await host.emit("session_switch", { reason: "resume" }, enabledCtx);
    expect(injected(await host.emit("before_agent_start", {}, enabledCtx))).toBeDefined();
  });

  test("restores state on branch and tree navigation", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const enabledCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    const disabledCtx = host.makeCtx({ hasUI: true, entries: DISABLED });

    await host.emit("session_start", {}, enabledCtx);
    await host.emit("session_branch", { reason: "branch" }, disabledCtx);
    expect(await host.emit("before_agent_start", {}, disabledCtx)).toBeUndefined();
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });

    await host.emit("session_tree", { newLeafId: "x", oldLeafId: "y" }, enabledCtx);
    expect(injected(await host.emit("before_agent_start", {}, enabledCtx))).toBeDefined();
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });
  });

  test("does not revive Poteto Mode across a reset boundary", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const clearedCtx = host.makeCtx({ hasUI: true, entries: [...ENABLED, RESET] });

    await host.emit("session_clear", {}, clearedCtx);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });
    expect(await host.emit("before_agent_start", {}, clearedCtx)).toBeUndefined();

    await host.emit("session_start", {}, clearedCtx);
    expect(await host.emit("before_agent_start", {}, clearedCtx)).toBeUndefined();

    const reenabledCtx = host.makeCtx({ hasUI: true, entries: [...ENABLED, RESET, ...ENABLED] });
    await host.emit("session_start", {}, reenabledCtx);
    expect(injected(await host.emit("before_agent_start", {}, reenabledCtx))).toBeDefined();
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
      expect(await host.emit("before_agent_start", {}, ctx)).toBeUndefined();
      expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: undefined });
    }
  });

  test("restores the newest mode marker", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: [modeEntry(true), modeEntry(false)] });

    await host.emit("session_start", {}, ctx);
    expect(await host.emit("before_agent_start", {}, ctx)).toBeUndefined();
  });

  test("ignores mode markers on non-custom entries", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({
      hasUI: true,
      entries: [{ type: "message", customType: "pstack-mode", data: { enabled: true } }],
    });

    await host.emit("session_start", {}, ctx);
    expect(await host.emit("before_agent_start", {}, ctx)).toBeUndefined();
  });

  test("missing skill file leaves sticky off and injects nothing", async () => {
    const host = createMockHost();
    pstackExtension(host.api, { skillFile: path.join(tmpdir(), "missing-pstack-skill.md") });
    const ctx = host.makeCtx({ hasUI: true });

    await host.runCommand("poteto-mode", "sticky", ctx);

    expect(host.appended).toEqual([]);
    expect(host.statusCalls).toEqual([]);
    expect(host.notifications.at(-1)?.message).toContain("pstack skill file not found");
    expect(await host.emit("before_agent_start", {}, ctx)).toBeUndefined();
  });

  test("command fallback sends the skill body for a one-shot task", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    await host.runCommand("poteto-mode", "fix the bug", ctx);

    expect(host.appended).toEqual([]);
    expect(host.sent).toHaveLength(1);
    const content = host.sent[0]?.content;
    if (typeof content !== "string") throw new Error("expected a text prompt");
    expect(content).toContain("[Skill directory:");
    expect(content).toContain("# Poteto mode");
    expect(content).toContain("Task:\nfix the bug");
  });

  test("a failed one-shot reports the error without enabling sticky", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });
    host.failSends(new Error("aborted"));

    await host.runCommand("poteto-mode", "fix the bug", ctx);

    expect(host.appended).toEqual([]);
    expect(host.notifications.at(-1)?.message).toBe("Task was not sent: aborted");
  });

  test("command completions list the control words", () => {
    const host = createMockHost();
    pstackExtension(host.api);

    const command = host.commands.get("poteto-mode");
    expect(command?.getArgumentCompletions?.("s")?.map((item) => item.value)).toEqual(["sticky", "status"]);
  });
});
