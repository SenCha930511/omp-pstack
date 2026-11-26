# omp-pstack

pstack skills, Poteto Mode, and the bundled `poteto-agent` / `comment-sicko`
agents, adapted for **omp (oh-my-pi)**. This is an omp-only fork of
[`@casualjim/pi-pstack`](https://github.com/casualjim/pi-mimir), which is a fork
of [Cursor's pstack](https://github.com/cursor/plugins/tree/main/pstack).

The skills use omp's native tools. There is no pi-herdr-agents dependency and
no `subagent` tool registration.

## Install

```sh
omp plugin install omp-pstack
```

For local development:

```sh
omp plugin link /path/to/omp-pstack
```

## Quick start

```text
/skill:poteto-mode implement the retry fix and verify it
```

`/skill:poteto-mode` loads the full Poteto Mode skill and marks the session
sticky. Every later turn keeps the workflow until the session ends. The skill
matches the task to a playbook, copies its steps into the `todo` list, and
delegates through omp's `task` tool.

Other entry points:

```text
/skill:no-comments        review comments with comment-sicko
/skill:setup-pstack       configure per-agent model routing
/skill:poteto-help        pick a skill or debug a run
```

These commands require the skill to be registered in `skills.includeSkills`. On a
setup that only registers `poteto-mode`, read the skill files through
`skills/poteto-mode/SKILL-INDEX.md` instead.

## What's included

- 58 skills under `skills/`, adapted from upstream, including `reframe`.
  `skills/poteto-mode/SKILL-INDEX.md` lists every bundled skill and its relative path.
- `agents/poteto-agent.md` and `agents/comment-sicko.md`. omp discovers them
  from the plugin's `agents/` directory; no role pack is needed.
- A small extension that keeps Poteto Mode sticky across turns.

## omp adaptations

| Upstream (pi / pi-herdr-agents) | This fork (omp) |
| --- | --- |
| `subagent` tool | `task` tool |
| `subagents_write_task_models` | `task.agentModelOverrides` or `pi-model-sync` |
| `models.tasks` / `models.agents` | `task.agentModelOverrides`, or `pi-model-sync` presets |
| `set_tasks` | `todo` |
| per-call `role` | per-call `model` when `task.perCallModel` is on |
| pi-herdr role pack | omp's conventional `agents/` discovery |
| `/poteto-mode` extension command | `/skill:poteto-mode` (the extension marks it sticky) |

Only `poteto-mode` is registered by default when your `skills.includeSkills`
allowlist contains just that skill. The other pstack skills, `reframe` included,
are read as files: `skills/poteto-mode/SKILL-INDEX.md` gives every relative path,
so the model does not need to use skill URI syntax and fail.

## Model routing

omp's `task` tool resolves a subagent model in this order:

1. `task.agentModelOverrides[agent]`
2. the agent's frontmatter `model`
3. the parent session's model

To pin an agent globally, add it to `task.agentModelOverrides` in
`~/.omp/agent/config.yml`:

```yaml
task:
  agentModelOverrides:
    poteto-agent: nchc/GLM-5.3:max
    comment-sicko: nchc/GLM-5.3:low
```

If you use [`pi-model-sync`](https://github.com/SenCha930511/pi-model-sync),
write the same mapping into its preset instead. Do not set both for one agent:
model-sync treats an override as an explicit per-call model and skips it.

### Multi-model panels

`swarm`, `arena`, and `interrogate` can run each seat on a different model. That
requires omp's per-call model selection:

```yaml
task:
  perCallModel: "on"
  perCallModelAllow:
    - nchc/GLM-5.3
    - nchc/Kimi-K3.1-Pro
    - nchc/Voldemort-V4.1-Flash
```

The models must also be granted through a configured chat role or an agent's
frontmatter `model`. Do not put an agent used by a panel in
`task.agentModelOverrides`; a per-call `model` and an override conflict.

Without per-call selection, every seat uses the agent's configured model.

## Attribution

This project is derived from:

- [pstack](https://github.com/cursor/plugins/tree/main/pstack), Copyright (c)
  2026 Lauren Tan, MIT.
- [pi-pstack](https://github.com/casualjim/pi-mimir), MIT, by casualjim.

The original MIT license is preserved in [LICENSE](LICENSE). See
[NOTICE.md](NOTICE.md) for the full provenance and the list of changes.

## Development

The extension and skills are TypeScript and Markdown; omp runs them directly.

```sh
npm install
npm run typecheck
npm test
npm run pack:check
npm run check
```

`npm test` checks skill/agent frontmatter, the relative-path index, stale
pi-herdr or Cursor references, and extension behavior. `npm run check` runs all
checks including version consistency, extension load-graph verification, release
and upstream-sync script tests, and clean tarball installation against `omp`. Use
`npm run release:bump <X.Y.Z>` when preparing a new release version.

### Upstream sync

`.github/workflows/upstream-sync.yml` runs daily to track
[`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack)
and [`casualjim/pi-mimir`](https://github.com/casualjim/pi-mimir) using the
manifest in [`.github/upstream-sync.json`](.github/upstream-sync.json). Unadapted
and new skills without Cursor-only syntax are synced automatically into a PR with
an updated `SKILL-INDEX.md`; changes to adapted skills, blocked skills, or
extension/agent files are flagged for manual porting.
