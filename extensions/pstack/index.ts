import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { preferredAskTool } from "./interaction.js";

const MODE_ENTRY = "pstack-mode";

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

export default function (pi: ExtensionAPI) {
  let potetoMode = false;

  function applyPotetoMode(ctx: ExtensionContext, enabled: boolean): void {
    potetoMode = enabled;
    if (ctx.hasUI) ctx.ui.setStatus(MODE_ENTRY, enabled ? "pstack: poteto mode" : undefined);
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
    applyPotetoMode(ctx, enabled);
  }

  pi.on("session_start", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_switch", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_branch", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_tree", (_event, ctx) => restorePotetoMode(ctx));
  pi.on("session_clear", (_event, ctx) => restorePotetoMode(ctx));

  pi.on("input", (event, ctx) => {
    if (!/^\/skill:poteto-mode(?:\s|$)/.test(event.text)) return;
    pi.appendEntry(MODE_ENTRY, { enabled: true });
    applyPotetoMode(ctx, true);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sections: string[] = [];
    if (ctx.hasUI) {
      const ask = preferredAskTool(pi);
      if (ask) sections.push(`When you need user input, use the ${ask} tool.`);
    }
    if (potetoMode)
      sections.push(
        `Pstack Poteto Mode is enabled for this session. Read the full skill at ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")} again before acting, then follow its persisted workflow: track non-trivial work with the todo tool, select and read the matching playbook, delegate with the task tool when delegation helps, verify real behavior, and name only principles that changed a decision.`,
      );
    if (sections.length === 0) return;
    return { systemPrompt: [...event.systemPrompt, ...sections] };
  });
}
