import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import promptModelExtension from "../index.js";

const MODEL_ID = "claude-sonnet-4-20250514";
const ACTIVE_MODEL = { provider: "anthropic", id: MODEL_ID };

interface FakeCommand {
	description: string;
	handler: (args: string, ctx: any) => Promise<void>;
}

interface FakeTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<any>;
}

class FakePi {
	commands = new Map<string, FakeCommand>();
	tools = new Map<string, FakeTool>();
	hooks = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
	bus = new Map<string, Array<(data: unknown) => void>>();
	events = {
		emit: (channel: string, data: unknown) => {
			for (const handler of this.bus.get(channel) ?? []) {
				handler(data);
			}
		},
		on: (channel: string, handler: (data: unknown) => void) => {
			const handlers = this.bus.get(channel) ?? [];
			handlers.push(handler);
			this.bus.set(channel, handlers);
			return () => {
				const current = this.bus.get(channel) ?? [];
				this.bus.set(channel, current.filter((candidate) => candidate !== handler));
			};
		},
	};
	skillCommands: Array<{ name: string; source: "skill"; path?: string }> = [];
	userMessages: string[] = [];
	setModelCalls: string[] = [];
	currentModel = ACTIVE_MODEL;
	private thinking = "medium";

	registerMessageRenderer() {}

	registerCommand(name: string, command: FakeCommand) {
		this.commands.set(name, command);
	}

	registerTool(tool: FakeTool) {
		this.tools.set(tool.name, tool);
	}

	getCommands() {
		return this.skillCommands;
	}

	on(event: string, handler: (event: any, ctx: any) => Promise<any> | any) {
		const handlers = this.hooks.get(event) ?? [];
		handlers.push(handler);
		this.hooks.set(event, handlers);
	}

	async emit(event: string, payload: any, ctx: any) {
		for (const handler of this.hooks.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	async emitWithResult(event: string, payload: any, ctx: any) {
		let combined: Record<string, unknown> | undefined;
		for (const handler of this.hooks.get(event) ?? []) {
			const result = await handler(payload, ctx);
			if (!result || typeof result !== "object") continue;
			combined = { ...(combined ?? {}), ...(result as Record<string, unknown>) };
		}
		return combined;
	}

	async setModel(model: { provider: string; id: string }) {
		this.setModelCalls.push(`${model.provider}/${model.id}`);
		this.currentModel = model;
		return true;
	}

	getThinkingLevel() {
		return this.thinking;
	}

	setThinkingLevel(level: string) {
		this.thinking = level;
	}

	sendUserMessage(content: string) {
		this.userMessages.push(content);
	}

	sendMessage() {}
}

async function withTempHome(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-template-model-"));
	const previousHome = process.env.HOME;
	process.env.HOME = root;
	try {
		await run(root);
	} finally {
		process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function createContext(
	cwd: string,
	pi: FakePi,
	models: Array<{ provider: string; id: string }> = [ACTIVE_MODEL],
	options?: { branchEntries?: () => any[]; waitForIdle?: () => Promise<void> },
) {
	let navigateCount = 0;
	const notifications: string[] = [];
	const modelRegistry = {
		find(provider: string, modelId: string) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getAll() {
			return models;
		},
		getAvailable() {
			return models;
		},
		async getApiKey() {
			return "token";
		},
		isUsingOAuth() {
			return false;
		},
	};

	const ctx = {
		cwd,
		get model() {
			return pi.currentModel;
		},
		modelRegistry,
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
			theme: {
				fg(_token: string, text: string) {
					return text;
				},
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {
			if (options?.waitForIdle) {
				await options.waitForIdle();
			}
		},
		sessionManager: {
			getLeafId() {
				return "root";
			},
			getBranch() {
				return options?.branchEntries ? options.branchEntries() : [];
			},
		},
		async navigateTree() {
			navigateCount++;
			return { cancelled: false };
		},
	};

	return {
		ctx,
		getNavigateCount: () => navigateCount,
		getNotifications: () => notifications,
	};
}

test("bare --loop forces convergence on and ignores --no-converge", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("bounded --loop N runs requested iterations when no-converge is set", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 3 --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop finished: 3\/3 iterations/);
	});
});

test("bare --loop stops at unlimited cap when each iteration makes changes", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\n---\nARGS:$@`);

		const changedBranchEntries = () => [
			{ id: "root", type: "message", message: { role: "user", content: [{ type: "text", text: "start" }] } },
			{
				id: "write-1",
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "write", arguments: { path: "src/file.ts" } }],
				},
			},
		];

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], { branchEntries: changedBranchEntries });
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop", ctx);

		assert.equal(pi.userMessages.length, 50);
		assert.match(getNotifications().join("\n"), /Loop finished: 50 iterations \(cap reached\)/);
	});
});

test("frontmatter loop executes without --loop and strips loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 3\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --fresh --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task", "ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 2);
	});
});

test("chain templates support bare --loop as unlimited with forced convergence", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task --loop --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("CLI --loop overrides frontmatter loop and strips repeated loop flags", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 5\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 2 --fresh --fresh --no-converge --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["ARGS:task", "ARGS:task"]);
		assert.equal(getNavigateCount(), 1);
	});
});

test("queued run-prompt applies bare --loop semantics", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nARGS:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-loop", { command: "deslop task --loop --no-converge" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.userMessages, ["ARGS:task"]);
		assert.match(getNotifications().join("\n"), /Loop converged at 1 \(no changes\)/);
	});
});

test("chain templates route before non-chain loop extraction and run with CLI --loop", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task --loop 2 --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task", "WORK:task"]);
	});
});

test("chain templates apply frontmatter loop/fresh/converge defaults", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nloop: 3\nfresh: true\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNavigateCount } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("task", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:task", "WORK:task", "WORK:task"]);
		assert.equal(getNavigateCount(), 2);
	});
});

test("chain templates without loop frontmatter preserve --fresh and --no-converge args", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nWORK:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("--fresh --no-converge", ctx);

		assert.deepEqual(pi.userMessages, ["WORK:--fresh --no-converge"]);
	});
});

test("chain templates honor per-step --loop counts", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first --loop 2 -> second --loop 3\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nfirst`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\nconverge: false\n---\nsecond`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["first", "first", "second", "second", "second"]);
	});
});

test("chain templates treat quoted --loop step args as literals", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), '---\nchain: worker "--loop" "2"\n---\nignored');
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker:$1:$2`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["worker:--loop:2"]);
	});
});

