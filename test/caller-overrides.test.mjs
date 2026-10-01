import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents } from "../agents.ts";
import { resolveAgentModel, runDelegation } from "../execution.ts";
import { subagentSettings, trackedSessions } from "../state.ts";

const defaults = [
	["scout", "gpt-6-luna", "low"],
	["worker", "gpt-6.1-sol", "medium"],
	["reviewer", "gpt-6-astra", "xhigh"],
];
const available = defaults.map(([_id, id]) => ({ provider: "openai", id, contextWindow: 2000 }));
const caller = (id = "gpt-6-astra", provider = "alternate") => ({ provider, id, contextWindow: 4000 });
const context = (model) => ({ model, modelRegistry: { getAvailable: () => available } });
const details = (results) => ({ includeLocationalAgents: false, locationalAgents: [], results });

test("bundled caller rules preserve providers, defaults, and definition state", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-caller-models-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = root;
		const discovery = discoverAgents(root, false, { includeLocationalAgents: false });
		assert.deepEqual(discovery.errors, []);
		for (const [id, model, thinking] of defaults) {
			const agent = discovery.agents.find((item) => item.id === id);
			const original = structuredClone(agent);
			assert.equal(agent.resumable, false);
			assert.equal(agent.model, `openai/${model}`);
			assert.equal(agent.thinking, undefined);
			for (const provider of ["openai", "alternate"]) {
				// The alternate provider need not occur in getAvailable(): select the actual caller directly.
				assert.deepEqual(resolveAgentModel(agent, context(caller("gpt-6-astra", provider))), {
					model: `${provider}/gpt-6-astra`, thinking, contextWindow: 4000, source: "caller",
				});
			}
			for (const modelId of ["gpt-6.1-sol", "other", "GPT-6-ASTRA", "gpt-6-astra-extra", "openai/gpt-6-astra", undefined]) {
				const resolved = resolveAgentModel(agent, context(modelId === undefined ? undefined : caller(modelId)));
				assert.equal(resolved.model, `openai/${model}`);
				assert.equal(resolved.thinking, undefined);
				assert.equal(resolved.source, "agent");
			}
			assert.deepEqual(agent, original);
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("caller rules use the immediate context on every nested delegation, never agent names", () => {
	const agent = { kind: "behavioral", id: "custom", model: "openai/gpt-6-luna", thinking: "high", whenCallerModelId: "gpt-6-astra", thenModel: "caller", thenThinking: "off" };
	const outer = context(caller());
	assert.equal(resolveAgentModel(agent, outer).thinking, "off");
	// An intervening agent chose Sol; its nested call must not inherit the original Astra rule.
	const inner = context(caller("gpt-6.1-sol"));
	assert.equal(resolveAgentModel(agent, inner).model, "openai/gpt-6-luna");
	assert.equal(resolveAgentModel(agent, inner).thinking, "high");
	inner.model = caller("gpt-6-astra", "nested-provider");
	assert.equal(resolveAgentModel(agent, inner).model, "nested-provider/gpt-6-astra");
	assert.equal(resolveAgentModel(agent, inner).thinking, "off");
	assert.equal(resolveAgentModel({ ...agent, kind: "locational" }, outer).thinking, "high");
	assert.equal(resolveAgentModel({ ...agent, kind: "locational" }, outer).model, "openai/gpt-6-luna");
	assert.equal(resolveAgentModel({ ...agent, whenCallerModelId: undefined, thenModel: undefined, thenThinking: undefined }, outer).thinking, "high");

	const unavailable = resolveAgentModel({ ...agent, model: "missing" }, inner);
	assert.equal(unavailable.model, "nested-provider/gpt-6-astra");
	assert.equal(unavailable.warning, undefined);
	const unmatched = resolveAgentModel({ ...agent, model: "missing" }, context(caller("other")));
	assert.equal(unmatched.model, "alternate/other");
	assert.equal(unmatched.thinking, "high");
	assert.match(unmatched.warning, /No configured model/);
	const inherited = resolveAgentModel({ ...agent, model: undefined }, context(caller("other")));
	assert.equal(inherited.model, "alternate/other");
	assert.equal(inherited.thinking, "high");
});

test("child launches apply caller model/effort on new and resume without changing speed or fallback", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-caller-launch-"));
	const originalArgv = process.argv[1];
	const envKeys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_TEST_STATE_FILE", "PI_CHATGPT_SPEED", "PI_SUBAGENT_DEPTH"];
	const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	const originalReuse = subagentSettings.reuseEnabled;
	const originalTracked = new Map(trackedSessions);
	try {
		process.env.PI_CODING_AGENT_DIR = root;
		process.env.PI_SUBAGENT_DEPTH = "1";
		trackedSessions.clear();
		subagentSettings.reuseEnabled = true;
		const stateFile = join(root, "calls.json");
		writeFileSync(stateFile, "[]");
		const piPath = join(root, "fake-pi.cjs");
		writeFileSync(piPath, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, "utf8"));
calls.push({ args, speed: process.env.PI_CHATGPT_SPEED, depth: process.env.PI_SUBAGENT_DEPTH });
fs.writeFileSync(process.env.PI_SUBAGENT_TEST_STATE_FILE, JSON.stringify(calls));
if (args.at(-1) === "Task: fail") { process.stderr.write("provider unavailable"); process.exit(1); }
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }));
`);
		process.argv[1] = piPath;
		process.env.PI_SUBAGENT_TEST_STATE_FILE = stateFile;
		const agents = discoverAgents(root, false, { includeLocationalAgents: false }).agents;
		const ctx = {
			...context(caller()), cwd: root,
			sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
		};
		const expected = [];
		for (const speed of [undefined, "ultrafast"]) {
			if (speed === undefined) delete process.env.PI_CHATGPT_SPEED;
			else process.env.PI_CHATGPT_SPEED = speed;
			for (const modelId of ["gpt-6-astra", "gpt-6.1-sol"]) {
				ctx.model = caller(modelId);
				for (const [id, baseModel, effort] of defaults) {
					const model = modelId === "gpt-6-astra" ? "alternate/gpt-6-astra" : `openai/${baseModel}`;
					const thinking = modelId === "gpt-6-astra" ? effort : undefined;
					const result = await runDelegation({ appendEntry() {} }, ctx, root, agents, id, "new", "launch", undefined, undefined, details, false);
					assert.equal(result.exitCode, 0);
					assert.equal(result.model, model);
					assert.equal(result.agentThinking, thinking);
					expected.push({ model, thinking, speed });
				}
			}
		}
		const flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
		let calls = JSON.parse(readFileSync(stateFile, "utf8"));
		assert.deepEqual(calls.map(({ args, speed }) => ({ model: flag(args, "--model"), thinking: flag(args, "--thinking"), speed })), expected);
		assert.ok(calls.every(({ args, depth }) => args.includes("--no-session") && !args.includes("--session-id") && depth === "2"));

		const resumable = { ...agents.find((agent) => agent.id === "worker"), id: "custom-resumable", resumable: true, thinking: "high" };
		const resumeCases = [
			["new", caller(), "medium", "alternate/gpt-6-astra"],
			["resume", caller("gpt-6-astra", "nested-provider"), "medium", "nested-provider/gpt-6-astra"],
			["resume", caller("gpt-6.1-sol"), "high", "openai/gpt-6.1-sol"],
			["resume", caller(), "off", "alternate/gpt-6-astra"],
			["resume", caller("gpt-6.1-sol"), undefined, "openai/gpt-6.1-sol"],
		];
		for (const [session, model, thinking, expectedModel] of resumeCases) {
			ctx.model = model;
			if (thinking === "off") resumable.thenThinking = "off";
			if (thinking === undefined) delete resumable.thinking;
			const result = await runDelegation({ appendEntry() {} }, ctx, root, [resumable], resumable.id, session, "resume", undefined, undefined, details, false);
			assert.equal(result.exitCode, 0);
			assert.equal(result.nextSessionIntent, "resume");
			assert.equal(result.model, expectedModel);
			assert.equal(result.agentThinking, thinking);
		}
		calls = JSON.parse(readFileSync(stateFile, "utf8"));
		const resumed = calls.slice(expected.length);
		assert.deepEqual(resumed.map(({ args }) => flag(args, "--thinking")), resumeCases.map((item) => item[2]));
		assert.deepEqual(resumed.map(({ args }) => flag(args, "--model")), resumeCases.map((item) => item[3]));
		assert.ok(flag(resumed[0].args, "--session-id"));
		assert.equal(new Set(resumed.map(({ args }) => flag(args, "--session-id"))).size, 1);

		ctx.model = caller();
		const wrong = await runDelegation({ appendEntry() {} }, ctx, root, agents, "scout", "resume", "wrong intent", undefined, undefined, details, false);
		assert.equal(wrong.agentThinking, "low");
		assert.equal(wrong.wrongSessionIntent.required, "new");
		const failure = await runDelegation({ appendEntry() {} }, ctx, root, agents, "worker", "new", "fail", undefined, undefined, details, false);
		assert.equal(failure.exitCode, 1);
		assert.equal(failure.warning, undefined);
		// Wrong intent launches nothing; behavioral failure launches exactly once.
		assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).length, calls.length + 1);
	} finally {
		process.argv[1] = originalArgv;
		for (const [key, value] of originalEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		trackedSessions.clear();
		for (const [key, value] of originalTracked) trackedSessions.set(key, value);
		subagentSettings.reuseEnabled = originalReuse;
		rmSync(root, { recursive: true, force: true });
	}
});
