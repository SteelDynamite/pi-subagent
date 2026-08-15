import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	LOCATIONAL_AREA_MANIFEST_ENTRY,
	appendLocationalAreaManifest,
	formatLocationalAreaManifest,
	makeLocationalAreaManifest,
	renderLocationalAreaManifest,
} from "../area-manifest.ts";
import {
	ADVERTISE_LOCATIONAL_AGENTS_ENV,
	ORCHESTRATED_CHILD_ENV,
	SUBPROCESS_CHILD_ENV,
} from "../constants.ts";
import subprocessExtension from "../index.ts";
import { formatBehavioralAgentManifest } from "../prompt.ts";

function agent(rootDir, overrides = {}) {
	return {
		id: rootDir,
		description: "Owns this source.",
		manifest: true,
		systemPrompt: "",
		origin: "locational",
		kind: "locational",
		filePath: join(rootDir, "SUBAGENTS.md"),
		rootDir,
		resumable: true,
		...overrides,
	};
}

async function withCleanManifestEnv(fn) {
	const keys = [ADVERTISE_LOCATIONAL_AGENTS_ENV, ORCHESTRATED_CHILD_ENV, SUBPROCESS_CHILD_ENV, "PI_CODING_AGENT_DIR"];
	const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	try {
		return await fn();
	} finally {
		for (const key of keys) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	}
}

test("area manifest uses visible canonical locational records only", () => {
	const cwd = resolve("/project");
	const owned = join(cwd, "packages", "owned");
	const other = join(cwd, "packages", "other");
	const manifest = makeLocationalAreaManifest([
		agent(owned),
		agent(other, { description: "Owns other source." }),
		agent(join(cwd, "hidden"), { manifest: false }),
		agent(join(cwd, "behavioral"), { id: "worker", kind: "behavioral", origin: "user" }),
	]);

	assert.deepEqual(manifest, {
		content: `## Available locational agents

Each path below is both a locational agent's source root and full \`subprocess\` id. Work inside listed roots must be delegated to the corresponding agent rather than accessed directly.

- \`/project/packages/owned\`: Owns this source.
- \`/project/packages/other\`: Owns other source.`,
	});
});

test("behavioral manifest excludes locational agents", () => {
	const behavioral = agent("/project/worker", { id: "worker", kind: "behavioral", origin: "user", description: "General work." });
	const manifest = formatBehavioralAgentManifest([behavioral, agent("/project/owned")]);
	assert.equal(manifest, `<available-behavioral-subprocess-agents>
  <agent>
    <id>worker</id>
    <description>General work.</description>
  </agent>
</available-behavioral-subprocess-agents>`);
});

