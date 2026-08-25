import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { getAgentInstructionsFileName, resolveLocationalAgentId } from "./agents.ts";
import {
	ADVERTISE_LOCATIONAL_AGENTS_ENV,
	DEFAULT_KNOWN_TOOLS,
	LOCATIONAL_PREFERRED_MODELS_ENV,
	MAX_SUBAGENT_DEPTH,
	ORCHESTRATED_CHILD_ENV,
	SUBAGENT_DEPTH_ENV,
} from "./constants.ts";
import { createAgentLifecycle, markAgentActivity, markAgentClosed, markAgentTerminating, recordAgentError } from "./lifecycle.ts";
import { getLocationalLoopError, makeChildLocationalEnv } from "./locational-guard.ts";
import { applyNestedSubagentEvent } from "./nested.ts";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat.ts";
import { formatTokens, getFinalOutput, isFailedResult, makeErrorResult } from "./result.ts";
import {
	formatWrongIntentReason,
	getRequiredSessionIntent,
	getWrongIntentRetry,
	persistSubagentState,
	subagentSettings,
	updateTrackedSession,
} from "./state.ts";
import type { OnUpdateCallback, SessionIntent, SingleResult, SubagentsDetails } from "./types.ts";

let knownToolNames = new Set(DEFAULT_KNOWN_TOOLS);

export function setKnownToolNames(names: Iterable<string>): void {
	knownToolNames = new Set(names);
}

export function resolveAgent(defaultCwd: string, agents: AgentConfig[], id: string): AgentConfig | undefined {
	return resolveLocationalAgentId(defaultCwd, id) ?? agents.find((agent) => agent.kind === "behavioral" && agent.id === id);
}

function formatModelRef(model: ExtensionContext["model"]): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export type ResolvedAgentModel = {
	model?: string;
	contextWindow?: number;
	warning?: string;
	source: "agent" | "preferred" | "caller";
	fallbackModel?: string;
	fallbackContextWindow?: number;
};

function parseModelCandidates(value: string | undefined): string[] {
	return value?.split(",").map((model) => model.trim()).filter(Boolean) ?? [];
}

function resolveAvailableModel(candidates: string[], ctx: ExtensionContext): { model?: string; contextWindow?: number } {
	for (const candidate of candidates) {
		const match = ctx.modelRegistry.getAvailable().find((model) => `${model.provider}/${model.id}` === candidate || model.id === candidate);
		if (match) return { model: `${match.provider}/${match.id}`, contextWindow: match.contextWindow };
	}
	return {};
}

export function resolveAgentModel(agent: AgentConfig, ctx: ExtensionContext): ResolvedAgentModel {
	const callerModel = formatModelRef(ctx.model);
	const callerContextWindow = ctx.model?.contextWindow;
	const explicit = parseModelCandidates(agent.model);
	if (explicit.length) {
		const resolved = resolveAvailableModel(explicit, ctx);
		if (resolved.model) return { ...resolved, source: "agent", fallbackModel: callerModel, fallbackContextWindow: callerContextWindow };
		return {
			model: callerModel,
			contextWindow: callerContextWindow,
			source: "caller",
			warning: `No configured model from "${agent.model}" for ${agent.id}; using caller model${callerModel ? ` ${callerModel}` : ""}.`,
		};
	}
	if (agent.kind === "locational") {
		const preferred = resolveAvailableModel(parseModelCandidates(process.env[LOCATIONAL_PREFERRED_MODELS_ENV]), ctx);
		if (preferred.model) return { ...preferred, source: "preferred", fallbackModel: callerModel, fallbackContextWindow: callerContextWindow };
	}
	return { model: callerModel, contextWindow: callerContextWindow, source: "caller" };
}

export function validateAgentTools(agent: AgentConfig): string | undefined {
	const unknown = agent.tools?.filter((tool) => !knownToolNames.has(tool)) ?? [];
	return unknown.length ? `${agent.filePath}: unknown tool(s): ${unknown.join(", ")}. Explicit tools must match available tool names exactly.` : undefined;
}

export function makeSubagentChildEnv(agent: AgentConfig, currentDepth: number, includeLocationalAgentsInBehavioralChild: boolean): Record<string, string> {
	return {
		[SUBAGENT_DEPTH_ENV]: String(currentDepth + 1),
		[ORCHESTRATED_CHILD_ENV]: "1",
		[ADVERTISE_LOCATIONAL_AGENTS_ENV]: agent.kind === "behavioral" && !includeLocationalAgentsInBehavioralChild ? "0" : "1",
		...makeChildLocationalEnv(agent),
	};
}

export function processChildJsonEvent(event: any, result: SingleResult, emitUpdate: () => void): void {
	if (applyNestedSubagentEvent(result, event)) emitUpdate();
	if (event.type === "message_end" && event.message) {
		const message = event.message as Message;
		result.messages.push(message);
		if (message.role === "assistant") {
			result.usage.turns++;
			const usage = message.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!result.model && message.model) result.model = message.model;
			if (message.stopReason) result.stopReason = message.stopReason;
			if (message.errorMessage) result.errorMessage = message.errorMessage;
		}
		emitUpdate();
	}
	if (event.type === "tool_result_end" && event.message) {
		result.messages.push(event.message as Message);
		emitUpdate();
	}
}

