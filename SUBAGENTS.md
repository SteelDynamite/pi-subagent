---
description: "Route here work on behavioral- and locational-agent discovery, delegation, boundaries, progress, lifecycle safety, and the locational-agent manifest."
---

Keep delegation foreground-managed: each `subagent` call launches one isolated Pi child, shows progress, waits, and returns one result. Built-in `bash` owns shell commands and Pi owns concurrent sibling tool execution. Do not add detached jobs, background polling, or command execution to this extension.

## Model configuration maintenance

Pin explicit OpenAI model selectors as `openai/<model-id>`; preserve model IDs and declared thinking levels. Behavioral `whenCallerModelId` is a literal model ID, not a provider-qualified selector; `thenModel: caller` preserves the immediate caller's provider. Keep conditional policy in definitions, never agent-name dispatch or speed-dependent matching. See README's behavioral caller overrides for field validation and resume semantics.

This root declares neither model nor thinking: locational selection uses `PI_SUBAGENT_LOCATIONAL_PREFERRED_MODELS` when available, otherwise the caller model.

Definitions are reread on each delegation and before each agent turn; selector edits need no reload. Extension-code changes require `/reload`; parent environment changes require restarting Pi. The visible locational manifest is a branch snapshot, not the live selector configuration.

To bootstrap a locational owner with failed provider authentication, select an authenticated caller model first. An unavailable explicit selector uses the caller immediately; a selected non-caller model may retry once with the caller after a qualifying pre-work provider failure. Preferred-model environment settings do not override explicit `model:` entries. Delegate maintenance to the owner; do not bypass boundaries when owner instructions block edits.

@README.md
