import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeSubagentPromptStep } from "../subagent-step.js";
import {
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
} from "../subagent-runtime.js";

function withRuntime(run: (root: string) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-prompt-subagent-step-"));
	const runtimeRoot = join(root, "subagent");
	mkdirSync(runtimeRoot, { recursive: true });
	writeFileSync(join(runtimeRoot, "agents.js"), "export function discoverAgents(){ return { agents: [{ name: 'delegate' }, { name: 'reviewer' }] }; }");
	const previous = process.env.PI_SUBAGENT_RUNTIME_ROOT;
	process.env.PI_SUBAGENT_RUNTIME_ROOT = runtimeRoot;
	return run(root).finally(() => {
		if (previous === undefined) delete process.env.PI_SUBAGENT_RUNTIME_ROOT;
		else process.env.PI_SUBAGENT_RUNTIME_ROOT = previous;
		rmSync(root, { recursive: true, force: true });
	});
}

function createPi() {
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const customMessages: unknown[] = [];
	return {
		customMessages,
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const handlers = bus.get(channel) ?? [];
				handlers.push(handler);
				bus.set(channel, handlers);
				return () => {
					const current = bus.get(channel) ?? [];
					bus.set(channel, current.filter((entry) => entry !== handler));
				};
			},
		},
		sendMessage(message: unknown) {
			customMessages.push(message);
		},
	} as any;
}

function createCtx(cwd: string) {
	const model = { provider: "anthropic", id: "claude-sonnet-4-20250514" };
	return {
		cwd,
		hasUI: false,
		model,
		modelRegistry: {
			find(provider: string, id: string) {
				if (provider === model.provider && id === model.id) return model;
				return undefined;
			},
			getAll() {
				return [model];
			},
			getAvailable() {
				return [model];
			},
			async getApiKey() {
				return "token";
			},
			isUsingOAuth() {
				return false;
			},
		},
		ui: {
			notify() {},
			onTerminalInput() {
				return () => {};
			},
			setStatus() {},
			setWorkingMessage() {},
			setWidget() {},
			theme: { fg(_t: string, text: string) { return text; }, bold(text: string) { return text; } },
		},
		sessionManager: {
			getLeafId() {
				return "leaf";
			},
			getBranch() {
				return [];
			},
		},
		isIdle() {
			return false;
		},
		async waitForIdle() {},
	} as any;
}

function createInteractiveCtx(cwd: string) {
	const ctx = createCtx(cwd);
	ctx.hasUI = true;
	let terminalHandler: ((input: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	ctx.ui.onTerminalInput = (handler: (input: string) => { consume?: boolean; data?: string } | undefined) => {
		terminalHandler = handler;
		return () => {
			if (terminalHandler === handler) terminalHandler = undefined;
		};
	};
	return {
		ctx,
		sendInput: (input: string) => terminalHandler?.(input),
	};
}

const prompt = {
	name: "simplify",
	description: "",
	content: "do work",
	models: ["anthropic/claude-sonnet-4-20250514"],
	restore: true,
	source: "project",
	filePath: "prompt.md",
	subagent: true,
} as any;

test("executeSubagentPromptStep returns delegated change info", async () => {
	await withRuntime(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "1", name: "write", arguments: { path: "a.ts" } },
							{ type: "text", text: "Done." },
						],
					},
				],
				isError: false,
			});
		});

		const result = await executeSubagentPromptStep({
			pi,
			prompt,
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(result?.changed, true);
		assert.equal(pi.customMessages.length, 1);
	});
});

test("executeSubagentPromptStep forwards prompt cwd to delegated request", async () => {
	await withRuntime(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		const delegatedCwd = join(root, "delegated-cwd");
		mkdirSync(delegatedCwd, { recursive: true });
		let requestCwd: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			requestCwd = request.cwd;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }],
				isError: false,
			});
		});

		await executeSubagentPromptStep({
			pi,
			prompt: { ...prompt, cwd: delegatedCwd },
			args: [],
			ctx,
			currentModel: ctx.model,
		});
		assert.equal(requestCwd, delegatedCwd);
	});
});

test("executeSubagentPromptStep fails on delegated error response", async () => {
	await withRuntime(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [],
				isError: true,
				errorText: "boom",
			});
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/boom/,
		);
	});
});

test("executeSubagentPromptStep fails when delegated response has no assistant text", async () => {
	await withRuntime(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, {
				...request,
				messages: [{ role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }] }],
				isError: false,
			});
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/no assistant text/i,
		);
	});
});

test("executeSubagentPromptStep times out when no start event is emitted", async () => {
	await withRuntime(async (root) => {
		const previous = process.env.PI_PROMPT_SUBAGENT_START_TIMEOUT_MS;
		process.env.PI_PROMPT_SUBAGENT_START_TIMEOUT_MS = "10";
		try {
			const pi = createPi();
			const ctx = createCtx(root);
			await assert.rejects(
				() =>
					executeSubagentPromptStep({
						pi,
						prompt,
						args: [],
						ctx,
						currentModel: ctx.model,
					}),
				/did not start within \d+s/i,
			);
		} finally {
			if (previous === undefined) delete process.env.PI_PROMPT_SUBAGENT_START_TIMEOUT_MS;
			else process.env.PI_PROMPT_SUBAGENT_START_TIMEOUT_MS = previous;
		}
	});
});

test("executeSubagentPromptStep fails when requested agent does not exist", async () => {
	await withRuntime(async (root) => {
		const pi = createPi();
		const ctx = createCtx(root);
		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt: { ...prompt, subagent: "missing" },
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/not found/i,
		);
	});
});

test("executeSubagentPromptStep emits cancel on escape in UI mode", async () => {
	await withRuntime(async (root) => {
		const pi = createPi();
		const { ctx, sendInput } = createInteractiveCtx(root);
		let cancelledRequestId: string | undefined;

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, (data) => {
			cancelledRequestId = (data as { requestId?: string }).requestId;
		});

		pi.events.on(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, (data) => {
			const request = data as any;
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, { requestId: request.requestId });
			setTimeout(() => sendInput("\x1b"), 0);
		});

		await assert.rejects(
			() =>
				executeSubagentPromptStep({
					pi,
					prompt,
					args: [],
					ctx,
					currentModel: ctx.model,
				}),
			/cancelled/i,
		);
		assert.ok(cancelledRequestId);
	});
});
