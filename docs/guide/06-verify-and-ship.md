# Verify the result and open a PR

"It compiles" is not evidence. The [Prove It Works principle](../../skills/principle-prove-it-works/SKILL.md) makes the agent check the real artifact before it reports success, and your job is to make "the real artifact" checkable. This page covers stating a finish condition, vetting a measured number, generating a verification skill for your app, formally verifying a property tests rarely reach, opening the PR, and driving it to merge-ready.

Verification is the slowest step in most agent work, because it is the step that usually waits on a human. Make the agent able to do it, and you stop being the bottleneck. Skip it, and running more agents only gets you more unchecked work to review.

![A prototype plane flies a real test course while she times it with a stopwatch and robots film and checklist the run.](./images/verification.jpg)

## State the finish condition up front

Put what done means in the first prompt, in whatever words fit:

```text
/poteto-mode add json output to this command. text output stays byte-identical, the json parses, both run against the sample project. show me the evidence.
```

Now the agent has three checks it can run, not a mood to satisfy. When the reply comes back, it should carry the exact commands and outputs. If a check could not run, a good reply says "inconclusive". A confident reply without evidence is a warning sign.

Match the check to the change:

- A CLI change runs the real command.
- A UI change walks the changed flow in the running app. When it must match a reference pixel for pixel, the [Visual parity playbook](../../skills/poteto-mode/playbooks/visual-parity.md) diffs screenshots against a frozen baseline instead of judging by eye.
- A parser or migration replays a saved input.
- A perf change compares before and after profiles.
- A storage change reads back the written value.

Ask for the proof as an artifact you can inspect yourself: the failing test and then the passing one, a before-and-after video, the trace, the screenshot. If the fix already merged, ask for the same check again on main. An artifact beats a plausible explanation, because you can challenge it without replaying the whole run.

For a small diff you do not fully trust, [`/skill:blast-radius`](../../skills/blast-radius/SKILL.md) finds what it could break elsewhere. It finds the one fact that makes the change safe and proves that fact by running code, not by arguing for it.

## Vet a measured number with `/skill:benchmark-checklist`

A before-and-after number is the easiest evidence to get wrong by accident. A warm cache, a debug build on one side, or work that never ran inside the timed region can each produce a convincing speedup. Before you report or act on a number, type:

```text
/skill:benchmark-checklist vet the export speedup before it goes in the pr
```

[`benchmark-checklist`](../../skills/benchmark-checklist/SKILL.md) asks seven questions and wants evidence from a run for each:

1. What limits the number, and why is it not double?
2. Did every side run tuned the way production runs?
3. Does the result break a physical limit, like disk bandwidth or core count?
4. Did anything error or return wrong output?
5. Does it reproduce over alternating runs, with a median and a range?
6. Does it matter end to end, on the path a user waits on?
7. Did the work actually happen inside the timed region?

The verdict comes back as faster, slower, no measurable difference, or inconclusive, with the run count, range, and limiter. It says inconclusive when it cannot name the limiter or a side ran untuned. `/poteto-mode` already runs the checklist inside the Perf issue and Hillclimb playbooks, so you type it yourself when you measured something outside them, or when someone else's number looks too good. It is the working form of the [Explain the Number principle](../../skills/principle-explain-the-number/SKILL.md).

## Create a project verification skill

The UI bullet above hides a real requirement. The agent needs a scripted way to drive your app. If your project has one, great. If not, run:

```text
/skill:create-verification-skill
```

[`create-verification-skill`](../../skills/create-verification-skill/SKILL.md) interviews the repository, not you. It works out what a user touches, how the app launches locally, what can drive it (an existing harness first, otherwise browser and CDP, a PTY, or plain HTTP), what evidence proves behavior, and whether two instances can run side by side. It asks you only what the code cannot answer.

It writes `.omp/skills/verify-<app>/`, agent-facing instructions with exact Launch, Doctor, Drive, Evidence, and Cleanup sections, a Helpers section for any script it ships, plus a feature map under `features/` that indexes what the app does and what result proves each feature works. omp also loads project skills from `.agents/skills/`, so a repo that already keeps project skills there has a second valid root. The generator writes `.omp/skills/` by default.

Before handing it over, the generator proves the skill once end to end: launch, doctor check, drive one feature, capture evidence, clean up, then confirm the evidence survived the cleanup. If that proof fails, do not use the output.

From then on, "verify it in the app" is a step any agent can execute, in this repo, with no setup conversation. Name the generated skill in the prompt when you want the proof in a specific form:

```text
/poteto-mode build the bulk-archive action. use verify-web to verify your changes and show me a video and screenshots as proof.
```

```text
/poteto-mode repro this with verify-web. if it repros on main, fix it and show me a video as proof.
```

The generated skill registers like any other project skill, so a new session resolves it with the usual skill command. Once it works, a [`/skill:swarm`](../../skills/swarm/SKILL.md) can split a full pass by feature-map entry and aggregate the results. A swarm of verifiers also confirms a perf win over a big enough sample, or fuzzes the app for regressions before a PR ships.

Treat the verification skill as infrastructure, not a one-off. Commit it, so every person and every agent on the team drives the app the same way. When agents keep writing throwaway scripts to click through the app, ask for a small control CLI that the skill calls instead. Agents spend fewer tokens, and every run becomes repeatable.

## Keep the verification skill honest

Apps change, and feature maps go out of date. Run this at least once a day, ideally from a scheduled automation so nobody has to remember:

```text
/skill:maintain-verification-skill
```