test("TUI lifecycle append is trusted, durable, and deduplicated on the active branch", () => withCleanManifestEnv(() => {
	const root = mkdtempSync(join(tmpdir(), "pi-subprocess-area-manifest-"));
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owns the service.\n---\nBody\n");
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent-dir");

		let visibleEntries = [];
		const appended = [];
		const pi = {
			appendEntry(customType, data) {
				const entry = { type: "custom", customType, data };
				appended.push(entry);
				visibleEntries.push(entry);
			},
		};
		const ctx = {
			mode: "tui",
			cwd: root,
			isProjectTrusted: () => true,
			sessionManager: {
				getBranch: () => visibleEntries,
				buildContextEntries: () => visibleEntries,
			},
		};

		assert.equal(appendLocationalAreaManifest(pi, ctx), true);
		assert.equal(appended.length, 1);
		assert.equal(appended[0].customType, LOCATIONAL_AREA_MANIFEST_ENTRY);
		assert.equal(appended[0].data.content.includes(`- \`${owned}\`: Owns the service.`), true);
		assert.equal(appendLocationalAreaManifest(pi, ctx), false, "reload/resume must not repeat a visible snapshot");

		visibleEntries = [];
		assert.equal(appendLocationalAreaManifest(pi, ctx), true, "a branch without the snapshot gets its own entry");
		assert.equal(appended.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}));

test("extension lifecycle restores one visible snapshot after start, tree navigation, and compaction", () => withCleanManifestEnv(async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subprocess-area-lifecycle-"));
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owns lifecycle tests.\n---\nBody\n");
		process.env.PI_CODING_AGENT_DIR = join(root, "empty-agent-dir");

		const handlers = new Map();
		const renderedTypes = [];
		const appended = [];
		let visibleEntries = [];
		const pi = {
			on(name, handler) {
				const registered = handlers.get(name) ?? [];
				registered.push(handler);
				handlers.set(name, registered);
			},
			registerCommand() {},
			registerTool() {},
			registerEntryRenderer(customType) { renderedTypes.push(customType); },
			appendEntry(customType, data) {
				const entry = { type: "custom", customType, data };
				appended.push(entry);
				visibleEntries.push(entry);
			},
		};
		subprocessExtension(pi);
		const ctx = {
			mode: "tui",
			cwd: root,
			hasUI: true,
			isProjectTrusted: () => true,
			ui: {},
			sessionManager: {
				getBranch: () => visibleEntries,
				buildContextEntries: () => visibleEntries,
			},
		};

		assert.deepEqual(renderedTypes, [LOCATIONAL_AREA_MANIFEST_ENTRY]);
		await handlers.get("session_start")[0]({ reason: "startup" }, ctx);
		await handlers.get("session_start")[0]({ reason: "reload" }, ctx);
		assert.equal(appended.length, 1);

		const modelPrompt = await handlers.get("before_agent_start")[0]({
			systemPrompt: "base",
			systemPromptOptions: { contextFiles: [], selectedTools: [], toolSnippets: {} },
		}, ctx);
		assert.equal(modelPrompt.systemPrompt.endsWith(appended[0].data.content), true, "model and TUI must receive the same canonical locational text");

		visibleEntries = [];
		await handlers.get("session_tree")[0]({}, ctx);
		assert.equal(appended.length, 2);

		visibleEntries = [];
		await handlers.get("session_compact")[0]({}, ctx);
		assert.equal(appended.length, 3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}));

test("area manifest is suppressed outside trusted parent TUI sessions", () => withCleanManifestEnv(() => {
	let calls = 0;
	const pi = { appendEntry: () => calls++ };
	const ctx = {
		mode: "rpc",
		cwd: "/tmp/project",
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [] },
	};
	assert.equal(appendLocationalAreaManifest(pi, ctx), false);

	ctx.mode = "tui";
	ctx.isProjectTrusted = () => false;
	assert.equal(appendLocationalAreaManifest(pi, ctx), false);

	ctx.isProjectTrusted = () => true;
	process.env[SUBPROCESS_CHILD_ENV] = "1";
	assert.equal(appendLocationalAreaManifest(pi, ctx), false);
	delete process.env[SUBPROCESS_CHILD_ENV];
	process.env[ORCHESTRATED_CHILD_ENV] = "1";
	assert.equal(appendLocationalAreaManifest(pi, ctx), false);
	delete process.env[ORCHESTRATED_CHILD_ENV];
	process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV] = "0";
	assert.equal(appendLocationalAreaManifest(pi, ctx), false);
	assert.equal(calls, 0);
}));

test("legacy v0.0.1 area data formats as the minimal canonical locational manifest", () => {
	const content = formatLocationalAreaManifest({
		areas: [{
			id: "/project/repos/pi-answer",
			sourceRoot: "repos/pi-answer",
			responsibility: "Maintains the pi-answer extension",
		}],
	});
	assert.equal(content, `## Available locational agents

Each path below is both a locational agent's source root and full \`subprocess\` id. Work inside listed roots must be delegated to the corresponding agent rather than accessed directly.

- \`/project/repos/pi-answer\`: Maintains the pi-answer extension`);
});

test("area manifest renderer has identical collapsed and expanded content", () => {
	const foregrounds = [];
	const backgrounds = [];
	const style = (text) => text;
	const theme = {
		bold: style,
		italic: style,
		underline: style,
		strikethrough: style,
		fg(color, text) {
			foregrounds.push(color);
			return text;
		},
		bg(color, text) {
			backgrounds.push(color);
			return text;
		},
	};
	const entry = {
		data: makeLocationalAreaManifest([agent("/project/owned", { description: "Owns it." })]),
	};
	const collapsed = renderLocationalAreaManifest(entry, { expanded: false }, theme).render(120).join("\n");
	const expanded = renderLocationalAreaManifest(entry, { expanded: true }, theme).render(120).join("\n");

	assert.equal(expanded, collapsed);
	assert.match(collapsed, /Available locational agents/);
	assert.match(collapsed, /Each path below is both a locational agent's source root and full subprocess id\./);
	assert.match(collapsed, /- \/project\/owned: Owns it\./);
	assert.doesNotMatch(collapsed, /relative to parent|Source root:|Description:|Routing:/);
	assert.ok(foregrounds.includes("customMessageText"));
	assert.ok(backgrounds.every((color) => color === "customMessageBg"));
	assert.ok(backgrounds.length > 0);
});