test("per-step convergence stops on first no-change iteration when step converge is enabled", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker --loop 3\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["worker"]);
	});
});

test("chain template execution rejects chain nesting when a step is a chain template", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "outer.md"), "---\nchain: inner\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), `---\nmodel: ${MODEL_ID}\n---\nleaf`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const outer = pi.commands.get("outer");
		assert.ok(outer);
		await outer.handler("", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /chain nesting is not supported/i);
	});
});

test("chain nesting is rejected when a step references a chain template", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "inner.md"), "---\nchain: leaf\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "leaf.md"), `---\nmodel: ${MODEL_ID}\n---\nleaf`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("inner", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /chain nesting is not supported/i);
	});
});

test("chain steps without model inherit the chain-start model deterministically", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/target-model\n---\nFIRST");
		writeFileSync(
			join(cwd, ".pi", "prompts", "second.md"),
			'---\ndescription: "inherits"\n---\nSECOND:<if-model is="anthropic/base-model">BASE<else>OTHER</if-model>',
		);

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("first -> second", ctx);

		assert.deepEqual(pi.userMessages, ["FIRST", "SECOND:BASE"]);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
	});
});

test("chain-prompts rejects empty step segments", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\n---\nfirst`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\n---\nsecond`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await chainPrompts.handler("first -> -> second", ctx);

		assert.equal(pi.userMessages.length, 0);
		assert.match(getNotifications().join("\n"), /invalid chain step/i);
	});
});

test("chain templates use step args first and fall back to shared CLI args", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first explicit -> second\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), `---\nmodel: ${MODEL_ID}\n---\nFIRST:$1`);
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), `---\nmodel: ${MODEL_ID}\n---\nSECOND:$1`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("shared", ctx);

		assert.deepEqual(pi.userMessages, ["FIRST:explicit", "SECOND:shared"]);
	});
});

test("chain template restore false leaves final model active", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: first -> second\nrestore: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/first-model\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), "---\nmodel: anthropic/second-model\n---\nsecond");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const firstModel = { provider: "anthropic", id: "first-model" };
		const secondModel = { provider: "anthropic", id: "second-model" };
		const models = [baseModel, firstModel, secondModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await pipeline.handler("", ctx);

		assert.deepEqual(pi.setModelCalls, ["anthropic/first-model", "anthropic/second-model"]);
		assert.deepEqual(pi.currentModel, secondModel);
	});
});

