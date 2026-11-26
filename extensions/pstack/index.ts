import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { preferredAskTool } from "./interaction.js";

const MODE_ENTRY = "pstack-mode";
const CONTEXT_TYPE = "pstack-mode-context";
const SKILL_FILE = path.join(packageRoot(), "skills/poteto-mode/SKILL.md");
const STATUS_TEXT = "pstack: poteto mode";
const USAGE = [
  "/poteto-mode <task>   one-shot",
  "/poteto-mode sticky   keep Poteto Mode on across turns",
  "/poteto-mode off      stop sticky mode",
  "/poteto-mode status   show sticky state",
].join("\n");

type ContextMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  timestamp: number;
};

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

export default function (pi: ExtensionAPI, options: ExtensionOptions = {}) {
  const skillFile = options.skillFile ?? SKILL_FILE;
  const skillDir = path.dirname(skillFile);
  const skillIndex = path.join(skillDir, "SKILL-INDEX.md");
  let potetoMode = false;
  let cachedSkill: { mtimeMs: number; body: string } | undefined;
  let cachedContext: { content: string; message: ContextMessage } | undefined;

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
      `Skill index: ${skillIndex}`,
      "Resolve relative paths in this skill against the skill directory.",
      `Other pstack skills are read as files: ${path.join(packageRoot(), "skills")}/<name>/SKILL.md.`,
    ];
    if (ctx.hasUI) {
      const ask = preferredAskTool(pi);
      if (ask) lines.push(`When you need user input, use the ${ask} tool.`);
    }
    lines.push("", body);
    return lines.join("\n");
  }

  function hasContextMessage(ctx: ExtensionContext): boolean {
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
      if (entry?.type === "custom_message" && entry.customType === CONTEXT_TYPE) return true;
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

  async function sendOneShotFallback(ctx: ExtensionContext, task: string): Promise<void> {
    const body = readSkillBody();
    if (body === undefined) {
      notify(ctx, `pstack skill file not found at ${skillFile}`, "error");
      return;
    }
    try {
      await pi.sendUserMessage(`[Skill directory: ${skillDir}]\n\n${body}\n\nTask:\n${task}`);
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
      const command = args.trim();
      if (command === "sticky") {
        enableMode(ctx);
        return;
      }
      if (command === "off" || command === "disable" || command === "stop") {
        disableMode(ctx);
        return;
      }
      if (command === "status") {
        notify(ctx, potetoMode ? "Poteto Mode sticky is enabled." : "Poteto Mode sticky is disabled.");
        return;
      }
      if (command === "") {
        const state = potetoMode ? "Poteto Mode sticky is enabled." : "Poteto Mode sticky is disabled.";
        notify(ctx, `${state}\n${USAGE}`);
        return;
      }
      await sendOneShotFallback(ctx, command);
    },
  });

  pi.on("input", (event) => {
    if (/^\/poteto-mode\s*$/.test(event.text)) return;
    if (/^\/poteto-mode\s+(sticky|off|disable|stop|status)\s*$/.test(event.text)) return;
    const match = /^\/poteto-mode\s+([\s\S]*)$/.exec(event.text);
    if (!match) return;
    const task = match[1].trim();
    if (task === "") return;
    return { text: `/skill:poteto-mode ${task}` };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!potetoMode) return;
    const body = readSkillBody();
    if (body === undefined) return;
    if (hasContextMessage(ctx)) return;
    return {
      message: {
        customType: CONTEXT_TYPE,
        content: buildContextPayload(ctx, body),
        display: false,
      },
    };
  });

  pi.on("context", (event, ctx) => {
    if (!potetoMode) {
      return { messages: event.messages.filter((message) => !isContextMessage(message)) };
    }
    const body = readSkillBody();
    if (body === undefined) return;
    if (event.messages.some(isContextMessage)) return { messages: event.messages };
    const messages = [...event.messages];
    messages.splice(messages[0]?.role === "compactionSummary" ? 1 : 0, 0, contextMessage(buildContextPayload(ctx, body)));
    return { messages };
  });
}
