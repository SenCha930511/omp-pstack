import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, InputEvent, SkillPromptDetails } from "@oh-my-pi/pi-coding-agent";
import { preferredAskTool } from "./interaction.js";

const MODE_ENTRY = "pstack-mode";
const CONTEXT_TYPE = "pstack-mode-context";
const SKILL_NAME = "poteto-mode";
const SKILL_PROMPT_TYPE = "skill-prompt";
const SKILL_FILE = path.join(packageRoot(), "skills/poteto-mode/SKILL.md");
const STATUS_TEXT = "pstack: poteto mode";
const USAGE = [
  "/poteto-mode <task>          one-shot",
  "/poteto-mode sticky [task]   keep Poteto Mode on across turns (and optionally run a task)",
  "/poteto-mode off             stop sticky mode",
  "/poteto-mode status          show sticky state",
].join("\n");

type AttachedImages = NonNullable<InputEvent["images"]>;

type ContextMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  timestamp: number;
};

type ParsedCommand =
  | { kind: "usage" }
  | { kind: "status" }
  | { kind: "off" }
  | { kind: "sticky"; task?: string }
  | { kind: "one-shot"; task: string };

type ExtensionOptions = {
  skillFile?: string;
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function isPotetoModeEnabled(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { enabled?: unknown }).enabled === true
  );
}

function isContextMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === CONTEXT_TYPE;
}

function isSubagent(ctx: ExtensionContext): boolean {
  return ctx.agent?.kind === "sub";
}

function parsePotetoCommand(rawArgs: string): ParsedCommand {
  const trimmed = rawArgs.trim();
  if (trimmed === "") return { kind: "usage" };
  if (trimmed === "status") return { kind: "status" };
  if (trimmed === "off" || trimmed === "disable" || trimmed === "stop") return { kind: "off" };
  const stickyMatch = /^(?:sticky|on)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (stickyMatch) {
    const task = stickyMatch[1]?.trim();
    return task ? { kind: "sticky", task } : { kind: "sticky" };
  }
  return { kind: "one-shot", task: trimmed };
}