test("queued run-prompt executes chain templates through runPromptCommand routing", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker:$@`);

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-chain", { command: "pipeline task --loop 2 --no-converge" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.userMessages, ["worker:task", "worker:task"]);
	});
});

test("queued run-prompt restores pending session state before executing queued command", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "first.md"), "---\nmodel: anthropic/loop-first\nrestore: true\n---\nfirst");
		writeFileSync(join(cwd, ".pi", "prompts", "second.md"), "---\nmodel: anthropic/loop-second\nrestore: true\n---\nsecond");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const firstModel = { provider: "anthropic", id: "loop-first" };
		const secondModel = { provider: "anthropic", id: "loop-second" };
		const models = [baseModel, firstModel, secondModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const first = pi.commands.get("first");
		assert.ok(first);
		await first.handler("", ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/loop-first"]);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-1", { command: "second" });

		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/loop-first", "anthropic/base-model", "anthropic/loop-second"]);
	});
});

test("prompt loop does not report completion when execution throws mid-run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nTASK:$@`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw new Error("mid-loop-crash");
			},
		});
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await assert.rejects(deslop.handler("", ctx), /mid-loop-crash/);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("prompt loop preserves falsy thrown errors and suppresses completion", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nloop: 2\nconverge: false\n---\nTASK:$@`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw 0;
			},
		});
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await assert.rejects(deslop.handler("", ctx), (error) => error === 0);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("loop restore uses runtime model state even when command context model is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\n---\nARGS:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("task --loop 1", staleCtx);
		assert.deepEqual(pi.currentModel, baseModel);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
	});
});

test("chain loop does not report completion when execution throws mid-run", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nloop: 2\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw new Error("mid-loop-crash");
			},
		});
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await assert.rejects(pipeline.handler("", ctx), /mid-loop-crash/);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("chain loop preserves falsy thrown errors and suppresses completion", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "pipeline.md"), "---\nchain: worker\nloop: 2\nconverge: false\n---\nignored");
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), `---\nmodel: ${MODEL_ID}\n---\nworker`);

		let idleCalls = 0;
		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, [ACTIVE_MODEL], {
			waitForIdle: async () => {
				idleCalls++;
				if (idleCalls === 2) throw 0;
			},
		});
		await pi.emit("session_start", {}, ctx);

		const pipeline = pi.commands.get("pipeline");
		assert.ok(pipeline);
		await assert.rejects(pipeline.handler("", ctx), (error) => error === 0);
		assert.doesNotMatch(getNotifications().join("\n"), /Loop finished|Loop converged/i);
	});
});

test("chain execution restores model after unexpected step failure", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: anthropic/target-model\n---\nworker");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models, {
			waitForIdle: async () => {
				throw new Error("step-failure");
			},
		});
		await pi.emit("session_start", {}, ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await assert.rejects(chainPrompts.handler("worker", ctx), /step-failure/);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);
		assert.deepEqual(pi.currentModel, baseModel);
	});
});

test("chain cleanup runs even when restore throws", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "worker.md"), "---\nmodel: anthropic/target-model\nskill: tmux\n---\nworker");
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: helper\n---\nUse tmux.");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		pi.setModel = async (model: { provider: string; id: string }) => {
			pi.setModelCalls.push(`${model.provider}/${model.id}`);
			if (model.id === "base-model") throw new Error("restore-crash");
			pi.currentModel = model;
			return true;
		};

		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", ctx);

		const chainPrompts = pi.commands.get("chain-prompts");
		assert.ok(chainPrompts);
		await assert.rejects(chainPrompts.handler("worker", ctx), /restore-crash/);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model", "anthropic/base-model"]);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		assert.match(String(beforeStart.systemPrompt ?? ""), /run-prompt tool is available/i);
		assert.equal("message" in beforeStart, false);
	});
});

test("prompt without model inherits current model for conditionals and skill injection", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), "---\nskill: tmux\n---\n<if-model is=\"anthropic/*\">KEEP<else>DROP</if-model>");
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: tmux helper\n---\nAlways use tmux.");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, [ACTIVE_MODEL]);
		await pi.emit("session_start", {}, ctx);

		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("", ctx);

		assert.deepEqual(pi.userMessages, ["KEEP"]);
		assert.deepEqual(pi.setModelCalls, []);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		const message = beforeStart.message as { customType?: string; content?: string } | undefined;
		assert.equal(message?.customType, "skill-loaded");
		assert.match(message?.content ?? "", /Always use tmux\./);
	});
});

test("model-less prompt uses tracked runtime model even when command context model is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "dc"\n---\n<if-model is="anthropic/target-model">TARGET<else>BASE</if-model>');

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		pi.currentModel = targetModel;
		await pi.emit("model_select", { model: targetModel, previousModel: baseModel, source: "set" }, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const doubleCheck = pi.commands.get("double-check");
		assert.ok(doubleCheck);
		await doubleCheck.handler("", staleCtx);

		assert.deepEqual(pi.userMessages, ["TARGET"]);
		assert.deepEqual(pi.setModelCalls, []);
	});
});

test("queued model-less prompt uses agent-end runtime model when stored command context is stale", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "double-check.md"), '---\ndescription: "dc"\n---\n<if-model is="anthropic/target-model">TARGET<else>BASE</if-model>');

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const staleCtx = { ...ctx, model: baseModel };
		const promptTool = pi.commands.get("prompt-tool");
		assert.ok(promptTool);
		await promptTool.handler("on", staleCtx);

		const runPromptTool = pi.tools.get("run-prompt");
		assert.ok(runPromptTool);
		await runPromptTool.execute("tool-call-model-less", { command: "double-check" });

		pi.currentModel = targetModel;
		await pi.emit("agent_end", {}, ctx);

		assert.deepEqual(pi.userMessages, ["TARGET"]);
		assert.deepEqual(pi.setModelCalls, []);
	});
});

test("skill injects as before_agent_start message without mutating system prompt", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: tmux\n---\nTASK:$@`);
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: tmux helper\n---\nAlways use tmux.");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.userMessages, ["TASK:demo"]);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		assert.equal("systemPrompt" in beforeStart, false);
		const message = beforeStart.message as
			| {
					customType?: string;
					content?: string;
					display?: boolean;
					details?: { skillName?: string; skillContent?: string; skillPath?: string };
			  }
			| undefined;
		assert.ok(message);
		assert.equal(message.customType, "skill-loaded");
		assert.equal(message.display, true);
		assert.match(message.content ?? "", /<skill name="tmux">/);
		assert.match(message.content ?? "", /Always use tmux\./);
		assert.equal(message.details?.skillName, "tmux");
		assert.equal(await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
	});
});

