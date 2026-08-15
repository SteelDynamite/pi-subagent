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
	const cwd = resolve("/tmp/project");
	const owned = join(cwd, "packages", "owned");
	const manifest = makeLocationalAreaManifest(cwd, [
		agent(owned),
		agent(join(cwd, "hidden"), { manifest: false }),
		agent(join(cwd, "behavioral"), { id: "worker", kind: "behavioral", origin: "user" }),
	]);

	assert.deepEqual(manifest, {
		areas: [{ id: owned, sourceRoot: "packages/owned", responsibility: "Owns this source." }],
	});
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
		assert.equal(appended[0].data.areas[0].sourceRoot, "owned");
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

test("area manifest formats compact defaults and expanded-only route ids", () => {
	const data = {
		areas: [{
			id: "/project/repos/pi-answer",
			sourceRoot: "repos/pi-answer",
			responsibility: "Maintains the pi-answer extension",
		}],
	};
	assert.equal(
		formatLocationalAreaManifest(data, false),
		"- **pi-answer** (`repos/pi-answer`): Maintains the pi-answer extension",
	);
	assert.equal(
		formatLocationalAreaManifest(data, true),
		'- **pi-answer** (`repos/pi-answer`): Maintains the pi-answer extension\n  - `subprocess id "/project/repos/pi-answer"`',
	);
});

test("area manifest renderer uses custom-message card theme roles", () => {
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
	const component = renderLocationalAreaManifest({
		data: {
			areas: [{ id: "/project/owned", sourceRoot: "owned", responsibility: "Owns it." }],
		},
	}, { expanded: false }, theme);
	const rendered = component.render(100).join("\n");

	assert.match(rendered, /\[areas\]/);
	assert.match(rendered, /- owned \(owned\): Owns it\./);
	assert.doesNotMatch(rendered, /\/project\/owned/);
	assert.ok(foregrounds.includes("customMessageLabel"));
	assert.ok(foregrounds.includes("customMessageText"));
	assert.ok(backgrounds.every((color) => color === "customMessageBg"));
	assert.ok(backgrounds.length > 0);
});
