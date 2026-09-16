import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { THINKING_LEVELS, discoverAgents, isPathInside, loadLocationalAgent, resolveLocationalAgentId, scanLocationalAgents } from "../agents.ts";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-subagent-agents-test-"));
}

test("loadLocationalAgent parses frontmatter, defaults, and same-root @includes", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "extra.md"), "included body");
		writeFileSync(join(root, "SUBAGENTS.md"), "---\ndescription: Test\ntools: read, bash\nthinking: high\nmanifest: false\nresumable: no\n---\n@extra.md\n");
		const { agent, error } = loadLocationalAgent(root, { readBody: true });
		assert.equal(error, undefined);
		assert.equal(agent.description, "Test");
		assert.deepEqual(agent.tools, ["read", "bash"]);
		assert.equal(agent.thinking, "high");
		assert.equal(agent.manifest, false);
		assert.equal(agent.resumable, false);
		assert.equal(agent.systemPrompt, "included body");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("agent definitions validate thinking for locational and behavioral agents", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "SUBAGENTS.md"), "---\nthinking: deepest\n---\n");
		const locational = loadLocationalAgent(root, { readBody: true });
		assert.equal(locational.agent, undefined);
		assert.match(locational.error, /unsupported thinking level "deepest"/);

		const behavioralRoot = join(root, ".pi", "agents", "thinker");
		mkdirSync(behavioralRoot, { recursive: true });
		writeFileSync(join(behavioralRoot, "SUBAGENTS.md"), "---\nthinking: deepest\n---\n");
		const behavioral = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(behavioral.agents.some((agent) => agent.id === "thinker"), false);
		assert.match(behavioral.errors.join("\n"), /unsupported thinking level "deepest"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadLocationalAgent accepts every supported thinking level", () => {
	const root = tempDir();
	try {
		for (const thinking of THINKING_LEVELS) {
			writeFileSync(join(root, "SUBAGENTS.md"), `---\nthinking: ${thinking}\n---\n`);
			const { agent, error } = loadLocationalAgent(root, { readBody: true });
			assert.equal(error, undefined);
			assert.equal(agent.thinking, thinking);
		}
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
		writeFileSync(join(root, ".pi", "agents", "scout", "SUBAGENTS.md"), "---\ndescription: Project scout\nthinking: medium\n---\nProject\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const untrusted = discoverAgents(root, false, { includeLocationalAgents: false });
		assert.equal(untrusted.agents.find((agent) => agent.id === "scout").description, "User scout");
		assert.equal(untrusted.agents.find((agent) => agent.id === "scout").overrides, true);
		assert.equal(untrusted.projectAgentsDir, null);

		const trusted = discoverAgents(root, true, { includeLocationalAgents: false });
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").description, "Project scout");
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").thinking, "medium");
		assert.equal(trusted.agents.find((agent) => agent.id === "scout").overrides, true);
		assert.equal(trusted.projectAgentsDir, join(root, ".pi", "agents"));
		assert.deepEqual(trusted.agents.map((agent) => agent.id).sort(), ["reviewer", "scout", "worker"]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("custom behavioral and ordinary locational definitions are not overrides", () => {
	const root = tempDir();
	const agentDir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		mkdirSync(join(agentDir, "agents", "custom-user"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "custom-user", "SUBAGENTS.md"), "---\ndescription: Custom user\n---\n");
		mkdirSync(join(root, ".pi", "agents", "custom-project"), { recursive: true });
		writeFileSync(join(root, ".pi", "agents", "custom-project", "SUBAGENTS.md"), "---\ndescription: Custom project\n---\n");
		const owned = join(root, "owned");
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const discovered = discoverAgents(root, true);
		assert.equal(discovered.agents.find((agent) => agent.id === "custom-user").overrides, false);
		assert.equal(discovered.agents.find((agent) => agent.id === "custom-project").overrides, false);
		assert.notEqual(discovered.locationalAgents.find((agent) => agent.id === owned).overrides, true);
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
