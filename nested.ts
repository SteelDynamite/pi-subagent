import { MAX_NESTED_SUBAGENTS_PER_RESULT, NESTED_SUBAGENT_DETAIL_CAP } from "./constants.ts";
import type { NestedSubagentCall, SingleResult, SubagentsDetails, UsageStats } from "./types.ts";

function isSubagentsDetails(value: unknown): value is SubagentsDetails {
	const details = value as Partial<SubagentsDetails> | undefined;
	return Boolean(details && Array.isArray(details.results));
}

function truncateUtf8(text: string | undefined, maxBytes: number): string | undefined {
	if (text === undefined || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return `${truncated}\n[truncated]`;
}

function capResult(result: SingleResult): SingleResult {
	return { ...result, task: truncateUtf8(result.task, 1024) ?? "", messages: [], stdout: truncateUtf8(result.stdout, 2048), stderr: truncateUtf8(result.stderr, 2048) ?? "", warning: truncateUtf8(result.warning, 512), errorMessage: truncateUtf8(result.errorMessage, 512), nestedSubagents: result.nestedSubagents?.slice(0, 2).map((nested) => ({ toolCallId: nested.toolCallId, toolName: nested.toolName, status: nested.status, error: truncateUtf8(nested.error, 512), truncated: true })) };
}

function capDetails(details: SubagentsDetails): { details: SubagentsDetails; truncated: boolean } {
	if (Buffer.byteLength(JSON.stringify(details), "utf8") <= NESTED_SUBAGENT_DETAIL_CAP) return { details, truncated: false };
	return { details: { includeLocationalAgents: details.includeLocationalAgents, locationalAgents: details.locationalAgents.slice(0, 8), results: details.results.slice(0, 1).map(capResult) }, truncated: true };
}

function resultText(result: any): string | undefined { return result?.content?.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").trim() || undefined; }

export function applyNestedSubagentEvent(result: SingleResult, event: any): boolean {
	if (!event || event.toolName !== "subagents" || typeof event.toolCallId !== "string" || !["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) return false;
	result.nestedSubagents ??= [];
	let nested = result.nestedSubagents.find((call) => call.toolCallId === event.toolCallId);
	if (!nested) {
		if (result.nestedSubagents.length >= MAX_NESTED_SUBAGENTS_PER_RESULT) return false;
		nested = { toolCallId: event.toolCallId, toolName: "subagents", status: "running" };
		result.nestedSubagents.push(nested);
	}
	if (event.type === "tool_execution_start") { nested.status = "running"; nested.error = undefined; return true; }
	const source = event.type === "tool_execution_update" ? event.partialResult?.details : event.result?.details;
	if (isSubagentsDetails(source)) { const capped = capDetails(source); nested.details = capped.details; nested.truncated ||= capped.truncated; }
	if (event.type === "tool_execution_end") { nested.status = event.isError ? "failed" : "completed"; nested.error = event.isError ? resultText(event.result) ?? "Nested subagents call failed" : undefined; }
	return true;
}
