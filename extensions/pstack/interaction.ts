type AskTool = "ask";
type Host = { getActiveTools?(): string[] };

export function preferredAskTool(host: Host): AskTool | undefined {
  const active = host.getActiveTools?.() ?? [];
  return active.includes("ask") ? "ask" : undefined;
}
