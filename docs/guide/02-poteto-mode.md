# Route work through `/poteto-mode`

`/poteto-mode` is the front door. You give it a goal, it matches one of the playbooks under [`skills/poteto-mode/playbooks/`](../../skills/poteto-mode/playbooks/), copies that playbook's steps into the todo list, and calls the other skills as the steps need them. Delegates run on omp's `task` tool, with `poteto-agent` for implementation work.

![A dispatcher pulls a switch lever to route robots on rail handcars toward lit gates, under a departure board listing Bug fix, Feature, and Investigation.](./images/router.jpg)

## What happens to your prompt

```mermaid
flowchart TD
    A[Your prompt] --> B[poteto-mode]
    B --> C[Read the Principles section]
    C --> D{Match the task}
    D -->|Read-only question| E[Investigation]
    D -->|Defect| F[Bug fix]
    D -->|New behavior| G[Feature]
    D -->|Structure only| H[Refactoring]
    D -->|Measured slowness| I[Perf issue]
    D -->|Large work or no match| J[figure-it-out]
    E --> K[Verify and report]
    F --> K
    G --> K
    H --> K
    I --> K
    J --> K
```

The diagram shows the common routes. The playbook set also covers hillclimbing a metric, diagnosing runtime symptoms and captured traces, prototypes, visual parity, authoring and evaluating skills, autonomous runs, opening a PR, babysitting a PR or stack to merge-ready, shipping a verified stack, running a PR queue or a stack on autopilot, session pickup, pausing safely, multi-phase plans, and worktree cleanup. [The skill index](../skills.md) lists all of them.

## The four commands

```text
/poteto-mode <task>          one-shot
/poteto-mode sticky [task]   keep Poteto Mode on across turns (and optionally run a task)
/poteto-mode off             stop sticky mode
/poteto-mode status          show sticky state
```

The plugin's extension registers `/poteto-mode`. Sticky mode injects the `poteto-mode` skill body as a hidden message, which is why it survives every turn while `/skill:poteto-mode` stays one-shot.

`/poteto-mode <task>` is one-shot. It loads the full skill for that message and fades as the chat moves on. `/poteto-mode sticky` keeps the workflow on every later turn until the session ends. `/poteto-mode sticky <task>` turns sticky on and runs `<task>` right away. `/poteto-mode off` stops it, and `/poteto-mode status` reports whether sticky is enabled.

`/skill:poteto-mode` is omp's native skill command. It is also one-shot and does not enable sticky mode. Use `/poteto-mode sticky` when you want the mode to persist.

Sticky mode is scoped to the session that enabled it. Switching sessions, branching, or navigating the session tree restores the sticky state recorded on that branch. `/clear` writes a reset boundary, so sticky stays off until you run `/poteto-mode sticky` again.

## Say the goal, not the ceremony

You do not write a spec. You say what is wrong or what you want, plus anything you already know that saves the agent time:

```text
/poteto-mode users get two notifications after a retry. repro first, then fix and verify.
```

That is a Bug fix prompt. "repro first" is a real constraint, not politeness, and the playbook honors it. Watch the todo list fill with the Bug fix steps.

## What goes in a prompt

A useful prompt carries up to five things, and each one fits in a sentence:

- **The goal.** Say what is wrong, or what you want.
- **The done check.** It must be able to pass or fail. "Make it better" and "work on it for an hour" are not checks.
- **The proof you want to see.** Ask for the real command output, a video of the flow, the stored value, or a before-and-after number.
- **What you already know.** A symptom, a repro step, a log line, or a link saves the agent a search.
- **The real constraints.** "repro first", "don't change any code yet", "zero behavior change", and "let me review before proceeding" each change what the agent does.

Here is one prompt with all five:

```text
/poteto-mode the csv export drops its last row since yesterday's deploy. failing job id is 4812. repro first, then fix. done means the 60k-row fixture exports every row. show me the row counts before and after.
```

Two things are worth leaving out:

