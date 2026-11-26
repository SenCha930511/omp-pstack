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
- The broken `/poteto-mode` extension command was removed. Use
  `/skill:poteto-mode`; the extension marks it sticky.
- The extension was reduced to omp-only code paths.

## Names

`pstack` and `Poteto Mode` are the names of the upstream projects. This fork is
not affiliated with Cursor or with the pi-pstack maintainers.
