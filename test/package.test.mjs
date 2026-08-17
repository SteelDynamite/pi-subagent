import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("package exposes only the parent-owned implement workflow", () => {
	const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
	assert.deepEqual(manifest.pi.prompts, ["./prompts"]);
	assert.deepEqual(readdirSync(new URL("prompts/", root)).sort(), ["implement.md"]);

	const prompt = readFileSync(new URL("prompts/implement.md", root), "utf8");
	assert.match(prompt, /orchestrating parent/);
	assert.match(prompt, /do not delegate planning/);
	assert.match(prompt, /`scout`/);
	assert.match(prompt, /advertised locational root/);
	assert.match(prompt, /delegate directly to its owning locational agent/);
	assert.match(prompt, /Otherwise, use `worker`/);
	assert.match(prompt, /explicitly requested review/);
});
