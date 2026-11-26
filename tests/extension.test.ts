import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { confirmExternalActionsEnabled, resolvePstackConfigFile } from "../extensions/pstack/config.ts";
import pstackExtension from "../extensions/pstack/index.ts";
import { confirmUser, preferredAskTool } from "../extensions/pstack/interaction.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

function createTempDir(prefix = "omp-pstack-test-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("config", () => {
  test("resolvePstackConfigFile resolves default and PI_CODING_AGENT_DIR paths", () => {
    expect(resolvePstackConfigFile({})).toBe(path.join(homedir(), ".omp", "agent", "pstack", "config.json"));
    expect(resolvePstackConfigFile({ PI_CODING_AGENT_DIR: "   " })).toBe(
      path.join(homedir(), ".omp", "agent", "pstack", "config.json"),
    );

    const customDir = path.join(tmpdir(), "custom-omp-agent");
    expect(resolvePstackConfigFile({ PI_CODING_AGENT_DIR: customDir })).toBe(
      path.join(customDir, "pstack", "config.json"),
    );

    expect(resolvePstackConfigFile({ PI_CODING_AGENT_DIR: "~/custom-omp" })).toBe(
      path.join(homedir(), "custom-omp", "pstack", "config.json"),
    );
  });

  test("confirmExternalActionsEnabled only disables on explicit boolean false", () => {
    const dir = createTempDir();
    expect(confirmExternalActionsEnabled(path.join(dir, "missing.json"))).toBe(true);

    const malformed = path.join(dir, "malformed.json");
    writeFileSync(malformed, "{not-valid-json");
    expect(confirmExternalActionsEnabled(malformed)).toBe(true);

    const emptyObj = path.join(dir, "empty.json");
    writeFileSync(emptyObj, "{}");
    expect(confirmExternalActionsEnabled(emptyObj)).toBe(true);

    const stringFalse = path.join(dir, "string-false.json");
    writeFileSync(stringFalse, JSON.stringify({ confirmExternalActions: "false" }));
    expect(confirmExternalActionsEnabled(stringFalse)).toBe(true);

    const boolFalse = path.join(dir, "bool-false.json");
    writeFileSync(boolFalse, JSON.stringify({ confirmExternalActions: false }));
    expect(confirmExternalActionsEnabled(boolFalse)).toBe(false);
  });
});

describe("interaction", () => {
  test("preferredAskTool detects active ask tool", () => {
    expect(preferredAskTool({})).toBeUndefined();
    expect(preferredAskTool({ getActiveTools: () => ["read", "bash"] })).toBeUndefined();
    expect(preferredAskTool({ getActiveTools: () => ["read", "ask", "bash"] })).toBe("ask");
  });

  test("confirmUser handles non-UI, askDialog choices, invalid responses, and confirm fallback", async () => {
    expect(await confirmUser({ hasUI: false, ui: {} }, "Title", "Allow?")).toBeUndefined();

    expect(
      await confirmUser(
        {
          hasUI: true,
          ui: {
            askDialog: async () => ({
              kind: "submit",
              results: [{ id: "choice", selectedOptions: ["Allow"] }],
            }),
          },
        },
        "Title",
        "Allow?",
        "git push",
      ),
    ).toBe(true);

    expect(
      await confirmUser(
        {
          hasUI: true,
          ui: {
            askDialog: async () => ({
              kind: "submit",
              results: [{ id: "choice", selectedOptions: ["Decline"] }],
            }),
          },
        },
        "Title",
        "Allow?",
      ),
    ).toBe(false);

    for (const response of [
      { kind: "chat" },
      { kind: "submit", results: [{ id: "choice", selectedOptions: ["Allow"], timedOut: true }] },
      { kind: "submit", results: [{ id: "choice", selectedOptions: ["Allow"], customInput: "yes" }] },
      { kind: "submit", results: [{ id: "choice", selectedOptions: ["Other"] }] },
    ]) {
      expect(
        await confirmUser(
          {
            hasUI: true,
            ui: { askDialog: async () => response },
          },
          "Title",
          "Allow?",
        ),
      ).toBe(false);
    }

    let confirmArgs: [string, string] | undefined;
    expect(
      await confirmUser(
        {
          hasUI: true,
          ui: {
            confirm: async (title: string, message: string) => {
              confirmArgs = [title, message];
              return true;
            },
          },
        },
        "Confirm",
        "Allow git push?",
        "git push origin main",
      ),
    ).toBe(true);
    expect(confirmArgs).toEqual(["Confirm", "Allow git push?\n\ngit push origin main"]);
  });
});

