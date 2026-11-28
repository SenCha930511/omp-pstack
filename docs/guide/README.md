# The omp-pstack guide

omp-pstack gives omp the pstack skills, the Poteto Mode workflow, and two bundled agents. This guide teaches the workflow with realistic prompts. It describes this fork's behavior on omp only. [NOTICE.md](../../NOTICE.md) records what came from Cursor's pstack and what this fork changed.

Here is what you will learn:

1. [Set up omp-pstack](./01-setup.md). Install the plugin, keep the skill catalog small, and route models per agent.
2. [Route work through `/poteto-mode`](./02-poteto-mode.md). Give it a goal and watch it pick a playbook.
3. [Understand the code](./03-understand.md). A read-only investigation, then `/skill:how`, `/skill:why`, `/skill:teach`, and `/skill:recall` before you edit anything.
4. [Design the change](./04-design.md). `/skill:architect`, `/skill:arena`, `/skill:swarm`, `/skill:interrogate`, prototypes, and plans before code locks in a shape.
5. [Build and clean the change](./05-build-and-clean.md). The build playbooks, `/skill:tdd`, `/skill:unslop`, and `/skill:no-comments`.
6. [Verify and ship](./06-verify-and-ship.md). Prove behavior on the real app, formally verify what tests rarely reach, vet numbers with `/skill:benchmark-checklist`, then open a focused PR and drive it to merge-ready.
7. [Run work while you sleep](./07-overnight.md). Trust before loops, a checkable overnight contract, a decision log you can audit, and Autopilot for a queue of PRs.
8. [Steer with principle names](./08-principles.md). The names that redirect an agent mid-task.
9. [Make it yours](./09-make-it-yours.md). Your own mode, `/skill:correct` for repeated mistakes, and how to test a skill change.
10. [Recipes and pitfalls](./10-recipes-and-pitfalls.md). Prompts to copy and mistakes to skip.

Read the pages in order the first time. After that, each page stands alone.

[`docs/skills.md`](../skills.md) is the generated index. It lists every bundled skill with its own description, groups the workflow skills separately from the principles, and links every playbook. Regenerate it with `node scripts/docs-index.mjs` after you add or rename a skill.

When you are stuck, or cannot tell which skill fits, ask [`/skill:poteto-help`](../../skills/poteto-help/SKILL.md):

```text
/skill:poteto-help which skill should i use to review this branch?
```

It answers, hands you a prompt to send, and links the file the answer came from. It does not start the work. A pstack run spends real tokens, so you send the prompt when you are ready.

If an agent is installing this for you, point it at [AGENT-INSTALL.md](../../AGENT-INSTALL.md). That file covers the host check, the skill configuration keys, and hide mode.

## If you only remember one thing

Give the agent a goal and a way to check it, in your own words:

```text
/poteto-mode the export writes duplicate rows when a retry lands mid-run. repro first, then fix and verify.
```

You do not need to name a playbook or list skills. "repro first" and a checkable outcome are all the routing signal `/poteto-mode` needs. It matches the Bug fix playbook, copies the steps into the todo list, and calls the other skills as each step fires.

Next: [Set up omp-pstack](./01-setup.md).
