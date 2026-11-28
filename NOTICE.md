# Notices and provenance

omp-pstack is an omp-only fork of
[`@casualjim/pi-pstack`](https://github.com/casualjim/pi-mimir), which is a fork
of [Cursor's pstack](https://github.com/cursor/plugins/tree/main/pstack).

## Upstream copyright and license

- pstack: Copyright (c) 2026 Lauren Tan. MIT License. The full text is in
  [LICENSE](LICENSE).
- `@casualjim/pi-pstack`: MIT License, by casualjim.

The original MIT license and copyright notice are preserved. The fork's
changes are also released under the MIT License.

## Changes in this fork

- Delegation uses omp's native `task` tool instead of pi-herdr-agents'
  `subagent` tool.
- Model routing uses omp's `task.agentModelOverrides` or optional
  `pi-model-sync` presets instead of `subagents_write_task_models`,
  `models.tasks`, and `models.agents`.
- Task tracking uses omp's `todo` tool instead of `set_tasks`.
- Panel skills (`swarm`, `arena`, `interrogate`) use omp's per-call `model`
  with `task.perCallModel: "on"` and `task.perCallModelAllow`.
- The pi-herdr-agents role-pack registration was removed. omp discovers the
  bundled agents from `agents/`.
- `/poteto-mode` provides one-shot `<task>`, `sticky`, `off`, and `status`.
  `/skill:poteto-mode` remains omp's native one-shot and does not enable sticky.
- Sticky mode injects the full skill as a hidden `custom_message`; `off`
  filters it.
- Prompt-level autonomy follows the skill's Autonomy section: reversible work
  and external actions proceed without asking, while force-pushes to shared
  branches, deploys, data deletion, and customer messages pause for the
  operator. Host approvals are controlled by `tools.approvalMode`.
- `how` and `arena` use `scout`; `interrogate` uses `task`. `comment-sicko`
  keeps explicit tools (`read`, `grep`, `glob`, `edit`, `bash`).
- Skills are registered; all but `setup-pstack` are hidden from the model catalog, and `/skill:<name>` and `skill://<name>` both resolve them.
- The extension was reduced to omp-only code paths.

## Guide and images

`docs/guide/` is written for this fork. Its chapter structure and the six
images in `docs/guide/images/` come from the pstack guide
(`pstack/docs/guide/`) in Cursor's plugin repository at commit
`9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc`. The prose is rewritten for omp's
actual behavior and is not a copy of that guide.

The images are Copyright (c) 2026 Lauren Tan, MIT License, and are
redistributed under the same license. They illustrate the workflow. They are
not screenshots of omp-pstack.

This repository publishes no adapter for another host. The guide documents omp
only.

## Names

`pstack` and `Poteto Mode` are the names of the upstream projects. This fork is
not affiliated with Cursor or with the pi-pstack maintainers.
