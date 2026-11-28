# omp-pstack

[![npm version](https://img.shields.io/npm/v/omp-pstack.svg)](https://www.npmjs.com/package/omp-pstack)
[![npm downloads](https://img.shields.io/npm/dm/omp-pstack.svg)](https://www.npmjs.com/package/omp-pstack)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](package.json)
[![OMP plugin](https://img.shields.io/badge/OMP-plugin-7c3aed)](https://github.com/SenCha930511/omp-pstack)
[![skills](https://img.shields.io/badge/skills-58-2ea44f)](skills/)
[![GitHub stars](https://img.shields.io/github/stars/SenCha930511/omp-pstack)](https://github.com/SenCha930511/omp-pstack/stargazers)

pstack skills, Poteto Mode, and the bundled `poteto-agent` / `comment-sicko`
agents, adapted for **omp (oh-my-pi)**. This is an omp-only fork of
[`@casualjim/pi-pstack`](https://github.com/casualjim/pi-mimir), which is a fork
of [Cursor's pstack](https://github.com/cursor/plugins/tree/main/pstack).

The skills use omp's native tools. There is no pi-herdr-agents dependency and
no `subagent` tool registration.

## Install

From this repo's own marketplace:

```sh
omp plugin marketplace add SenCha930511/omp-pstack
omp plugin install omp-pstack@omp-pstack
```

`marketplace add` reads the catalog from the repository tree OMP fetches. It
does not track your working checkout, and `"./"` does not re-fetch latest
`main` on every install. To pick up catalog changes, update the marketplace
first:

```sh
omp plugin marketplace update omp-pstack
omp plugin upgrade omp-pstack@omp-pstack
```

OMP compares version numbers. If the catalog head has new commits but
`package.json` still carries the installed version, `upgrade` treats it as
current. For an unreleased head, reinstall the same version explicitly:

```sh
omp plugin install omp-pstack@omp-pstack --force
```

The marketplace path copies the whole catalog tree into OMP's plugin cache,
including tests, scripts, docs, and guide images. npm's `files` whitelist does
not apply to a marketplace install. The npm tarball still contains only the
published files.

The external catalog at
[`SenCha930511/omp-marketplace`](https://github.com/SenCha930511/omp-marketplace)
and the published npm package remain supported:

```sh
omp plugin marketplace add SenCha930511/omp-marketplace
omp plugin install omp-pstack@sencha930511
omp plugin install npm:omp-pstack
```

To pin the npm version, use `omp plugin install npm:omp-pstack@0.3.3`.

### Switching install sources

One OMP install scope can have only one runtime package named `omp-pstack`.
npm, the `sencha930511` marketplace entry, and the `omp-pstack` marketplace
entry cannot coexist there. OMP rejects the second install with:

```text
Runtime package name "omp-pstack" conflicts with installed plugin "..."
```

Uninstall the current entry before installing from another source:

```sh
omp plugin uninstall omp-pstack@sencha930511
omp plugin install omp-pstack@omp-pstack
```

For an npm install, uninstall `omp-pstack` first. Restart OMP after the switch,
then check `/skill:poteto-mode` and the hide mode in
[AGENT-INSTALL.md](AGENT-INSTALL.md).

For local development:

```sh
omp plugin link /path/to/omp-pstack
```

If you are an agent installing this for a user, follow
[AGENT-INSTALL.md](AGENT-INSTALL.md). It covers the host check, the
`skills.includeSkills` allowlist, and verification.

## Quick start

```text
/poteto-mode implement the retry fix and verify it
```

`/poteto-mode <task>` loads the full Poteto Mode skill for one task. The skill
matches the task to a playbook, copies its steps into the `todo` list, and
delegates through omp's `task` tool.

Use `/poteto-mode sticky` to keep the workflow on every later turn, or
`/poteto-mode sticky <task>` to enable sticky mode and run `<task>` right away,
and `/poteto-mode off` to stop it. `/poteto-mode status` shows the current state.
`/skill:poteto-mode` remains omp's native one-shot skill command and does not
enable sticky mode.

Other entry points:

```text
/skill:no-comments        review comments with comment-sicko
/skill:setup-pstack       configure per-agent model routing
/skill:poteto-help        pick a skill or debug a run
```

Every bundled skill is registered. A non-empty `skills.includeSkills` allowlist
filters skills out of the session, so include the pstack names or clear it. The
default empty allowlist loads them all.

## What's included

- 58 skills under `skills/`, adapted from upstream, including `reframe`. They are
  registered; 57 are hidden from the model catalog and `setup-pstack` starts
  visible, then hides itself after it writes the routing.
- `agents/poteto-agent.md` and `agents/comment-sicko.md`. omp discovers them
  from the plugin's `agents/` directory; no role pack is needed. `poteto-agent`
  autoloads `poteto-mode` and can spawn its own subagents; `comment-sicko`
  deletes bad comments with `edit` and inspects git history with `bash`, and
  cannot spawn.
- A small extension that implements `/poteto-mode` one-shot,
  `/poteto-mode sticky [task]`, and `/poteto-mode off`. Sticky content is injected as a
  hidden `custom_message`; off filters it.

Poteto Mode is scoped to the session that enabled it. Switching sessions,
branching, or navigating the session tree restores sticky state from that
branch's `pstack-mode` entries. `/clear` writes a reset boundary, so sticky
stays off until you run `/poteto-mode sticky` again. One-shot
`/poteto-mode <task>` affects one message only.

## omp adaptations

| Upstream (pi / pi-herdr-agents) | This fork (omp) |
| --- | --- |
| `subagent` tool | `task` tool |
| `subagents_write_task_models` | `task.agentModelOverrides` or `pi-model-sync` |
| `models.tasks` / `models.agents` | `task.agentModelOverrides`, or `pi-model-sync` presets |
| `set_tasks` | `todo` |
| per-call `role` | per-call `model` when `task.perCallModel` is on |
| pi-herdr role pack | omp's conventional `agents/` discovery |
| `/poteto-mode` extension command | `/poteto-mode <task>` one-shot, `/poteto-mode sticky [task]`, `/poteto-mode off`, `/poteto-mode status` |
| `/skill:poteto-mode` | omp native one-shot; does not enable sticky |

Every bundled skill is registered. All but `setup-pstack` are hidden from the
model catalog, so `/skill:<name>` and `skill://<name>` both resolve them. A
non-empty `skills.includeSkills` allowlist removes skills from the session;
include the pstack names or clear it. `skills.ignoredSkills` and
`disabledExtensions` can remove one too. The default empty allowlist needs no setup.

Prompt-level autonomy matches Cursor. Host-level approvals are controlled
separately by `tools.approvalMode`.

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
    poteto-agent: anthropic/claude-opus-5.5
    comment-sicko: openai/gpt-5.4-mini
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
    - anthropic/claude-opus-5.5
    - openai/gpt-5.4
    - anthropic/claude-sonnet-5.5
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

`npm test` checks skill and agent frontmatter, local
Markdown links, stale Cursor references, unsupported agent fields,
and extension behavior. `npm run typecheck` checks both the extension sources
and the test sources. `npm run check` runs all checks including version
consistency, extension load-graph verification, release and upstream-sync script
tests, and clean tarball installation against `omp`. Use
`npm run release:bump <X.Y.Z>` when preparing a new release version.

### Upstream sync

`.github/workflows/upstream-sync.yml` runs daily to track
[`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack)
and [`casualjim/pi-mimir`](https://github.com/casualjim/pi-mimir) using the
manifest in [`.github/upstream-sync.json`](.github/upstream-sync.json). Unadapted
and new skills without Cursor-only syntax are synced automatically into a PR;
changes to adapted skills, blocked skills, or extension/agent files are flagged
for manual porting. After porting, record the synced SHAs (and any newly adapted
blocked skills) with `npm run sync:ack -- --cursor <sha> [--pi-mimir <sha>] [--adapt <skill> ...]`,
or record individual adapted skills before finishing everything with
`npm run sync:ack -- --adapt-only --adapt <skill>`.
