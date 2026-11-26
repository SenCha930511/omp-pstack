# Agent install guide

Instructions for an AI agent helping a human install omp-pstack. Read this file
in full before running commands.

## Contract

- Ask before editing `~/.omp/agent/config.yml`. It is global and persistent.
- Never restart or kill the user's session. Tell them to start a new one.
- Run one command at a time and report its output.
- If a step fails, stop and report the failing command and its output. Do not
  guess a workaround.

## 1. Check the host

```sh
omp --version
```

omp 19.2 or newer. Node 22 or newer for npm installs.

## 2. Install

Marketplace:

```sh
omp plugin marketplace add SenCha930511/omp-marketplace
omp plugin install omp-pstack@sencha930511
```

npm:

```sh
omp plugin install npm:omp-pstack@0.3.1
```

Local checkout:

```sh
omp plugin link /path/to/omp-pstack
```

Verify:

```sh
omp plugin list
```

`omp-pstack` must be listed at 0.3.1 or newer. A 0.2.0 entry is the old
file-path build; reinstall.

## 3. Check the skill allowlist

Read the user's config:

```sh
rg -n -A40 '^skills:' ~/.omp/agent/config.yml
```

If `includeSkills` is absent or empty, skip to step 4.

If it lists names, the pstack skills are filtered out of the session. Ask the
user which they want:

- Clear the allowlist: delete the `includeSkills` block, or set it to `[]`.
- Keep it and add all 58 pstack names. Not recommended: every upstream skill
  addition needs another edit.

Explain the cost before editing. Clearing the allowlist also admits the user's
other installed skills. The only pstack skill that becomes visible in the model
catalog is `setup-pstack`; the other 57 stay hidden, so the prompt does not grow
by 57 entries.

Do not edit the file without explicit approval. Back it up first:

```sh
cp ~/.omp/agent/config.yml ~/.omp/agent/config.yml.bak
```

## 4. Verify hide mode

Start a new session first. Skill discovery runs at session start.

```sh
omp skill list --json | jq -r '.skills[] | select(.name == "architect") | "\(.name) hide=\(.hide)"'
```

Expected: `architect hide=true`.

In the new session, read a skill directly:

```text
read skill://architect
```

Expected: the SKILL.md body. `Unknown skill: architect` means the allowlist
still excludes it.

`/skill:architect` must appear in the slash menu. If it does not, check that
`skills.enableSkillCommands` is `true`.

## 5. First run

```text
/poteto-mode <task>
```

One-shot. `/poteto-mode sticky` keeps it on across turns. `/poteto-mode off`
stops it.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Unknown skill: architect` | `includeSkills` allowlist | clear it or add the names |
| `/skill:architect` missing | skill not loaded, or commands disabled | check step 3 and `enableSkillCommands` |
| `omp plugin list` shows 0.2.0 | stale install | reinstall 0.3.1 |
| A reply mentions `SKILL-INDEX.md` | old build | reinstall 0.3.1 |
| `architect` appears in the model's skill catalog | missing `disable-model-invocation` | report a bug; do not edit the skill |

## Rollback

```sh
omp plugin install npm:omp-pstack@0.3.0
```

Restore the config backup if you changed it.
