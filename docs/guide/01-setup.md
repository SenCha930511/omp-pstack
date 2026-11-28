# Set up omp-pstack

omp-pstack is an omp plugin. You install it once, optionally route a model to each pstack agent, then run work through `/poteto-mode`. Setup is two commands and one short conversation.

## Check the host

```sh
omp --version
```

omp 19.2 or newer. For an npm install, Node 22 or newer.

## Install from this repository's marketplace

The repository ships its own marketplace catalog:

```sh
omp plugin marketplace add SenCha930511/omp-pstack
omp plugin install omp-pstack@omp-pstack
```

`marketplace add` reads the catalog from the repository tree omp fetches. It does not track your working checkout. A local edit is invisible to this install until you publish it, or until you use `omp plugin link` for development.

The marketplace path copies the whole catalog tree into omp's plugin cache, including tests, scripts, docs, and the guide images. npm's `files` whitelist does not apply to a marketplace install.

## Install from the external catalog or npm

Both remain supported:

```sh
omp plugin marketplace add SenCha930511/omp-marketplace
omp plugin install omp-pstack@sencha930511
```

```sh
omp plugin install npm:omp-pstack
omp plugin install npm:omp-pstack@0.3.3
```

The second npm command pins a version.

### Switch install sources

One omp install scope can hold only one runtime package named `omp-pstack`. The npm package, the `sencha930511` marketplace entry, and the `omp-pstack` marketplace entry cannot coexist there. omp rejects the second install with a runtime package name conflict.

Uninstall the current entry first, then install from the other source:

```sh
omp plugin uninstall omp-pstack@sencha930511
omp plugin install omp-pstack@omp-pstack
```

For an npm install, uninstall `omp-pstack` first. Restart omp after the switch.

For local development, link the checkout instead of installing a catalog copy:

```sh
omp plugin link /path/to/omp-pstack
```

## Upgrade an existing install

The marketplace caches the catalog tree at fetch time. Update the catalog before you upgrade:

```sh
omp plugin marketplace update omp-pstack
omp plugin upgrade omp-pstack@omp-pstack
```

omp compares version numbers. If the catalog head has new commits but `package.json` still carries the installed version, `upgrade` treats the install as current. For an unreleased head, reinstall the same version explicitly:

```sh
omp plugin install omp-pstack@omp-pstack --force
```

The older `sencha930511` entry uses the same commands with that marketplace name. For npm:

```sh
omp plugin install npm:omp-pstack@0.3.3 --force
```

## Verify the install

```sh
omp plugin list
```

`omp-pstack` must be listed. Then check that a hidden skill is loaded and stays out of the model catalog:

```sh
omp skill list --json | jq -r '.skills[] | select(.name == "architect") | "\(.name) hide=\(.hide)"'
```

Expected: `architect hide=true`.

In a new session, read a skill directly:

```text
read skill://architect
```

You should get the skill body. `Unknown skill: architect` means the skill is not loaded. Check the configuration keys below.

## Keep the skill catalog small

Every bundled skill is registered. All but `setup-pstack` are hidden from the model catalog, so the prompt does not grow by every skill description. `/skill:<name>` and `skill://<name>` still resolve them.

Four configuration keys can keep a skill out of a session:

| Key | Effect | Fix |
|---|---|---|
| `includeSkills` | A non-empty allowlist removes every skill not listed | Clear it, or add the pstack names |
| `ignoredSkills` | Removes matching names | Delete the pstack patterns |
| `disabledExtensions: ["skill:<name>"]` | Disables one skill | Remove the pstack entry |
| `manualSkills` | Hides matching skills from the model catalog only | No action needed |

The default empty `includeSkills` needs no setup. A non-empty allowlist filters out every skill not listed, including the user's other installed skills. Clearing it admits those skills again. Decide that with the user before editing a global config.

`/skill:setup-pstack` adds itself to `skills.manualSkills` after it writes the routing. The catalog drops it from the next session, while `/skill:setup-pstack` keeps working.

## Route models per agent

Run:

```text
/skill:setup-pstack
```

[`setup-pstack`](../../skills/setup-pstack/SKILL.md) detects the models omp exposes, asks for a reasoning budget (`large`, `medium`, or `small`), and shows every pstack agent:

- `poteto-agent`, the implementation delegate
- `comment-sicko`, the comment reviewer
- `task`, the generic worker
- `scout`, the read-only investigator
- `reviewer`, the review specialist

It writes the agreed mapping to `task.agentModelOverrides` in `~/.omp/agent/config.yml`. If [`pi-model-sync`](https://github.com/SenCha930511/pi-model-sync) is installed, it can write the same mapping into that plugin's preset instead. Do not set both for one agent. Model-sync treats an override as an explicit per-call model and skips it.

omp resolves a subagent model in this order:

1. `task.agentModelOverrides[agent]`
2. The agent's frontmatter `model`
3. The parent session's model

An unconfigured agent inherits the parent model. omp has no special `inherit` value. Leave the agent out of the mapping to inherit.

For the panel skills, `/skill:swarm`, `/skill:arena`, and `/skill:interrogate`, setup can enable per-call model selection:

```yaml
task:
  perCallModel: "on"
  perCallModelAllow:
    - anthropic/claude-opus-5.5
    - openai/gpt-5.4
```

Those models must also be granted through a configured chat role or an agent's frontmatter `model`. Without per-call selection, every seat uses the agent's configured model. Do not put an agent used by a panel in `task.agentModelOverrides`, because a per-call `model` and an override conflict.

Setup can also enable `task.isolation.enabled: true`, which lets parallel code-editing subagents run in separate copy-on-write worktrees when a brief passes `isolated: true`.

The routing applies to new subagent spawns. A rerun updates it in place.

## Accept the verification offers, or do not

At the end of setup, `/skill:setup-pstack` checks whether the project has a scripted way to drive the app. If it finds none, it offers once to generate one with [`/skill:create-verification-skill`](../../skills/create-verification-skill/SKILL.md). It then offers once to generate a formal verification skill with [`/skill:create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md), unless the project already has one.

Say yes to the first when you want an agent to check its own UI, CLI, or service behavior instead of handing every result back to you. Say yes to the second when the code has concurrency, retries, a state machine, or a parser, where a bug is costly and tests rarely reach the case that breaks. [Verify and ship](./06-verify-and-ship.md) covers both.

## Keep the cost in check

pstack spends extra tokens on subagents and review panels. To spend fewer:

- Rerun `/skill:setup-pstack` with a smaller budget or cheaper models. A strong model in the main chat with cheaper models for the implementation agents is a good split.
- Leave an agent out of the mapping so it inherits the parent model.
- Shorten a panel list. Each entry runs one subagent.
- Save `/poteto-mode` for work that needs rigor. A small, obvious edit does not.

## Run your first task

Pick something real but small, and describe it the way you would describe it to a colleague:

```text
/poteto-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps, the Feature playbook for this prompt.

`/poteto-mode <task>` is one-shot. It affects this message only. `/poteto-mode sticky` keeps the workflow on every later turn in the session, `/poteto-mode sticky <task>` enables sticky mode and runs `<task>` right away, and `/poteto-mode off` stops it. `/skill:poteto-mode` is omp's native one-shot skill command and does not enable sticky mode.

[Route work through `/poteto-mode`](./02-poteto-mode.md) covers the prompt shape and the commands in depth.