- **The how.** Say what to achieve, and leave the agent room to find a better path than the one you would pick. The same goes for a list of skills, covered in the pitfall below.
- **Your theory of the cause, at first.** A stated guess narrows the search to wherever you pointed. Let the agent restate the problem before you share your hunch.

For a noisy report, such as a long thread or a vague bug, make the restatement the first step:

```text
/poteto-mode read this thread. restate the underlying issue in your own words, in plain english. don't change any code yet.
```

A misreading shows up in the restatement, before any code exists. Correct it there, and it costs one message instead of one wrong fix. For the restatement alone, with no playbook, run [`/skill:in-your-own-words`](../../skills/in-your-own-words/SKILL.md).

When you are unsure whether a prompt is aimed right, run [`/skill:sharpen`](../../skills/sharpen/SKILL.md) on it before you send it:

```text
/skill:sharpen write a migration guide for the v2 config format.
```

The agent says what a top professional would do that you did not ask for, the rawest material they would start from, the methods and tools they would use, and what other than you or the agent would show the result is right. Then it rewrites your prompt to ask for exactly that, deeper but not bigger. It does not do the task.

When you cannot name what you are after, run [`/skill:reframe`](../../skills/reframe/SKILL.md) on your own description and files first. It teaches the expert terms for what you are building, borrows terms from neighboring fields that solved the same problem, and rewrites your description with them.

## Follow up short

When the conversation already carries the context, the prompt shrinks to almost nothing. All of these are enough:

```text
/poteto-mode do it
```

```text
continue
```

```text
keep going until done
```

Short works because the playbook holds the structure. With sticky mode on, your words carry the intent and the skill carries the rigor.

## Switch tasks with "new task"

A long chat accumulates context from the last task. When you change subjects, say so:

```text
/poteto-mode new task. figure out why the cache entry survives logout. don't change any code yet.
```

"new task" tells `/poteto-mode` to re-match rather than continue the prior playbook. "don't change any code yet" pins this one to Investigation. Without those two phrases, a mode mid-Feature tends to treat your question as the next feature step.

## Give parallel work its own worktree

Several agents in one working tree fight over files, ports, and build output. Parallel work runs locally, so isolate it yourself.

When `task.isolation.enabled` is on, a brief that passes `isolated: true` runs in its own copy-on-write worktree. You can also ask for a worktree up front:

```text
/poteto-mode new task. branch off main in a fresh worktree, then port the parser change there.
```

Each task in its own branch and worktree means no agent stomps another's files. Worktrees cost disk, so a laptop runs only a handful at once. The [Opening a PR playbook](../../skills/poteto-mode/playbooks/opening-a-pr.md) already works from a worktree for code changes, so mostly you only say this when a specific base or location matters.

Worktrees accumulate. When disk gets tight, ask:

```text
/poteto-mode what's eating my disk? prune the worktrees that are safe to prune.
```

The [Worktree cleanup playbook](../../skills/poteto-mode/playbooks/worktree-cleanup.md) classifies every worktree by merge state, uncommitted work, and which chats still touch it. It deletes only what that evidence clears and pauses for your call on anything holding uncommitted work.

## Leave it running

When you step away, say what done means and go:

```text
/poteto-mode im stepping away. keep going until the migration check reports zero old callers. log your decisions.
```

Work you will review later routes through [`/skill:figure-it-out`](../../skills/figure-it-out/SKILL.md), which designs the run's phases and keeps a [`/skill:show-me-your-work`](../../skills/show-me-your-work/SKILL.md) decision log. [Run work while you sleep](./07-overnight.md) covers the full overnight contract.

**Pitfall:** do not enumerate skills in your prompt ("use `/skill:architect`, then `/skill:arena`, then `/skill:interrogate`"). The playbook already sequences them, and a hand-written sequence usually reorders or drops steps the playbook would have kept. Name a skill only when you want to override a specific choice.

Read [`poteto-mode`](../../skills/poteto-mode/SKILL.md) itself for the full routing rules.

Next: [Understand the code](./03-understand.md).
