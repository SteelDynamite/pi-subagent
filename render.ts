import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "./pi-compat.ts";
import { COLLAPSED_ITEM_COUNT, MAX_NESTED_RENDER_DEPTH, MAX_NESTED_RENDER_LINES } from "./constants.ts";
import { formatUsageStats, getDisplayItems, getFinalOutput, getNestedSubagentIds, isFailedResult } from "./result.ts";
import type { NestedSubagentCall, SubagentDetails } from "./types.ts";

function preview(text: string, max = 120): string { const line = text.replace(/\s+/g, " ").trim(); return line.length > max ? `${line.slice(0, max)}...` : line; }

export function formatNestedSubagentsForDisplay(
	calls: NestedSubagentCall[] | undefined,
	themeFg: (color: any, text: string) => string = (_color, text) => text,
	depth = 0,
): string {
	if (!calls?.length) return "";
	const lines: string[] = [];
	const visit = (items: NestedSubagentCall[], currentDepth: number) => {
		if (currentDepth >= MAX_NESTED_RENDER_DEPTH) { lines.push(`${"  ".repeat(currentDepth)}${themeFg("muted", "↳ ... nested subagents depth cap")}`); return; }
		for (const call of items) {
			if (lines.length >= MAX_NESTED_RENDER_LINES) return;
			const icon = call.status === "running" ? themeFg("warning", "⏳") : call.status === "failed" ? themeFg("error", "✗") : themeFg("success", "✓");
			lines.push(`${"  ".repeat(currentDepth)}${themeFg("muted", "↳")} ${icon} ${themeFg("toolTitle", call.toolName)} ${themeFg("muted", `[${call.status}]`)}`);
			if (call.error) lines.push(`${"  ".repeat(currentDepth + 1)}${themeFg("error", `Error: ${preview(call.error)}`)}`);
			for (const result of call.details?.results ?? []) {
				lines.push(`${"  ".repeat(currentDepth + 1)}${themeFg("accent", result.agent)} ${themeFg("dim", preview(getFinalOutput(result.messages) || result.errorMessage || result.stderr || "(running...)"))}`);
				visit(result.nestedSubagents ?? [], currentDepth + 1);
			}
		}
	};
	visit(calls, depth);
	if (lines.length >= MAX_NESTED_RENDER_LINES) lines.push(themeFg("muted", "... nested subagents render cap"));
	return lines.join("\n");
}

export function renderSubagentCall(args: { id?: string; session?: string; task?: string }, theme: any, _context: any) {
	const task = args.task ? preview(args.task, 60) : "...";
	return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.id || "...")}${args.session ? theme.fg("muted", ` [session:${args.session}]`) : ""}\n  ${theme.fg("dim", task)}`, 0, 0);
}

export function renderSubagentResult(result: any, { expanded }: { expanded: boolean }, theme: any, _context: any) {
	const details = result.details as SubagentDetails | undefined;
	const agent = details?.results[0];
	if (!agent) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
	const running = agent.exitCode === -1;
	const failed = !running && isFailedResult(agent);
	const icon = running ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(agent.agent))}${theme.fg("muted", ` (${agent.agentOrigin})${agent.sessionIntent ? ` [session:${agent.sessionIntent}]` : ""}`)}`;
	const nested = formatNestedSubagentsForDisplay(agent.nestedSubagents, theme.fg.bind(theme));
	const display = getDisplayItems(agent.messages);
	const output = getFinalOutput(agent.messages);
	if (!expanded) {
		let text = header;
		if (running) text += ` ${theme.fg("muted", "running")}`;
		else if (failed && agent.stopReason) text += ` ${theme.fg("error", `[${agent.stopReason}]`)}`;
		const nestedIds = getNestedSubagentIds(agent.messages);
		if (nestedIds.length && !nested) text += theme.fg("dim", ` +${nestedIds.length} nested`);
		if (nested) text += `\n${nested}`;
		if (agent.warning) text += `\n${theme.fg("warning", `Warning: ${agent.warning}`)}`;
		if (agent.wrongSessionIntent) text += `\n${theme.fg("error", `Wrong session intent; retry: ${agent.wrongSessionIntent.recommendedRetry}`)}`;
		else if (failed && agent.errorMessage) text += `\n${theme.fg("error", `Error: ${agent.errorMessage}`)}`;
		else text += `\n${display.slice(-COLLAPSED_ITEM_COUNT).filter((item) => item.type === "text").map((item) => theme.fg("toolOutput", preview(item.text))).join("\n") || theme.fg("muted", "(no output)")}`;
		const usage = formatUsageStats(agent.usage, agent.model);
		if (usage) text += `\n${theme.fg("dim", usage)}`;
		return new Text(text, 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(header, 0, 0));
	if (nested) container.addChild(new Text(nested, 0, 0));
	if (agent.warning) container.addChild(new Text(theme.fg("warning", `Warning: ${agent.warning}`), 0, 0));
	if (agent.wrongSessionIntent) container.addChild(new Text(theme.fg("error", `Wrong session intent; retry: ${agent.wrongSessionIntent.recommendedRetry}`), 0, 0));
	else if (agent.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${agent.errorMessage}`), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", agent.task), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
	container.addChild(output ? new Markdown(output.trim(), 0, 0, getMarkdownTheme()) : new Text(theme.fg("muted", "(no output)"), 0, 0));
	const usage = formatUsageStats(agent.usage, agent.model);
	if (usage) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("dim", usage), 0, 0)); }
	return container;
}
