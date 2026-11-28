import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildSkillPromptMessage,
  convertToLlm,
  isUserInvokedSkillPrompt,
  isUserTurnInitiator,
  SKILL_PROMPT_MESSAGE_TYPE,
  type CustomMessage,
  type ExtensionAPI,
  type SkillPromptDetails,
} from "@oh-my-pi/pi-coding-agent";
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

type ImageAttachment = {
  type: "image";
  data: string;
  mimeType: string;
};

type SlashCommand = {
  name: string;
  source: string;
  path?: string;
};

const DEFAULT_SKILL_COMMANDS: SlashCommand[] = [
  { name: "skill:poteto-mode", source: "skill", path: path.resolve("skills/poteto-mode/SKILL.md") },
];

function createMockHost(
  activeTools: string[] = [],
  options: { omitSendMessage?: boolean; omitGetCommands?: boolean; commands?: SlashCommand[] } = {},
) {
  const registeredCommands = options.commands ?? DEFAULT_SKILL_COMMANDS;
  const handlers = new Map<string, EventHandler[]>();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const statusCalls: Array<{ key: string; value: string | undefined }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const commands = new Map<string, Command>();
  const sent: Array<{ content: string | unknown[]; options?: unknown }> = [];
  const sentCustom: Array<{ message: Record<string, unknown>; options?: unknown }> = [];
  let sendError: Error | undefined;

  const api: Record<string, unknown> = {
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
    registerCommand(name: string, commandOptions: Command) {
      commands.set(name, commandOptions);
    },
    async sendUserMessage(content: string | unknown[], sendOptions?: unknown) {
      if (sendError) throw sendError;
      sent.push({ content, options: sendOptions });
    },
  };

  if (!options.omitGetCommands) {
    api.getCommands = () => registeredCommands;
  }

  if (!options.omitSendMessage) {
    api.sendMessage = (message: Record<string, unknown>, sendOptions?: unknown) => {
      if (sendError) throw sendError;
      sentCustom.push({ message, options: sendOptions });
    };
  }

  function makeCtx(
    ctxOptions: {
      hasUI?: boolean;
      mode?: "tui" | "rpc" | "print" | "json";
      entries?: Entry[];
      ui?: Record<string, unknown>;
      agent?: { kind: "main" | "sub"; id: string; name: string; depth: number };
      cwd?: string;
    } = {},
  ) {
    return {
      hasUI: ctxOptions.hasUI ?? false,
      cwd: ctxOptions.cwd ?? process.cwd(),
      mode: ctxOptions.mode ?? "tui",
      agent: ctxOptions.agent ?? { kind: "main" as const, id: "main", name: "main", depth: 0 },
      sessionManager: {
        getBranch() {
          return ctxOptions.entries ?? [];
        },
      },
      ui: {
        setStatus(key: string, value: string | undefined) {
          statusCalls.push({ key, value });
        },
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
        ...ctxOptions.ui,
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
    sentCustom,
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

async function dispatchLikeHost(
  host: ReturnType<typeof createMockHost>,
  text: string,
  ctx: unknown,
  images?: ImageAttachment[],
): Promise<{ kind: "command" | "skill" | "handled" | "prompt"; text: string }> {
  const input = await host.emit("input", { text, ...(images ? { images } : {}), source: "interactive" }, ctx);
  if (input && typeof input === "object" && "handled" in input && (input as { handled?: boolean }).handled) {
    return { kind: "handled", text };
  }
  const routed = input && typeof input === "object" && "text" in input ? (input as { text: string }).text : text;
  if (routed.startsWith("/skill:")) return { kind: "skill", text: routed };
  const commandName = routed.startsWith("/") ? routed.slice(1).split(/\s+/, 1)[0] : undefined;
  if (commandName && host.commands.has(commandName)) {
    await host.runCommand(commandName, routed.slice(commandName.length + 1).trim(), ctx);
    return { kind: "command", text: routed };
  }
  return { kind: "prompt", text: routed };
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

  test("input rewrites a one-shot task to /skill:poteto-mode and leaves control words alone", async () => {
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

  test("one-shot input reaches the native skill path when registered", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    const oneShot = await dispatchLikeHost(host, "/poteto-mode fix the bug", ctx);
    expect(oneShot).toEqual({ kind: "skill", text: "/skill:poteto-mode fix the bug" });
    expect(host.sent).toEqual([]);
    expect(host.sentCustom).toEqual([]);
    expect(host.appended).toEqual([]);

    const control = await dispatchLikeHost(host, "/poteto-mode sticky", ctx);
    expect(control.kind).toBe("command");
    expect(host.appended).toEqual([{ customType: "pstack-mode", data: { enabled: true } }]);
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
    expect(result?.message?.content).toContain("skill://<name>");
    expect(result?.message?.content).toContain("# Poteto mode");
    expect(result?.message?.content).toContain("When you need user input, use the ask tool.");
  });

  test("before_agent_start replaces a stale context entry", async () => {
    const host = createMockHost(["read"]);
    pstackExtension(host.api);
    const ctx = host.makeCtx({
      hasUI: true,
      entries: [
        { type: "custom_message", id: "ctx", customType: "pstack-mode-context", content: "stale", display: false },
        modeEntry(true),
      ],
    });
    await host.emit("session_start", {}, ctx);

    const result = injected(await host.emit("before_agent_start", {}, ctx));
    expect(result?.message?.customType).toBe("pstack-mode-context");
    expect(result?.message?.content).not.toBe("stale");
    expect(result?.message?.content).not.toContain("SKILL-INDEX");
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

  test("context replaces stale messages and keeps foreign custom messages", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, ctx);

    const stale = contextMessage({ content: "old" });
    const otherCustom: Message = {
      role: "custom",
      customType: "other-extension",
      content: "keep",
      display: false,
      timestamp: 3,
    };
    const user = userMessage();
    const on = messagesOf(await host.emit("context", { messages: [stale, otherCustom, user] }, ctx));
    expect(on).toHaveLength(3);
    expect(on[0]?.customType).toBe("pstack-mode-context");
    expect(on[0]?.content).not.toBe("old");
    expect(on[1]).toBe(otherCustom);
    expect(on[2]).toBe(user);

    const offCtx = host.makeCtx({ hasUI: true, entries: DISABLED });
    await host.emit("session_start", {}, offCtx);
    expect(messagesOf(await host.emit("context", { messages: [stale, otherCustom, user] }, offCtx))).toEqual([
      otherCustom,
      user,
    ]);
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

  test("compaction keeps a current context message in the effective section", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const fresh = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, fresh);
    const prepared = injected(await host.emit("before_agent_start", {}, fresh));

    const ctx = host.makeCtx({
      hasUI: true,
      entries: [
        {
          type: "custom_message",
          id: "ctx",
          customType: "pstack-mode-context",
          content: prepared?.message?.content,
          display: false,
        },
        modeEntry(true),
        { type: "compaction", id: "c", firstKeptEntryId: "ctx" },
      ],
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

    expect(await host.emit("context", { messages: [injectedMessage, user] }, ctx)).toBeUndefined();
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

  test("missing skill file leaves sticky off and one-shot notifies without sending", async () => {
    const host = createMockHost();
    pstackExtension(host.api, { skillFile: path.join(tmpdir(), "missing-pstack-skill.md") });
    const ctx = host.makeCtx({ hasUI: true });

    await host.runCommand("poteto-mode", "sticky", ctx);

    expect(host.appended).toEqual([]);
    expect(host.statusCalls).toEqual([]);
    expect(host.notifications.at(-1)?.message).toContain("pstack skill file not found");
    expect(await host.emit("before_agent_start", {}, ctx)).toBeUndefined();

    await host.runCommand("poteto-mode", "fix the bug", ctx);
    expect(host.sent).toEqual([]);
    expect(host.sentCustom).toEqual([]);
    expect(host.notifications.at(-1)?.message).toContain("pstack skill file not found");
  });

function stripOmpMultiBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n");
}

  test("one-shot /poteto-mode matches OMP skill-prompt format, details, and LLM conversion", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });
    const skillFile = path.resolve("skills/poteto-mode/SKILL.md");
    const built = await buildSkillPromptMessage(
      { name: "poteto-mode", filePath: skillFile, baseDir: path.dirname(skillFile) },
      { args: "fix the bug" },
      "user",
    );

    await host.runCommand("poteto-mode", "fix the bug", ctx);

    expect(host.appended).toEqual([]);
    expect(host.sent).toEqual([]);
    expect(host.sentCustom).toHaveLength(1);
    const record = host.sentCustom[0];
    expect(record?.options).toEqual({ triggerTurn: true });
    expect(record?.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
    expect(record?.message.attribution).toBe("user");
    expect(record?.message.display).toBe(true);
    expect(typeof record?.message.content).toBe("string");
    const contentText = record?.message.content as string;
    expect(stripOmpMultiBlankLines(contentText)).toBe(built.message);
    expect(record?.message.details).toEqual({
      name: built.details.name,
      path: built.details.path,
      args: built.details.args,
      lineCount: built.details.lineCount,
    });

    const customMsg: CustomMessage<SkillPromptDetails> = {
      role: "custom",
      customType: record.message.customType as string,
      content: contentText,
      display: record.message.display as boolean,
      attribution: record.message.attribution as "user",
      details: record.message.details as SkillPromptDetails,
      timestamp: 1,
    };
    expect(isUserInvokedSkillPrompt(customMsg)).toBe(true);
    expect(isUserTurnInitiator(customMsg)).toBe(true);
    expect(convertToLlm([customMsg])).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: contentText }],
        attribution: "user",
        timestamp: 1,
      },
    ]);

    const cleanDir = mkdtempSync(path.join(tmpdir(), "omp-pstack-clean-skill-"));
    try {
      const cleanSkillFile = path.join(cleanDir, "SKILL.md");
      writeFileSync(cleanSkillFile, "---\nname: poteto-mode\ndescription: test\n---\n\n# Clean\n\nFollow steps.\n");
      const cleanHost = createMockHost();
      pstackExtension(cleanHost.api, { skillFile: cleanSkillFile });
      const cleanBuilt = await buildSkillPromptMessage(
        { name: "poteto-mode", filePath: cleanSkillFile, baseDir: cleanDir },
        { args: "fix the bug" },
        "user",
      );
      await cleanHost.runCommand("poteto-mode", "fix the bug", cleanHost.makeCtx({ hasUI: true }));
      expect(cleanHost.sentCustom[0]?.message.content).toBe(cleanBuilt.message);
      expect(cleanHost.sentCustom[0]?.message.details).toEqual({
        name: cleanBuilt.details.name,
        path: cleanBuilt.details.path,
        args: cleanBuilt.details.args,
        lineCount: cleanBuilt.details.lineCount,
      });
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
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

  test("one-shot forwards attached images from input when falling back to the command and clears stashed images afterward", async () => {
    const host = createMockHost([], { commands: [] });
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });
    const skillFile = path.resolve("skills/poteto-mode/SKILL.md");
    const built = await buildSkillPromptMessage(
      { name: "poteto-mode", filePath: skillFile, baseDir: path.dirname(skillFile) },
      { args: "fix this screenshot" },
      "user",
    );
    const image: ImageAttachment = { type: "image", data: "abc", mimeType: "image/png" };

    const dispatched = await dispatchLikeHost(host, "  /poteto-mode fix this screenshot  ", ctx, [image]);
    expect(dispatched).toEqual({ kind: "command", text: "/poteto-mode fix this screenshot" });
    expect(host.sentCustom).toHaveLength(1);
    const parts = host.sentCustom[0]?.message.content as Array<{ type: string; text?: string }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]?.type).toBe("text");
    expect(stripOmpMultiBlankLines(parts[0]?.text ?? "")).toBe(built.message);
    expect(parts[1]).toEqual(image);

    await host.runCommand("poteto-mode", "fix this screenshot", ctx);
    expect(host.sentCustom).toHaveLength(2);
    expect(typeof host.sentCustom[1]?.message.content).toBe("string");
    expect(stripOmpMultiBlankLines(host.sentCustom[1]?.message.content as string)).toBe(built.message);

    await host.emit("input", { text: "/poteto-mode leaked task", images: [image] }, ctx);
    await host.emit("input", { text: "unrelated message" }, ctx);
    await host.runCommand("poteto-mode", "leaked task", ctx);
    expect(host.sentCustom).toHaveLength(3);
    expect(typeof host.sentCustom[2]?.message.content).toBe("string");

    await host.emit("input", { text: "/poteto-mode session switch task", images: [image] }, ctx);
    await host.emit("session_switch", { reason: "resume" }, ctx);
    await host.runCommand("poteto-mode", "session switch task", ctx);
    expect(host.sentCustom).toHaveLength(4);
    expect(typeof host.sentCustom[3]?.message.content).toBe("string");
  });

  test("print and json modes or missing sendMessage fall back to awaiting sendUserMessage with skill prompt content", async () => {
    const skillFile = path.resolve("skills/poteto-mode/SKILL.md");
    const built = await buildSkillPromptMessage(
      { name: "poteto-mode", filePath: skillFile, baseDir: path.dirname(skillFile) },
      { args: "fix the bug" },
      "user",
    );

    for (const mode of ["print", "json"] as const) {
      const host = createMockHost([], { commands: [] });
      pstackExtension(host.api);
      const ctx = host.makeCtx({ hasUI: false, mode });

      await host.runCommand("poteto-mode", "fix the bug", ctx);
      expect(host.sentCustom).toEqual([]);
      expect(host.sent).toHaveLength(1);
      expect(typeof host.sent[0]?.content).toBe("string");
      expect(stripOmpMultiBlankLines(host.sent[0]?.content as string)).toBe(built.message);
      expect(host.sent[0]?.options).toBeUndefined();
    }

    const legacyHost = createMockHost([], { omitSendMessage: true, commands: [] });
    pstackExtension(legacyHost.api);
    const tuiCtx = legacyHost.makeCtx({ hasUI: true, mode: "tui" });
    const image: ImageAttachment = { type: "image", data: "xyz", mimeType: "image/png" };
    await dispatchLikeHost(legacyHost, "/poteto-mode fix the bug", tuiCtx, [image]);
    expect(legacyHost.sent).toHaveLength(1);
    const legacyParts = legacyHost.sent[0]?.content as Array<{ type: string; text?: string }>;
    expect(legacyParts).toHaveLength(2);
    expect(legacyParts[0]?.type).toBe("text");
    expect(stripOmpMultiBlankLines(legacyParts[0]?.text ?? "")).toBe(built.message);
    expect(legacyParts[1]).toEqual(image);
    expect(legacyHost.sent[0]?.options).toBeUndefined();
  });

  test("command completions list the control words", () => {
    const host = createMockHost();
    pstackExtension(host.api);

    const command = host.commands.get("poteto-mode");
    expect(command?.getArgumentCompletions?.("s")?.map((item) => item.value)).toEqual(["sticky", "status"]);
  });

  test("sticky <task> and on <task> enable sticky mode and strip the prefix on input", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    expect(await host.emit("input", { text: "/poteto-mode sticky fix the bug" }, ctx)).toEqual({
      text: "fix the bug",
    });
    expect(host.appended).toEqual([{ customType: "pstack-mode", data: { enabled: true } }]);
    expect(host.statusCalls.at(-1)).toEqual({ key: "pstack-mode", value: "pstack: poteto mode" });
    expect(host.notifications.at(-1)?.message).toBe("Poteto Mode sticky enabled for this session.");

    expect(await host.emit("input", { text: "  /poteto-mode on next task" }, ctx)).toEqual({
      text: "next task",
    });
    expect(host.appended).toHaveLength(1);
    expect(host.notifications.at(-1)?.message).toBe("Poteto Mode sticky is already enabled.");
  });

  test("sticky <task> with a missing skill file stops input without sending", async () => {
    const host = createMockHost();
    pstackExtension(host.api, { skillFile: path.join(tmpdir(), "missing-pstack-skill.md") });
    const ctx = host.makeCtx({ hasUI: true });

    expect(await host.emit("input", { text: "/poteto-mode sticky fix the bug" }, ctx)).toEqual({ handled: true });
    expect(host.appended).toEqual([]);
    expect(host.notifications.at(-1)?.message).toContain("pstack skill file not found");
  });

  test("direct sticky <task> command enables sticky mode and sends the plain task", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    await host.runCommand("poteto-mode", "sticky fix the bug", ctx);

    expect(host.appended).toEqual([{ customType: "pstack-mode", data: { enabled: true } }]);
    expect(host.sent).toEqual([{ content: "fix the bug", options: undefined }]);
  });

  test("leading whitespace and on alias work cleanly", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    expect(await host.emit("input", { text: "  /poteto-mode fix the bug" }, ctx)).toEqual({
      text: "/skill:poteto-mode fix the bug",
    });
    expect(await host.emit("input", { text: "  /poteto-mode sticky" }, ctx)).toEqual({
      text: "/poteto-mode sticky",
    });
    await host.runCommand("poteto-mode", "on", ctx);
    expect(host.appended).toEqual([{ customType: "pstack-mode", data: { enabled: true } }]);
  });

  test("falls back to the skill-prompt command handler when /skill:poteto-mode is not registered", async () => {
    const host = createMockHost([], { commands: [] });
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    expect(await host.emit("input", { text: "/poteto-mode fix the bug" }, ctx)).toBeUndefined();
    const dispatched = await dispatchLikeHost(host, "/poteto-mode fix the bug", ctx);
    expect(dispatched.kind).toBe("command");
    expect(host.sentCustom).toHaveLength(1);
    expect(host.sentCustom[0]?.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
  });

  test("falls back to the skill-prompt command handler when getCommands is unavailable", async () => {
    const host = createMockHost([], { omitGetCommands: true });
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    expect(await host.emit("input", { text: "/poteto-mode fix the bug" }, ctx)).toBeUndefined();
    const dispatched = await dispatchLikeHost(host, "/poteto-mode fix the bug", ctx);
    expect(dispatched.kind).toBe("command");
    expect(host.sentCustom).toHaveLength(1);
    expect(host.sentCustom[0]?.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
  });

  test("ignores foreign skill:poteto-mode path and allows legacy undefined path", async () => {
    const foreignHost = createMockHost([], {
      commands: [
        {
          name: "skill:poteto-mode",
          source: "skill",
          path: "/tmp/foreign-pstack/poteto-mode/SKILL.md",
        },
      ],
    });
    pstackExtension(foreignHost.api);
    const foreignCtx = foreignHost.makeCtx({ hasUI: true });

    expect(await foreignHost.emit("input", { text: "/poteto-mode fix the bug" }, foreignCtx)).toBeUndefined();
    const dispatched = await dispatchLikeHost(foreignHost, "/poteto-mode fix the bug", foreignCtx);
    expect(dispatched.kind).toBe("command");
    expect(foreignHost.sentCustom).toHaveLength(1);
    expect(foreignHost.sentCustom[0]?.message.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
    expect((foreignHost.sentCustom[0]?.message.details as SkillPromptDetails).path).toBe(
      path.resolve("skills/poteto-mode/SKILL.md"),
    );

    const legacyHost = createMockHost([], {
      commands: [{ name: "skill:poteto-mode", source: "skill" }],
    });
    pstackExtension(legacyHost.api);
    const legacyCtx = legacyHost.makeCtx({ hasUI: true });
    expect(await legacyHost.emit("input", { text: "/poteto-mode fix the bug" }, legacyCtx)).toEqual({
      text: "/skill:poteto-mode fix the bug",
    });
  });

  test("routes to collision-namespaced skill command matching skillFile", async () => {
    const host = createMockHost([], {
      commands: [
        {
          name: "skill:omp-pstack/poteto-mode",
          source: "skill",
          path: path.resolve("skills/poteto-mode/SKILL.md"),
        },
      ],
    });
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true });

    expect(await host.emit("input", { text: "/poteto-mode fix the bug" }, ctx)).toEqual({
      text: "/skill:omp-pstack/poteto-mode fix the bug",
    });
  });

  test("does not double-expand poteto-mode when sticky is already active", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, ctx);

    expect(await host.emit("input", { text: "/poteto-mode fix the bug" }, ctx)).toEqual({
      text: "fix the bug",
    });

    await host.runCommand("poteto-mode", "follow up", ctx);
    expect(host.sentCustom).toEqual([]);
    expect(host.sent).toEqual([{ content: "follow up", options: undefined }]);
  });

  test("context is a no-op when disabled without context messages and replaces stale messages in-place", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const offCtx = host.makeCtx({ hasUI: true, entries: [] });
    await host.emit("session_start", {}, offCtx);
    const u1 = userMessage("first");
    const u2 = userMessage("second");
    expect(await host.emit("context", { messages: [u1, u2] }, offCtx)).toBeUndefined();

    const onCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, onCtx);
    const stale = contextMessage({ content: "stale" });
    const dup = contextMessage({ content: "stale-dup" });
    const replaced = messagesOf(await host.emit("context", { messages: [u1, stale, dup, u2] }, onCtx));
    expect(replaced).toHaveLength(3);
    expect(replaced[0]).toBe(u1);
    expect(replaced[1]?.customType).toBe("pstack-mode-context");
    expect(replaced[1]?.content).toContain("# Poteto mode");
    expect(replaced[2]).toBe(u2);
  });

  test("subagents and revive turns do not inject or handle poteto-mode hooks", async () => {
    const host = createMockHost();
    pstackExtension(host.api);
    const subCtx = host.makeCtx({
      hasUI: false,
      entries: ENABLED,
      agent: { kind: "sub", id: "0-poteto-agent", name: "poteto-agent", depth: 1 },
    });

    await host.emit("session_start", {}, subCtx);
    expect(host.statusCalls).toEqual([]);
    expect(await host.emit("input", { text: "/poteto-mode fix the bug" }, subCtx)).toBeUndefined();
    expect(await host.emit("before_agent_start", { reason: "prompt" }, subCtx)).toBeUndefined();
    expect(await host.emit("context", { messages: [userMessage()] }, subCtx)).toBeUndefined();

    const mainCtx = host.makeCtx({ hasUI: true, entries: ENABLED });
    await host.emit("session_start", {}, mainCtx);
    expect(await host.emit("before_agent_start", { reason: "revive" }, mainCtx)).toBeUndefined();
  });

  test("sticky mode switches to a replaced skill file without a session event", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omp-pstack-upgrade-"));
    try {
      const first = path.join(dir, "v1", "skills", "poteto-mode", "SKILL.md");
      const second = path.join(dir, "v2", "skills", "poteto-mode", "SKILL.md");
      mkdirSync(path.dirname(first), { recursive: true });
      mkdirSync(path.dirname(second), { recursive: true });
      writeFileSync(first, "---\nname: poteto-mode\ndescription: v1\n---\n\nV1 BODY\n");
      writeFileSync(second, "---\nname: poteto-mode\ndescription: v2\n---\n\nV2 BODY\n");
      let current = first;
      const host = createMockHost();
      pstackExtension(host.api, {
        skillFileResolver: () => ({ skillFile: current, skillDir: path.dirname(current), usingFallback: true }),
      });
      const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
      await host.emit("session_start", {}, ctx);
      expect(injected(await host.emit("before_agent_start", {}, ctx))?.message?.content).toContain("V1 BODY");

      rmSync(first);
      current = second;
      const next = injected(await host.emit("before_agent_start", {}, ctx));
      expect(next?.message?.content).toContain("V2 BODY");
      expect(next?.message?.content).toContain(path.dirname(second));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing native command path falls back to the local skill prompt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omp-pstack-stale-"));
    try {
      const skillFile = path.join(dir, "skills", "poteto-mode", "SKILL.md");
      const stale = path.join(dir, "old", "SKILL.md");
      mkdirSync(path.dirname(skillFile), { recursive: true });
      mkdirSync(path.dirname(stale), { recursive: true });
      writeFileSync(skillFile, "---\nname: poteto-mode\ndescription: test\n---\n\nBODY\n");
      writeFileSync(stale, "old\n");
      const host = createMockHost([], {
        commands: [{ name: "skill:poteto-mode", source: "skill", path: stale }],
      });
      pstackExtension(host.api, { skillFile });
      const ctx = host.makeCtx({ hasUI: true });
      rmSync(stale);

      expect(await host.emit("input", { text: "/poteto-mode fix the bug" }, ctx)).toBeUndefined();
      const dispatched = await dispatchLikeHost(host, "/poteto-mode fix the bug", ctx);
      expect(dispatched.kind).toBe("command");
      expect(host.sentCustom).toHaveLength(1);
      expect((host.sentCustom[0]?.message.details as SkillPromptDetails).path).toBe(skillFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skill cache notices a same-mtime size change", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omp-pstack-cache-"));
    try {
      const skillFile = path.join(dir, "skills", "poteto-mode", "SKILL.md");
      mkdirSync(path.dirname(skillFile), { recursive: true });
      writeFileSync(skillFile, "---\nname: poteto-mode\ndescription: test\n---\n\nA\n");
      const host = createMockHost();
      pstackExtension(host.api, { skillFile });
      const ctx = host.makeCtx({ hasUI: true, entries: ENABLED });
      await host.emit("session_start", {}, ctx);
      expect(injected(await host.emit("before_agent_start", {}, ctx))?.message?.content).toContain("A");

      const stats = statSync(skillFile);
      writeFileSync(skillFile, "---\nname: poteto-mode\ndescription: test\n---\n\nBB\n");
      utimesSync(skillFile, stats.atime, stats.mtime);
      expect(injected(await host.emit("before_agent_start", {}, ctx))?.message?.content).toContain("BB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
