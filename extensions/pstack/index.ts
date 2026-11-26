import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { preferredAskTool } from "./interaction.js";

const MODE_ENTRY = "pstack-mode";

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export default function (pi: ExtensionAPI) {
  let potetoMode = false;

  pi.on("session_start", (_event, ctx) => {
    potetoMode = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === MODE_ENTRY)
        potetoMode = Boolean((entry.data as { enabled?: boolean }).enabled);
    }
    if (ctx.hasUI)
      ctx.ui.setStatus("pstack-mode", potetoMode ? "pstack: poteto mode" : undefined);
  });

  pi.on("input", (event) => {
    if (/^\/skill:poteto-mode(?:\s|$)/.test(event.text)) {
      potetoMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true });
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    const sections: string[] = [];
    if (ctx.hasUI) {
      const ask = preferredAskTool(pi);
      if (ask) sections.push(`When you need user input, use the ${ask} tool.`);
    }
    if (potetoMode)
      sections.push(
        `Pstack Poteto Mode is enabled for this session. Follow its persisted workflow: track non-trivial work with the todo tool, select and read the matching playbook, delegate with the task tool when delegation helps, verify real behavior, and name only principles that changed a decision. The full skill is at ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")}.`,
      );
    if (sections.length === 0) return;
    return { systemPrompt: [`${event.systemPrompt.join("\n\n")}\n\n${sections.join("\n\n")}`] };
  });
}
