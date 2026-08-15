import * as path from "node:path";
import { Box, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
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
	areas: Array<{
		id: string;
		sourceRoot: string;
		responsibility: string;
	}>;
}

export function shouldAdvertiseLocationalAgents(): boolean {
	const value = process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV]?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

export function makeLocationalAreaManifest(cwd: string, agents: AgentConfig[]): LocationalAreaManifestData | undefined {
	const areas = agents
		.filter((agent) => agent.kind === "locational" && agent.manifest)
		.map((agent) => ({
			id: agent.id,
			sourceRoot: path.relative(cwd, agent.rootDir) || ".",
			responsibility: agent.description || "No responsibility description.",
		}));
	if (areas.length === 0) return undefined;
	return { areas };
}

function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_[\]])/g, "\\$1");
}

function inlineCode(text: string): string {
	const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestRun + 1);
	return `${fence}${text}${fence}`;
}

export function formatLocationalAreaManifest(data: LocationalAreaManifestData, expanded: boolean): string {
	return data.areas
		.map((area) => {
			const name = path.basename(area.sourceRoot) || path.basename(area.id);
			const summary = `- **${escapeMarkdown(name)}** (${inlineCode(area.sourceRoot)}): ${escapeMarkdown(area.responsibility)}`;
			return expanded ? `${summary}\n  - ${inlineCode(`subprocess id ${JSON.stringify(area.id)}`)}` : summary;
		})
		.join("\n");
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

export function renderLocationalAreaManifest(entry: { data?: LocationalAreaManifestData }, { expanded }: { expanded: boolean }, theme: any) {
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[areas]")), 0, 0));
	if (entry.data?.areas.length) {
		box.addChild(new Markdown(formatLocationalAreaManifest(entry.data, expanded), 0, 0, makeMarkdownTheme(theme), {
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
