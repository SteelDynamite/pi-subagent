import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents, isPathInside, loadLocationalAgent, resolveLocationalAgentId, scanLocationalAgents } from "../agents.ts";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-subagent-agents-test-"));
}

test("loadLocationalAgent parses frontmatter, defaults, and same-root @includes", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "extra.md"), "included body");
		writeFileSync(join(root, "SUBAGENTS.md"), "---\ndescription: Test\ntools: read, bash\nmanifest: false\nresumable: no\n---\n@extra.md\n");
		const { agent, error } = loadLocationalAgent(root, { readBody: true });
		assert.equal(error, undefined);
		assert.equal(agent.description, "Test");
		assert.deepEqual(agent.tools, ["read", "bash"]);
		assert.equal(agent.manifest, false);
		assert.equal(agent.resumable, false);
		assert.equal(agent.systemPrompt, "included body");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadLocationalAgent reports unsupported frontmatter", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "SUBAGENTS.md"), "---\nunknown: value\n---\nBody\n");
		const { agent, error } = loadLocationalAgent(root, { readBody: true });
		assert.equal(agent, undefined);
		assert.match(error, /unsupported frontmatter/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanLocationalAgents finds nested roots, skips node_modules, and resolves ids", () => {
	const root = tempDir();
	try {
		const owned = join(root, "owned");
		const skipped = join(root, "node_modules", "owned");
		mkdirSync(owned, { recursive: true });
		mkdirSync(skipped, { recursive: true });
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");
		writeFileSync(join(skipped, "SUBAGENTS.md"), "---\ndescription: Skipped\n---\nBody\n");

		const scan = scanLocationalAgents(root, { maxDepth: 4, timeoutMs: 1000 });
		assert.deepEqual(scan.agents.map((agent) => realpathSync.native(agent.rootDir)), [realpathSync.native(owned)]);
		assert.equal(realpathSync.native(resolveLocationalAgentId(root, "owned").rootDir), realpathSync.native(owned));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("behavioral discovery precedence is bundled, user, then trusted project", () => {
	const root = tempDir();
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(join(agentDir, "agents", "scout"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "scout", "SUBAGENTS.md"), "---\ndescription: User scout\n---\nUser\n");
		mkdirSync(join(root, ".pi", "agents", "scout"), { recursive: true });
		writeFileSync(join(root, ".pi", "agents", "scout", "SUBAGENTS.md"), "---\ndescription: Project scout\n---\nProject\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const untrusted = discoverAgents(root, false, { includeLocationalAgents: false });
		assert.equal(untrusted.agents.find((agent) => agent.id === "scout").description, "User scout");
		assert.equal(untrusted.projectAgentsDir, null);

		const trusted = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").description, "Project scout");
		assert.equal(trusted.projectAgentsDir, join(root, ".pi", "agents"));
		assert.deepEqual(trusted.agents.map((agent) => agent.id).sort(), ["reviewer", "scout", "worker"]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("locational discovery requires project trust", () => {
	const root = tempDir();
	try {
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");
		assert.equal(discoverAgents(root, false).locationalAgents.length, 0);
		assert.equal(discoverAgents(root, true).locationalAgents[0].rootDir, owned);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isPathInside includes root and descendants but excludes siblings", () => {
	const root = tempDir();
	const sibling = `${root}-sibling`;
	try {
		mkdirSync(join(root, "child"));
		mkdirSync(sibling);
		assert.equal(isPathInside(root, root), true);
		assert.equal(isPathInside(join(root, "child"), root), true);
		assert.equal(isPathInside(sibling, root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(sibling, { recursive: true, force: true });
	}
});