const CONTEXT_LIMIT_STOP_REASON = "context_limit";
const CONTEXT_LIMIT_PATTERNS = [
	/\bcontext[_ -]?limit\b/i,
	/context[_ -]?length[_ -]?exceeded/i,
	/context[_ -]?(?:window|limit|length|size)[^\n]{0,120}(?:exceed|exceeded|exceeds|overflow|full|too (?:large|long|many)|maximum|max)/i,
	/(?:exceed|exceeded|exceeds|overflow|over|too (?:large|long|many)|maximum|max)[^\n]{0,120}context[_ -]?(?:window|limit|length|size)/i,
	/too[_ -]?many[_ -]?tokens/i,
	/(?:prompt|input|messages?)[^\n]{0,120}(?:too (?:large|long)|token limit|tokens?[^\n]{0,80}(?:exceed|exceeded|exceeds|maximum|max))/i,
	/(?:maximum|max)[^\n]{0,80}(?:context|tokens?)[^\n]{0,120}(?:requested|resulted|input|prompt|messages?)/i,
	/input token count exceeds/i,
];

function trimEvidence(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

export function findContextLimitEvidence(...sources: Array<string | undefined>): string | undefined {
	for (const source of sources) {
		for (const line of source?.split(/\r?\n/) ?? []) {
			if (CONTEXT_LIMIT_PATTERNS.some((pattern) => pattern.test(line))) return trimEvidence(line);
		}
	}
	return undefined;
}

export function classifyContextLimitFailure(result: SingleResult, extraSources: string[] = []): boolean {
	if (!isFailedResult(result) && !result.errorMessage) return false;
	const evidence = findContextLimitEvidence(result.stopReason, result.errorMessage, result.stderr, result.stdout, getFinalOutput(result.messages), ...extraSources);
	if (!evidence) return false;
	result.stopReason = CONTEXT_LIMIT_STOP_REASON;
	result.errorMessage = `Subagent hit context limit${result.model ? ` for ${result.model}` : ""}${result.contextWindow ? ` (${formatTokens(result.contextWindow)} context window)` : ""}. Evidence: ${evidence}`;
	return true;
}

function hasMeaningfulTaskWork(result: SingleResult): boolean {
	return result.messages.some((message: any) => message.role === "toolResult" || (message.role === "assistant" && message.content?.some((part: any) => (part.type === "text" && part.text.trim()) || part.type === "toolCall")));
}

export function shouldRetryPreferredModelFailure(result: SingleResult): boolean {
	if (!isFailedResult(result) || hasMeaningfulTaskWork(result)) return false;
	if (result.stopReason === CONTEXT_LIMIT_STOP_REASON) return true;
	const text = [result.errorMessage, result.stderr, getFinalOutput(result.messages), result.stopReason].filter(Boolean).join("\n").toLowerCase();
	return !text.trim() || /model|provider|rate|429|quota|auth|api key|unauthori[sz]ed|forbidden|permission|billing|overloaded|unavailable|not found|not configured|pre[- ]?start|failed to load|invalid[_ -]?request/.test(text);
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(dir, `prompt-${agentName.replace(/[^\w.-]+/g, "_")}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	return /^(node|bun)(\.exe)?$/i.test(path.basename(process.execPath)) ? { command: "pi", args } : { command: process.execPath, args };
}

export async function runDelegation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	defaultCwd: string,
	agents: AgentConfig[],
	agentId: string,
	session: SessionIntent,
	task: string,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentsDetails,
	includeLocationalAgentsInBehavioralChild: boolean,
): Promise<SingleResult> {
	const agent = resolveAgent(defaultCwd, agents, agentId);
	if (!agent) {
		const available = agents.map((item) => `"${item.id}"`).join(", ") || "none";
		return makeErrorResult(agentId, task, `Unknown subagent id: "${agentId}". Available agents: ${available}.`, session);
	}
	const rawDepth = Number(process.env[SUBAGENT_DEPTH_ENV] ?? "0");
	const currentDepth = Number.isInteger(rawDepth) && rawDepth >= 0 ? rawDepth : 0;
	if (currentDepth >= MAX_SUBAGENT_DEPTH) return makeErrorResult(agent.id, task, `Subagent recursion limit reached (max depth ${MAX_SUBAGENT_DEPTH}).`, session);
	const loopError = getLocationalLoopError(agent);
	if (loopError) return makeErrorResult(agent.id, task, loopError, session);
	const toolError = validateAgentTools(agent);
	if (toolError) return makeErrorResult(agent.id, task, toolError, session);
	const required = getRequiredSessionIntent(ctx, agent);
	if (session !== required.intent) {
		return makeErrorResult(agent.id, task, formatWrongIntentReason(agent, session, required.intent, required.reason), session, {
			agentOrigin: agent.origin,
			wrongSessionIntent: {
				agentId: agent.id,
				requested: session,
				required: required.intent,
				recommendedRetry: getWrongIntentRetry(required.intent, required.reason),
			},
		});
	}

	const resolvedModel = resolveAgentModel(agent, ctx);
	const retryWithCaller = agent.kind === "locational" && Boolean(resolvedModel.fallbackModel) && resolvedModel.fallbackModel !== resolvedModel.model;
	let sessionId = agent.resumable && subagentSettings.reuseEnabled
		? session === "resume" ? required.record?.sessionId : crypto.randomUUID()
		: undefined;
	if (!sessionId && retryWithCaller) sessionId = crypto.randomUUID();

	const runAttempt = async (model: ResolvedAgentModel): Promise<SingleResult> => {
		const args = ["--mode", "json", "-p"];
		if (sessionId) args.push("--session-id", sessionId);
		else args.push("--no-session");
		if (model.model) args.push("--model", model.model);
		if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
		const result: SingleResult = {
			agent: agent.id,
			agentOrigin: agent.origin,
			sessionIntent: session,
			task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: model.model,
			contextWindow: model.contextWindow,
			warning: model.warning,
			cwd: agent.kind === "locational" ? agent.rootDir : defaultCwd,
		};
		let promptDir: string | undefined;
		let promptPath: string | undefined;
		try {
			if (agent.systemPrompt.trim()) {
				const prompt = agent.kind === "locational"
					? `# ${getAgentInstructionsFileName()}\n\nThe following ${getAgentInstructionsFileName()} is more specific than any AGENTS.md loaded from the same folder. Follow it for this source root.\n\n${agent.systemPrompt}`
					: agent.systemPrompt;
				({ dir: promptDir, filePath: promptPath } = await writePromptToTempFile(agent.id, prompt));
				args.push("--append-system-prompt", promptPath);
			}
			args.push(`Task: ${task}`);
			const lifecycle = createAgentLifecycle(agent.id);
			let contextEvidence: string | undefined;
			await new Promise<void>((resolve) => {
				const invocation = getPiInvocation(args);
				const proc = spawn(invocation.command, invocation.args, {
					cwd: result.cwd,
					env: { ...process.env, ...makeSubagentChildEnv(agent, currentDepth, includeLocationalAgentsInBehavioralChild) },
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				markAgentActivity(lifecycle);
				let buffer = "";
				let settled = false;
				let forceKillTimer: NodeJS.Timeout | undefined;
				const emit = () => onUpdate?.({ content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }], details: makeDetails([result]) });
				const processLine = (line: string) => {
					if (!line.trim()) return;
					contextEvidence ??= findContextLimitEvidence(line);
					try {
						processChildJsonEvent(JSON.parse(line), result, emit);
					} catch {
						result.stdout = result.stdout ? `${result.stdout}\n${line}` : line;
					}
				};
				const abort = () => {
					if (!markAgentTerminating(lifecycle)) return;
					proc.kill("SIGTERM");
					forceKillTimer = setTimeout(() => {
						if (proc.exitCode === null) proc.kill("SIGKILL");
					}, 5000);
					forceKillTimer.unref();
				};
				const finish = (code: number, error?: string) => {
					if (settled) return;
					settled = true;
					if (forceKillTimer) clearTimeout(forceKillTimer);
					signal?.removeEventListener("abort", abort);
					if (buffer.trim()) processLine(buffer);
					if (error) recordAgentError(lifecycle, error);
					markAgentClosed(lifecycle, code);
					result.exitCode = code;
					result.stopReason ??= lifecycle.stopReason;
					result.errorMessage ??= lifecycle.errorMessage;
					resolve();
				};
				proc.stdout.on("data", (data) => {
					markAgentActivity(lifecycle);
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});
				proc.stderr.on("data", (data) => {
					markAgentActivity(lifecycle);
					result.stderr += data.toString();
				});
				proc.on("close", (code) => finish(code ?? (lifecycle.stopReason === "aborted" ? 130 : 1)));
				proc.on("error", (error) => finish(1, error.message));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
			classifyContextLimitFailure(result, contextEvidence ? [contextEvidence] : []);
			return result;
		} finally {
			if (promptPath) await fs.promises.unlink(promptPath).catch(() => undefined);
			if (promptDir) await fs.promises.rm(promptDir, { recursive: true, force: true });
		}
	};

	const first = await runAttempt(resolvedModel);
	let final = first;
	if (retryWithCaller && shouldRetryPreferredModelFailure(first)) {
		final = await runAttempt({ model: resolvedModel.fallbackModel, contextWindow: resolvedModel.fallbackContextWindow, source: "caller" });
		const warning = `${resolvedModel.source === "agent" ? "Explicit locational model" : "Preferred locational model"} ${first.model ?? "(default)"} failed before task work; retried with caller model ${final.model ?? "(default)"}.`;
		final.warning = final.warning ? `${final.warning}\n${warning}` : warning;
	}
	updateTrackedSession(ctx, agent, sessionId, final);
	if (agent.resumable) persistSubagentState(pi);
	return final;
}
