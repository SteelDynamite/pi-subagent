# Pi Subagent

Foreground-managed behavioral and locational Pi-agent delegation. Each `subagent` call runs one isolated Pi child and returns its result; built-in `bash` owns shell execution.

## Features

- Behavioral discovery precedence: bundled, user, then trusted-project definitions.
- Locational `SUBAGENTS.md` discovery, source-root boundaries, and recursion guards.
- One-agent progress, abort propagation, context-limit reporting, resumable sessions, and one same-session locational-model fallback.
- A trusted-parent TUI locational-agent manifest matching the parent prompt.
- Behavioral children do not advertise locational agents unless requested.

## Installation

This checkout stays at its existing path. Install the extension under its package name:

```bash
mkdir -p ~/.pi/agent/extensions/pi-subagent
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/pi-subagent/index.ts

mkdir -p ~/.pi/agent/agents
for d in agents/*; do ln -sfn "$(pwd)/$d" ~/.pi/agent/agents/$(basename "$d"); done

mkdir -p ~/.pi/agent/prompts
ln -sf "$(pwd)/prompts/implement.md" ~/.pi/agent/prompts/implement.md
```

## Tool

`subagent` accepts exactly:

```json
{
  "id": "scout",
  "session": "new",
  "task": "Find authentication code",
  "contextDocs": ["/absolute/product-guidance.md"],
  "includeLocationalAgents": false
}
```

`id`, `session`, and `task` are required. `contextDocs` and `includeLocationalAgents` are optional. Use `resume` only when the prior result requests it. Behavioral agents inherit the caller directory; locational-agent ids are absolute or caller-relative folders containing `SUBAGENTS.md` and run from that source root.

Use ordinary `bash` calls for shell commands and sibling/later `subagent` calls for concurrent/sequential delegation.

## Agent definitions

Behavioral agent directories and locational roots both use `SUBAGENTS.md`. Definitions may set a fixed Pi thinking default:

```yaml
---
description: Investigates code.
thinking: high
---
```

`thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. When declared, every new and resumed child receives `--thinking <level>`, overriding that child's startup and saved-session setting. Omit it to preserve Pi's existing child defaults. Callers cannot override it through `subagent`; Pi still clamps levels to selected-model support.

## Discovery and safety

Behavioral definitions resolve from the loaded extension's bundled `agents/`, then user `~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/`), then one trusted project root. The project root is `cwd/.pi/agents/` when that directory exists (including empty); otherwise it is `cwd/.agents/subagents/`. Ancestors are never searched and project roots are not merged.

These exact behavioral trees are excluded from locational discovery, path-based delegation, local owner instructions, and boundary guards. The CWD portable tree remains excluded even when masked by `.pi/agents`. Exclusions follow symlinked containers and direct-child directory symlinks containing `SUBAGENTS.md`, including overridden or invalid definitions. A directory merely named `agents`, or a nested `.agents/subagents` outside those trees, is not exempt. A separate checkout is not the loaded extension's bundled root. This checkout declares its `agents/` through the `.agents/subagents -> ../agents` project-root symlink, so an installed copy also recognizes these definitions as behavioral.

`SUBAGENTS.md` remains authoritative for other locational discovery, delegation, and boundaries. A genuine locational ancestor still protects behavioral files beneath it; behavioral classification does not grant access through that ancestor. A locational child cannot delegate to its active root or ancestor stack.

Locational models may declare `model:` candidates or use `PI_SUBAGENT_LOCATIONAL_PREFERRED_MODELS`. If a selected non-caller locational model fails before task work, the child retries once in the same session with the caller model. Context-limit failures are labeled `context_limit`.

Trusted parent TUI sessions show a locational-agent manifest card. Reload, resume, tree navigation, and compaction reuse a visible branch entry or append one when absent. Child sessions, untrusted projects, non-TUI modes, disabled advertisement, and empty discovery show no card.

Delegated children set only `PI_ORCHESTRATED_CHILD=1`. This suppresses automatic child-session supervisors.

## Settings

Use `/subagent-settings` to configure resumable-session reuse and context threshold.

## Validation

```bash
npm run typecheck
npm test
npm pack --dry-run
```
