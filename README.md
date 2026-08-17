# Pi Subprocess

Foreground-managed subprocess orchestration for Pi Coding Agent.

Run specialized Pi agents with isolated contexts, or run shell commands, while the parent agent waits for consolidated results. Detached/fire-and-forget jobs are intentionally out of scope.

## Features

- **Agent subprocesses**: behavioral and locational Pi agents run in separate `pi` processes. The parent orchestrator plans and delegates; Scout gathers context, Worker executes, and Reviewer reviews only when explicitly requested.
- **Locational area card**: trusted parent TUI sessions show the same canonical locational-agent routing text injected for the model, without adding the card entry itself to model context.
- **Command subprocesses**: shell commands run with bounded foreground parallelism.
- **Streaming progress**: single, parallel, chain, and command modes stream status. Model usage labels append lowercase `fast` when pi-chatgpt Fast mode is effective.
- **Consolidated results**: parent receives final output, exit status, cwd, stderr/stdout, usage, truncation metadata, and clear context-limit failures.
- **Abort support**: Ctrl+C propagates to child processes.
- **Legacy readers**: old state/env records are still read where needed for safe migration cleanup.

## Structure

```
pi-subprocess/
├── README.md
├── index.ts
├── agents.ts
├── command.ts
├── locational-guard.ts
├── agents/
│   ├── reviewer/SUBAGENTS.md
│   ├── scout/SUBAGENTS.md
│   └── worker/SUBAGENTS.md
└── prompts/
    └── implement.md
```

## Installation

From this repository root:

```bash
mkdir -p ~/.pi/agent/extensions/subprocess
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/subprocess/index.ts

mkdir -p ~/.pi/agent/agents
for d in agents/*; do
  ln -sfn "$(pwd)/$d" ~/.pi/agent/agents/$(basename "$d")
done

mkdir -p ~/.pi/agent/prompts
ln -sf "$(pwd)/prompts/implement.md" ~/.pi/agent/prompts/implement.md
```

## Tool

Tool name: `subprocess`.

### Modes

| Mode | Parameter | Description |
|---|---|---|
| Single agent | `{ id, session, task }` | One behavioral or locational agent |
| Parallel agents | `{ tasks: [{ id, session, task }] }` | Multiple agent subprocesses, max 8, concurrency 4 |
| Chain | `{ chain: [{ id, session, task }] }` | Sequential agents; task may include `{previous}` |
| Commands | `{ commands: [{ command, name?, cwd?, timeoutMs?, maxOutputBytes? }] }` | Foreground-managed shell commands |

Agent calls require `session: "new" | "resume"`. Use `resume` only when the previous result says to.

### Examples

```json
{ "commands": [{ "name": "tests", "command": "npm test" }, { "name": "types", "command": "npm run typecheck" }] }
```

```json
{ "id": "scout", "session": "new", "task": "Find authentication code" }
```

### Workflow prompt

`/implement <task>` keeps planning in the parent orchestrator and uses Scout for context as needed. It delegates implementation inside an advertised locational root directly to its owning agent; otherwise it uses Worker. Reviewer is used only when explicitly requested.

## Agent Types

### Behavioral agents

Behavioral agents are folders containing `SUBAGENTS.md`:

- bundled: this repo's `agents/<id>/SUBAGENTS.md`
- user: `~/.pi/agent/agents/<id>/SUBAGENTS.md`
- project: `.pi/agents/<id>/SUBAGENTS.md` when `agentScope` is `project` or `both`

Project-local behavioral agents are repo-controlled prompts. Only enable them for trusted repositories.

### Locational agents

Any descendant folder containing `SUBAGENTS.md` becomes a locational boundary. The folder path is the agent id. Direct reads/edits/searches/commands inside such folders are blocked unless the user explicitly authorizes direct access for the current request.

Use the locational path as `id` to delegate instead. Locational agents run from their source root and cannot recursively delegate to their own current root or active ancestor stack.

`SUBAGENTS.md` also replaces same-folder `AGENTS.md` by convention. When Pi starts in a locational-agent folder with `SUBAGENTS.md` but no same-folder `AGENTS.md` or `CLAUDE.md`, this extension injects it as project context.

Supported frontmatter: `description`, `tools`, `model`, `manifest`, `resumable`.

Locational agents with `model:` use that comma-separated candidate list first, then fall back to the caller model if none are available. Locational agents without `model:` use `PI_SUBPROCESS_LOCATIONAL_PREFERRED_MODELS` as preferred candidates before the caller model when the env is set to a non-empty list. If the env is unset, they use the caller model directly. Set env to empty to disable preferred-model behavior explicitly. If an explicit or preferred locational model fails before meaningful task work because of a model/provider/rate/auth/pre-start/context-limit error, pi-subprocess retries once in the same child session id with the caller model and reports the fallback in the result warning/details.

Agent failures that look like context-window exhaustion are reported with `stopReason: "context_limit"` and a clear error message containing the matched evidence. Detection checks child Pi JSON events, stderr, captured non-JSON stdout, error messages, and final assistant output.

Locational discovery defaults: max depth `6`, timeout `500ms`. Use `PI_SUBPROCESS_LOCATIONAL_SCAN_MAX_DEPTH` and `PI_SUBPROCESS_LOCATIONAL_SCAN_TIMEOUT_MS` to override them.

In trusted parent TUI sessions, visible (`manifest: true`) locational discovery records are also stored as a custom session entry and rendered as a themed area card. One canonical string supplies both the model-facing locational section and the card content: a concise ownership/delegation preamble followed by one `<absolute source root / full subprocess id>: <description>` bullet per agent. Behavioral-agent content remains separate. Expanded and collapsed card views are identical, and the custom card entry itself never enters model context. The active compaction-aware branch is deduplicated: reload and resume preserve an existing card; tree navigation or compaction adds one only when the selected/rendered branch no longer contains one. A card is a session snapshot and does not refresh changed definitions while it remains visible. RPC, JSON, print, untrusted, advertisement-disabled, and subprocess-child sessions do not append cards.

## Child Environment

Agent and command subprocess child processes receive:

- `PI_SUBPROCESS_CHILD=1`
- `PI_ORCHESTRATED_CHILD=1`

## Settings

Use `/subprocess-settings` to toggle resumable-session reuse, set the context threshold, view active sessions, or reset tracked sessions.

## Non-goals

- detached jobs
- jobId polling
- schedulers or recurring tasks
- persistent daemons
- external task-type plugins
- cross-session job survival

## Validation

```bash
npm test
npm run typecheck
```
