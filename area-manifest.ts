import * as path from "node:path";
import { Box, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentConfig } from "./agents.ts";
import { discoverAgents } from "./agents.ts";
import {
	ADVERTISE_LOCATIONAL_AGENTS_ENV,
	ORCHESTRATED_CHILD_ENV,
	SUBPROCESS_CHILD_ENV,
} from "./constants.ts";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat.ts";

export const LOCATIONAL_AREA_MANIFEST_ENTRY = "pi-subprocess-locational-areas";

export interface LocationalAreaManifestData {
	content?: string;
	areas?: Array<{
		id: string;
		sourceRoot: string;
		responsibility: string;
	}>;
}

export function shouldAdvertiseLocationalAgents(): boolean {
	const value = process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV]?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_[\]])/g, "\\$1");
}

function inlineCode(text: string): string {
	const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestRun + 1);
	return `${fence}${text}${fence}`;
}

function formatLocationalAreas(areas: Array<{ id: string; sourceRoot: string; relativeSourceRoot: string; responsibility: string }>): string {
	if (areas.length === 0) return "";
	const entries = areas.map((area) => [
		`- **Subprocess id:** ${inlineCode(area.id)}`,
		`  - **Source root:** ${inlineCode(area.sourceRoot)} (relative to parent: ${inlineCode(area.relativeSourceRoot)})`,
		`  - **Description:** ${escapeMarkdown(area.responsibility)}`,
		`  - **Routing:** Delegate work for this source root with ${inlineCode("subprocess")} id ${inlineCode(area.id)}.`,
	].join("\n")).join("\n");
	return [
		"## Available locational agents",
		"",
		"Source roots are owned by locational agents. Work inside them must be delegated rather than handled directly by the parent agent.",
		"",
		`Use the ${inlineCode("subprocess")} tool with the full subprocess id and required session intent (${inlineCode("new")} for a first/fresh call; ${inlineCode("resume")} only when the previous result for that agent says so). Direct access is allowed only when the user explicitly authorizes it for the specific source root and task. Do not delegate a locational agent to its own current source root or an active source ancestor; recursion guards block those loops.`,
		"",
		entries,
	].join("\n");
}

export function formatLocationalAgentContent(cwd: string, agents: AgentConfig[]): string {
	return formatLocationalAreas(agents
		.filter((agent) => agent.kind === "locational" && agent.manifest)
		.map((agent) => ({
			id: agent.id,
			sourceRoot: agent.rootDir,
			relativeSourceRoot: path.relative(cwd, agent.rootDir) || ".",
			responsibility: agent.description || "No responsibility description.",
		})));
}

export function makeLocationalAreaManifest(cwd: string, agents: AgentConfig[]): LocationalAreaManifestData | undefined {
	const content = formatLocationalAgentContent(cwd, agents);
	return content ? { content } : undefined;
}

export function formatLocationalAreaManifest(data: LocationalAreaManifestData): string {
	if (data.content !== undefined) return data.content;
	return formatLocationalAreas((data.areas ?? []).map((area) => ({
		id: area.id,
		sourceRoot: area.id,
		relativeSourceRoot: area.sourceRoot,
		responsibility: area.responsibility,
	})));
}

function makeMarkdownTheme(theme: any): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		underline: (text) => theme.underline(text),
		strikethrough: (text) => theme.strikethrough(text),
	};
}

export function renderLocationalAreaManifest(entry: { data?: LocationalAreaManifestData }, _options: { expanded: boolean }, theme: any) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	const content = entry.data ? formatLocationalAreaManifest(entry.data) : "";
	if (content) {
		box.addChild(new Markdown(content, 0, 0, makeMarkdownTheme(theme), {
			color: (text: string) => theme.fg("customMessageText", text),
		}));
	}
	return box;
}

export function registerLocationalAreaManifestRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<LocationalAreaManifestData>(LOCATIONAL_AREA_MANIFEST_ENTRY, renderLocationalAreaManifest);
}

export function appendLocationalAreaManifest(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui" || !ctx.isProjectTrusted()) return false;
	if (process.env[SUBPROCESS_CHILD_ENV] !== undefined || process.env[ORCHESTRATED_CHILD_ENV] !== undefined) return false;
	if (!shouldAdvertiseLocationalAgents()) return false;

	const visibleEntries = ctx.sessionManager.buildContextEntries();
	if (visibleEntries.some((entry) => entry.type === "custom" && entry.customType === LOCATIONAL_AREA_MANIFEST_ENTRY)) return false;

	const discovery = discoverAgents(ctx.cwd, "user", { includeLocationalAgents: true });
	const manifest = makeLocationalAreaManifest(ctx.cwd, discovery.locationalAgents);
	if (!manifest) return false;
	pi.appendEntry(LOCATIONAL_AREA_MANIFEST_ENTRY, manifest);
	return true;
}
