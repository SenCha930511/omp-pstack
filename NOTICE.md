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
- `skills/poteto-mode/SKILL-INDEX.md` lists relative paths for every bundled
  skill so they can be read as files when they are not registered with the
  host.
- The pi-herdr-agents role-pack registration was removed. omp discovers the
  bundled agents from `agents/`.
- `/poteto-mode` provides one-shot `<task>`, `sticky`, `off`, and `status`.
  `/skill:poteto-mode` remains omp's native one-shot and does not enable sticky.
- Sticky mode injects the full skill as a hidden `custom_message`; `off`
  filters it.
- Autonomy matches Cursor: PR creation and updates, CI triggers, and merges do
  not need prompt-level confirmation. Host approvals are controlled by
  `tools.approvalMode`.
- `how` and `arena` use `scout`; `interrogate` uses `task`. `comment-sicko`
  keeps explicit read-only tools (`read`, `grep`, `glob`).
- Relative skill paths and `SKILL-INDEX.md` are unchanged.
- The extension was reduced to omp-only code paths.

## Names

`pstack` and `Poteto Mode` are the names of the upstream projects. This fork is
not affiliated with Cursor or with the pi-pstack maintainers.