export default function (pi: ExtensionAPI, options: ExtensionOptions = {}) {
  const skillFile = options.skillFile ?? SKILL_FILE;
  const skillDir = path.dirname(skillFile);
  let potetoMode = false;
  let cachedSkill: { mtimeMs: number; body: string } | undefined;
  let cachedContext: { content: string; message: ContextMessage } | undefined;
  let pendingOneShotImages: { task: string; images: AttachedImages } | undefined;

  function notify(ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function readSkillBody(): string | undefined {
    try {
      const { mtimeMs } = fs.statSync(skillFile);
      if (cachedSkill?.mtimeMs === mtimeMs) return cachedSkill.body;
      const body = fs.readFileSync(skillFile, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      cachedSkill = { mtimeMs, body };
      return body;
    } catch {
      cachedSkill = undefined;
      return undefined;
    }
  }

  function buildContextPayload(ctx: ExtensionContext, body: string): string {
    const lines = [
      "[PSTACK POTETO MODE]",
      `Skill file: ${skillFile}`,
      `Skill directory: ${skillDir}`,
      "Resolve relative paths in this skill against the skill directory.",
      "Other pstack skills are registered. Invoke them with /skill:<name> or read skill://<name>; all but setup-pstack are hidden from the model catalog.",
    ];
    if (ctx.hasUI) {
      const ask = preferredAskTool(pi);
      if (ask) lines.push(`When you need user input, use the ${ask} tool.`);
    }
    lines.push("", body);
    return lines.join("\n");
  }

  function hasContextMessage(ctx: ExtensionContext, content: string): boolean {
    const branch = ctx.sessionManager.getBranch();
    let start = 0;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      if (branch[index]?.type === "reset_boundary") {
        start = index + 1;
        break;
      }
    }
    for (let index = branch.length - 1; index >= start; index -= 1) {
      const entry = branch[index];
      if (entry?.type !== "compaction") continue;
      const keptIndex = branch.findIndex(
        (candidate, candidateIndex) => candidateIndex >= start && candidate.id === entry.firstKeptEntryId,
      );
      start = keptIndex >= 0 ? keptIndex : index + 1;
      break;
    }
    for (let index = start; index < branch.length; index += 1) {
      const entry = branch[index];
      if (
        entry?.type === "custom_message" &&
        entry.customType === CONTEXT_TYPE &&
        "content" in entry &&
        entry.content === content
      ) {
        return true;
      }
    }
    return false;
  }

  function contextMessage(content: string): ContextMessage {
    if (cachedContext?.content === content) return cachedContext.message;
    const message: ContextMessage = {
      role: "custom",
      customType: CONTEXT_TYPE,
      content,
      display: false,
      timestamp: Date.now(),
    };
    cachedContext = { content, message };
    return message;
  }

  function applyMode(ctx: ExtensionContext, enabled: boolean): void {
    potetoMode = enabled;
    if (ctx.hasUI) ctx.ui.setStatus(MODE_ENTRY, enabled ? STATUS_TEXT : undefined);
  }

  function restorePotetoMode(ctx: ExtensionContext): void {
    pendingOneShotImages = undefined;
    if (isSubagent(ctx)) {
      potetoMode = false;
      return;
    }
    let enabled = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "reset_boundary") {
        enabled = false;
        continue;
      }
      if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
        enabled = isPotetoModeEnabled(entry.data);
      }
    }
    applyMode(ctx, enabled);
  }

  function enableMode(ctx: ExtensionContext): boolean {
    if (readSkillBody() === undefined) {
      notify(ctx, `pstack skill file not found at ${skillFile}`, "error");
      return false;
    }
    if (potetoMode) {
      notify(ctx, "Poteto Mode sticky is already enabled.");
      return true;
    }
    applyMode(ctx, true);
    pi.appendEntry(MODE_ENTRY, { enabled: true });
    notify(ctx, "Poteto Mode sticky enabled for this session.");
    return true;
  }

  function disableMode(ctx: ExtensionContext): void {
    if (!potetoMode) {
      notify(ctx, "Poteto Mode sticky is already disabled.");
      return;
    }
    applyMode(ctx, false);
    pi.appendEntry(MODE_ENTRY, { enabled: false });
    notify(ctx, "Poteto Mode sticky disabled for this session.");
  }

  function findSkillCommandName(): string | undefined {
    if (typeof pi.getCommands !== "function") return undefined;
    const targetPath = path.resolve(skillFile);
    const commands = pi.getCommands();
    const byPath = commands.find(
      (cmd) => cmd.source === "skill" && cmd.path !== undefined && path.resolve(cmd.path) === targetPath,
    );
    if (byPath) return byPath.name;
    const byName = commands.find(
      (cmd) => cmd.source === "skill" && cmd.name === "skill:poteto-mode" && cmd.path === undefined,
    );
    return byName?.name;
  }

  function buildOneShotSkillPrompt(body: string, task: string): { text: string; details: SkillPromptDetails } {
    const trimmedBody = body.replace(/\r\n?/g, "\n").trim();
    const trimmedTask = task.trim();
    const text = [
      `[IMPORTANT: User invoked the "${SKILL_NAME}" skill; follow its instructions. Full skill below.]`,
      "",
      trimmedBody,
      "",
      "---",
      "",
      `[Skill directory: ${skillDir}]`,
      "Resolve relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against this absolute directory; read referenced assets and templates; run scripts with the terminal tool when skill instructions call for it.",
      `User: ${trimmedTask}`,
    ].join("\n");
    return {
      text,
      details: {
        name: SKILL_NAME,
        path: skillFile,
        args: trimmedTask,
        lineCount: trimmedBody ? trimmedBody.split("\n").length : 0,
      },
    };
  }

  async function sendPlainTask(ctx: ExtensionContext, task: string, images?: AttachedImages): Promise<void> {
    const content = images && images.length > 0 ? [{ type: "text" as const, text: task }, ...images] : task;
    try {
      await pi.sendUserMessage(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, `Task was not sent: ${message}`, "error");
    }
  }

  async function sendOneShotSkill(ctx: ExtensionContext, task: string, images?: AttachedImages): Promise<void> {
    const body = readSkillBody();
    if (body === undefined) {
      notify(ctx, `pstack skill file not found at ${skillFile}`, "error");
      return;
    }
    const built = buildOneShotSkillPrompt(body, task);
    const content =
      images && images.length > 0 ? [{ type: "text" as const, text: built.text }, ...images] : built.text;
    // In print/json modes, print-mode.ts calls session.waitForIdle() immediately after
    // prompt() returns without tracking extension sendMessage promises; awaiting
    // sendUserMessage avoids racing teardown while still delivering the exact prompt body.
    const useSkillPromptMessage =
      typeof pi.sendMessage === "function" && ctx.mode !== "print" && ctx.mode !== "json";
    if (useSkillPromptMessage) {
      try {
        pi.sendMessage(
          {
            customType: SKILL_PROMPT_TYPE,
            content,
            display: true,
            attribution: "user",
            details: built.details,
          },
          { triggerTurn: true },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `Task was not sent: ${message}`, "error");
      }
      return;
    }
    try {
      await pi.sendUserMessage(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, `Task was not sent: ${message}`, "error");
    }
  }

  pi.on("session_start", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_switch", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_branch", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_tree", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_clear", (_event, ctx) => restorePotetoMode(ctx));

  pi.registerCommand("poteto-mode", {
    description: "Run Poteto Mode for one task, or manage sticky mode.",
    getArgumentCompletions: (prefix) =>
      ["sticky", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const parsed = parsePotetoCommand(args);
      const images =
        parsed.kind === "one-shot" && pendingOneShotImages?.task === parsed.task
          ? pendingOneShotImages.images
          : undefined;
      pendingOneShotImages = undefined;
      if (parsed.kind === "sticky") {
        if (!enableMode(ctx)) return;
        if (parsed.task) await sendPlainTask(ctx, parsed.task);
        return;
      }
      if (parsed.kind === "off") {
        disableMode(ctx);
        return;
      }
      if (parsed.kind === "status") {
        notify(ctx, potetoMode ? "Poteto Mode sticky is enabled." : "Poteto Mode sticky is disabled.");
        return;
      }
      if (parsed.kind === "usage") {
        const state = potetoMode ? "Poteto Mode sticky is enabled." : "Poteto Mode sticky is disabled.";
        notify(ctx, `${state}\n${USAGE}`);
        return;
      }
      if (potetoMode) {
        await sendPlainTask(ctx, parsed.task, images);
        return;
      }
      await sendOneShotSkill(ctx, parsed.task, images);
    },
  });

  pi.on("input", (event, ctx) => {
    if (isSubagent(ctx)) return;
    pendingOneShotImages = undefined;
    const match = /^\s*\/poteto-mode(?:\s+([\s\S]*))?$/.exec(event.text);
    if (!match) return;
    const parsed = parsePotetoCommand(match[1] ?? "");
    if (parsed.kind === "usage" || parsed.kind === "status" || parsed.kind === "off") {
      return event.text !== event.text.trimStart() ? { text: event.text.trim() } : undefined;
    }
    if (parsed.kind === "sticky") {
      if (!parsed.task) {
        return event.text !== event.text.trimStart() ? { text: event.text.trim() } : undefined;
      }
      if (!enableMode(ctx)) return { handled: true };
      return { text: parsed.task };
    }
    if (potetoMode) {
      return { text: parsed.task };
    }
    const skillCommand = findSkillCommandName();
    if (skillCommand) {
      return { text: `/${skillCommand} ${parsed.task}` };
    }
    if (event.images && event.images.length > 0) {
      pendingOneShotImages = { task: parsed.task, images: [...event.images] };
    }
    return event.text !== event.text.trimStart() ? { text: event.text.trim() } : undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (isSubagent(ctx) || !potetoMode || event.reason === "revive") return;
    const body = readSkillBody();
    if (body === undefined) return;
    const content = buildContextPayload(ctx, body);
    if (hasContextMessage(ctx, content)) return;
    return {
      message: {
        customType: CONTEXT_TYPE,
        content,
        display: false,
      },
    };
  });

  pi.on("context", (event, ctx) => {
    if (isSubagent(ctx)) return;
    const contextIndices: number[] = [];
    for (let index = 0; index < event.messages.length; index += 1) {
      if (isContextMessage(event.messages[index])) {
        contextIndices.push(index);
      }
    }
    if (!potetoMode) {
      if (contextIndices.length === 0) return;
      return { messages: event.messages.filter((message) => !isContextMessage(message)) };
    }
    const body = readSkillBody();
    if (body === undefined) {
      if (contextIndices.length === 0) return;
      return { messages: event.messages.filter((message) => !isContextMessage(message)) };
    }
    const content = buildContextPayload(ctx, body);
    const currentIndex = contextIndices.find((index) => {
      const message = event.messages[index];
      return message !== undefined && "content" in message && message.content === content;
    });
    if (currentIndex !== undefined) {
      if (contextIndices.length === 1) return;
      return {
        messages: event.messages.filter((message, index) => !isContextMessage(message) || index === currentIndex),
      };
    }
    if (contextIndices.length > 0) {
      const replaceAt = contextIndices[0];
      const nextMessage = contextMessage(content);
      const messages = [];
      for (let index = 0; index < event.messages.length; index += 1) {
        if (index === replaceAt) {
          messages.push(nextMessage);
        } else if (!isContextMessage(event.messages[index])) {
          messages.push(event.messages[index]);
        }
      }
      return { messages };
    }
    const messages = [...event.messages];
    messages.splice(messages[0]?.role === "compactionSummary" ? 1 : 0, 0, contextMessage(content));
    return { messages };
  });
}
