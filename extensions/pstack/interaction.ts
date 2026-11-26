type AskTool = "ask";
type Host = { getActiveTools?(): string[] };
type Option = { label: string; description?: string; preview?: string };
type AskDialog = (questions: { id: string; question: string; options: Option[] }[]) => Promise<
  | { kind: "submit"; results: { id: string; selectedOptions: string[]; customInput?: string; timedOut?: boolean }[] }
  | { kind: "chat" }
  | undefined
>;
type InteractionContext = {
  hasUI: boolean;
  ui: object;
};

export function preferredAskTool(host: Host): AskTool | undefined {
  const active = host.getActiveTools?.() ?? [];
  return active.includes("ask") ? "ask" : undefined;
}

function selectedLabel(selection: unknown): string | undefined {
  return Array.isArray(selection) && selection.length === 1 && typeof selection[0] === "string"
    ? selection[0]
    : undefined;
}

// null means the host has no ask dialog; undefined means a prompt opened but
// did not return one of the offered choices.
async function askChoice(ctx: InteractionContext, question: string, options: Option[]): Promise<string | null | undefined> {
  const ui = ctx.ui as { askDialog?: AskDialog };
  if (!ui.askDialog) return null;
  const id = "choice";
  const result = await ui.askDialog([{ id, question, options }]);
  const answer = result?.kind === "submit" && result.results.length === 1 ? result.results[0] : undefined;
  const label = answer?.id === id && !answer.timedOut && answer.customInput === undefined
    ? selectedLabel(answer.selectedOptions)
    : undefined;
  return options.find((option) => option.label === label)?.label;
}

export async function confirmUser(
  ctx: InteractionContext,
  title: string,
  message: string,
  preview?: string,
): Promise<boolean | undefined> {
  if (!ctx.hasUI) return;
  const choice = await askChoice(ctx, message, [{ label: "Decline" }, { label: "Allow", preview }]);
  if (choice !== null) return choice === "Allow";
  const ui = ctx.ui as { confirm?(title: string, message: string): Promise<boolean> };
  return ui.confirm?.(title, preview ? `${message}\n\n${preview}` : message);
}
