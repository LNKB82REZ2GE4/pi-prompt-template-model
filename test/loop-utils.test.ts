import test from "node:test";
import assert from "node:assert/strict";
import { didIterationMakeChanges, generateIterationSummary, getIterationEntries } from "../loop-utils.js";

const delegatedEntry = {
	id: "delegated-1",
	type: "custom_message",
	customType: "prompt-template-subagent",
	content: "Done",
	display: true,
	details: {
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "1", name: "write", arguments: { path: "src/a.ts" } },
					{ type: "text", text: "Updated file." },
				],
			},
		],
	},
} as any;

test("didIterationMakeChanges detects delegated write/edit calls", () => {
	assert.equal(didIterationMakeChanges([delegatedEntry]), true);
});

test("generateIterationSummary includes delegated outcomes", () => {
	const summary = generateIterationSummary([delegatedEntry], "simplify", 1, 3);
	assert.match(summary, /modified src\/a\.ts/);
	assert.match(summary, /Outcome: Updated file\./);
});

test("getIterationEntries falls back to full branch when start is missing", () => {
	const branch = [{ id: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }];
	const ctx = {
		sessionManager: {
			getBranch() {
				return branch as any;
			},
		},
	};
	assert.equal(getIterationEntries(ctx as any, null).length, 1);
	assert.equal(getIterationEntries(ctx as any, "missing").length, 1);
});