test("skill resolves from registered skill commands and supports skill: prefix", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		const skillPath = join(root, "custom-skills", "external-skill.md");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, "custom-skills"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: skill:external-skill\n---\nTASK:$@`);
		writeFileSync(skillPath, "---\nname: external-skill\ndescription: external\n---\nUse external skill.");

		const pi = new FakePi();
		pi.skillCommands = [{ name: "skill:external-skill", source: "skill", path: skillPath }];
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.userMessages, ["TASK:demo"]);

		const beforeStart = await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx);
		assert.ok(beforeStart);
		const message = beforeStart.message as { content?: string; details?: { skillName?: string; skillPath?: string } } | undefined;
		assert.ok(message);
		assert.match(message.content ?? "", /Use external skill\./);
		assert.equal(message.details?.skillName, "external-skill");
		assert.equal(message.details?.skillPath, skillPath);
	});
});

test("missing skill aborts before model switch and before_agent_start injection", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\nskill: missing-skill\n---\nTASK:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.setModelCalls, []);
		assert.deepEqual(pi.currentModel, baseModel);
		assert.deepEqual(pi.userMessages, []);
		assert.equal(await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
		assert.match(getNotifications().join("\n"), /Skill "missing-skill" not found/);
	});
});

test("skill path traversal names are rejected", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: ..\n---\nTASK:$@`);
		writeFileSync(join(cwd, ".pi", "SKILL.md"), "Unexpected traversal target");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx, getNotifications } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.userMessages, []);
		assert.match(getNotifications().join("\n"), /Skill "\.\." not found/);
	});
});

test("session switch clears queued skill message", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		mkdirSync(join(root, ".pi", "agent", "skills", "tmux"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), `---\nmodel: ${MODEL_ID}\nskill: tmux\n---\nTASK:$@`);
		writeFileSync(join(root, ".pi", "agent", "skills", "tmux", "SKILL.md"), "---\nname: tmux\ndescription: tmux helper\n---\nAlways use tmux.");

		const pi = new FakePi();
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		await pi.emit("session_switch", {}, ctx);
		assert.equal(await pi.emitWithResult("before_agent_start", { systemPrompt: "BASE" }, ctx), undefined);
	});
});

test("session switch clears pending restore state", async () => {
	await withTempHome(async (root) => {
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi", "prompts"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "prompts", "deslop.md"), "---\nmodel: anthropic/target-model\nrestore: true\n---\nTASK:$@");

		const baseModel = { provider: "anthropic", id: "base-model" };
		const targetModel = { provider: "anthropic", id: "target-model" };
		const models = [baseModel, targetModel];

		const pi = new FakePi();
		pi.currentModel = baseModel;
		promptModelExtension(pi as never);
		const { ctx } = createContext(cwd, pi, models);
		await pi.emit("session_start", {}, ctx);

		const deslop = pi.commands.get("deslop");
		assert.ok(deslop);
		await deslop.handler("demo", ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model"]);
		await pi.emit("session_switch", {}, ctx);
		await pi.emit("agent_end", {}, ctx);
		assert.deepEqual(pi.setModelCalls, ["anthropic/target-model"]);
	});
});