[`maintain-verification-skill`](../../skills/maintain-verification-skill/SKILL.md) audits the generated skill: one read-only `scout` per feature in parallel, then one live pass that drives every mapped feature. It ends in exactly one of three outcomes. `clean` means full coverage and nothing to ship. `changed` means one PR of proven corrections, confined to the verification skill's own directory. `blocked` names the blocker. It never edits product code. If the live pass catches a product regression, it reports the regression instead of hiding it with a doc edit.

## Prove a property with a formal verification skill

A verification skill proves the paths you drive. Some bugs live on paths nobody drives: two retries that overlap, a lock that expires mid-write, a state change that arrives out of order. Tests rarely reach those cases. For code where such a bug is costly, run:

```text
/skill:create-formal-verification-skill
```

[`create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md) picks the target from the code: a promise the code makes, where a break harms users and tests rarely reach the case that breaks it. It picks the strongest target, not the easiest to verify. Name an area or a bug to start there instead:

```text
/skill:create-formal-verification-skill the job lease and retry logic. a job must never run twice at once.
```

The question picks the tool. Whether events can happen in a bad order suits a model checker over a small model of the design, and TLA+ is the default for that in any language. Whether the code behaves for every input suits a verifier that runs on the code. If no verifier runs on your language, the agent says so and tests the real code with generated inputs, not a hand-written model of the function. The agent tells you which tool it chose and why.

It verifies one property and shows that property failing on a broken variant of the code, because a check you have never seen fail proves nothing. When the current code already breaks the property, you get the counterexample as a short sequence of steps in your code's terms. The property stays as stated, so the finding stays a finding. Product code does not change unless you ask.

It writes a project-local skill that tells the next agent whether a change touches the verified code, how to run the check with one command, and how to tell a real bug from a modeling error. The handoff says what was verified, with which tool and bounds, what the check found, and what it does not cover. A pass covers the model or the bound, not the whole system.

The skill also records which code each check covers and the commit where the check last matched it. Merges and refactors that skip the skill can leave the check passing on a description of code that is gone. After them, run [`/skill:maintain-formal-verification-skill`](../../skills/maintain-formal-verification-skill/SKILL.md). It updates the verification from the code, reruns it, shows that each updated check can still fail, and tells you whether each failure is drift in the verification or a bug in the code.

## Show the behavior as a statechart

A counterexample in model terms convinces you. The PM or designer who owns the behavior needs to see it in their terms. Run:

```text
/skill:statechart what the user sees when they edit a note offline
```

[`statechart`](../../skills/statechart/SKILL.md) checks a TLA+ model of a system that moves between states, then draws a Mermaid statechart of what the user sees, so the picture and the checked model cannot drift apart. The reader's rules ("you never see Synced while you're offline") become invariants. The chart marks each state that breaks a rule, and the report gives the shortest path to it in the reader's words. When the model describes code, the agent replays each bug path against the real code, so a modeling error does not reach the reader as a bug.

## Open the PR

```text
/poteto-mode open the pr. small ordered commits, evidence in the description.
```

The [Opening a PR playbook](../../skills/poteto-mode/playbooks/opening-a-pr.md) works from a git worktree off trunk, rebases the work into small landable commits, runs the unslop pass over the diff, writes a one-minute briefing as the body, and opens the PR ready. The body stays under 40 lines with these headings in order, dropping empty ones: `## Why`, `## What changed`, `## Scope`, `## Tradeoffs`, `## Blast Radius`, `## Verification`. It uses `gh pr create` without `--draft` by default, or `origin pr create --status open` when Origin's CLI resolves the repository. Stacked follow-ups beat a growing branch.

## Drive the PR to merge-ready with Babysit

An open PR starts collecting blockers immediately. Checks fail, reviewers comment, trunk moves. Hand that churn to the [Babysit playbook](../../skills/poteto-mode/playbooks/babysit.md):

```text
/poteto-mode babysit this pr. get it green.
```

Babysit declares a mode in its first line: `drive` loops to merge-ready, `threads-only` touches only review threads, and `check` is one status pass and a report. It uses `gh` by default, or `origin pr` when Origin's CLI resolves the repository. On GitHub, the bundled watcher at [`scripts/watch-pr/watch-pr`](../../skills/poteto-mode/scripts/watch-pr) supplies status. It takes blockers in order: conflicts, then review threads, then CI. It never rebases, retargets, or force-pushes. A conflict or a stale base comes back to you with the branch that needs the rebase. Comment triage is skeptical, because humans and bots file real catches and noise in the same list. A real finding gets a fix, and noise gets dismissed with the disproof posted on the thread. When all you want is status, ask smaller and Babysit answers without starting the loop:

```text
/poteto-mode check on pr 123. anything outstanding?
```

Babysit stops at merge-ready. It never merges, even with everything green, because merging is a different decision.

## Land the stack with Shipping

Green is not the same as safe. When you are ready to land, say so:

```text
/poteto-mode land the stack.
```

The [Shipping playbook](../../skills/poteto-mode/playbooks/shipping.md) verifies each PR independently before it arms anything. One fresh agent per PR runs the change the way a user would, parent against head, on the matching surface, and posts `PASS`, `PASS+NOTES`, or `FAIL`. Only a verdict from an agent that did not write the code counts. Then Shipping lands only the contiguous verified run from the bottom, one PR at a time, through `gh pr merge --squash` or `origin pr merge`, and reports the first PR that breaks the chain. A verified PR sitting above an unverified one waits, because merging it would pull the gap in underneath. A chain rebase moves every PR above it to a new SHA, so Shipping compares `git patch-id` before trusting an older verdict.

Next: [Run work while you sleep](./07-overnight.md).