describe("pstackExtension", () => {
  test("tracks sticky Poteto Mode via input and session_start and injects prompt sections", async () => {
    const agentDir = createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const host = createMockHost(["read", "ask"]);
    pstackExtension(host.api);

    expect(host.handlers.has("tool_call")).toBe(true);

    const uiCtx = host.makeCtx({ hasUI: true });
    expect(await host.emit("before_agent_start", { systemPrompt: ["BASE"] }, uiCtx)).toEqual({
      systemPrompt: ["BASE\n\nWhen you need user input, use the ask tool."],
    });

    const noUiCtx = host.makeCtx({ hasUI: false });
    expect(await host.emit("before_agent_start", { systemPrompt: ["BASE"] }, noUiCtx)).toBeUndefined();

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

  test("guards recognized external bash writes and allows safe commands", async () => {
    const agentDir = createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const host = createMockHost();
    pstackExtension(host.api);

    const noUiCtx = host.makeCtx({ hasUI: false });
    expect(await host.emit("tool_call", { toolName: "read", input: { command: "git push" } }, noUiCtx)).toBeUndefined();
    expect(await host.emit("tool_call", { toolName: "bash", input: { command: "git status" } }, noUiCtx)).toBeUndefined();

    const guardedCommands = [
      "git push origin main",
      "gh pr merge 12",
      "gt submit",
      "terraform apply",
      "kubectl delete pod foo",
      "vercel deploy",
      "rm -rf ./tmp",
    ];
    for (const command of guardedCommands) {
      const result = (await host.emit("tool_call", { toolName: "bash", input: { command } }, noUiCtx)) as {
        block?: boolean;
        reason?: string;
      };
      expect(result?.block).toBe(true);
      expect(result?.reason).toContain("requires explicit user confirmation");
    }

    const allowCtx = host.makeCtx({
      hasUI: true,
      ui: {
        askDialog: async () => ({
          kind: "submit",
          results: [{ id: "choice", selectedOptions: ["Allow"] }],
        }),
      },
    });
    expect(
      await host.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }, allowCtx),
    ).toBeUndefined();

    const declineCtx = host.makeCtx({
      hasUI: true,
      ui: {
        askDialog: async () => ({
          kind: "submit",
          results: [{ id: "choice", selectedOptions: ["Decline"] }],
        }),
      },
    });
    expect(
      await host.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }, declineCtx),
    ).toEqual({
      block: true,
      reason: "User declined git push.",
    });

    const errorCtx = host.makeCtx({
      hasUI: true,
      ui: {
        askDialog: async () => {
          throw new Error("dialog crashed");
        },
      },
    });
    expect(
      await host.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }, errorCtx),
    ).toEqual({
      block: true,
      reason: "Cannot confirm git push: dialog crashed",
    });
  });

  test("omits tool_call guard and injects disabled notice when confirmExternalActions is false", async () => {
    const agentDir = createTempDir();
    mkdirSync(path.join(agentDir, "pstack"), { recursive: true });
    writeFileSync(path.join(agentDir, "pstack", "config.json"), JSON.stringify({ confirmExternalActions: false }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const host = createMockHost();
    pstackExtension(host.api);

    expect(host.handlers.has("tool_call")).toBe(false);
    const result = (await host.emit("before_agent_start", { systemPrompt: ["BASE"] }, host.makeCtx())) as {
      systemPrompt: string[];
    };
    expect(result.systemPrompt[0]).toContain("The pstack external-action confirmation guard is disabled by config.");
  });
});
