# Pi Subagent

Foreground-managed behavioral and locational Pi-agent delegation. Each `subagents` call runs one isolated Pi child and returns its result; built-in `bash` owns shell execution.

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

`subagents` accepts exactly:

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

Use ordinary `bash` calls for shell commands and sibling/later `subagents` calls for concurrent/sequential delegation.

## Discovery and safety

Behavioral definitions resolve from bundled `agents/`, then user `~/.pi/agent/agents/`, then `.pi/agents/` only when Pi reports the project trusted. `SUBAGENTS.md` is authoritative for locational discovery, delegation, and boundaries. Direct access inside a locational root is blocked unless directly authorized for the request; a locational child cannot delegate to its active root or ancestor stack.

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
