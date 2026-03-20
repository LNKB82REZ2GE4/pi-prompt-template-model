import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import { preparePromptExecution } from "./prompt-execution.js";
import type { PromptWithModel } from "./prompt-loader.js";
import { notify } from "./notifications.js";
import {
	DEFAULT_SUBAGENT_NAME,
	appendDelegatedLiveOutput,
	clearDelegatedLiveState,
	ensureSubagentRuntime,
	PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
	PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT,
	PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT,
	resolveDelegatedAgent,
	updateDelegatedLiveState,
	type DelegatedSubagentRequest,
	type DelegatedSubagentResponse,
	type DelegatedSubagentUpdate,
} from "./subagent-runtime.js";
import type { SubagentOverride } from "./args.js";
import { createDelegatedProgressWidget, DELEGATED_WIDGET_KEY } from "./subagent-widget.js";

interface DelegatedPromptOptions {
	pi: ExtensionAPI;
	prompt: PromptWithModel;
	args: string[];
	ctx: ExtensionContext;
	currentModel: Model<any> | undefined;
	override?: SubagentOverride;
	signal?: AbortSignal;
	inheritedModel?: Model<any>;
}

export interface DelegatedPromptOutcome {
	changed: boolean;
	text: string;
	agent: string;
}

function extractTextFromBlocks(content: AssistantMessage["content"]): string {
	for (let i = content.length - 1; i >= 0; i--) {
		const block = content[i];
		if (block.type === "text") {
			const trimmed = block.text.trim();
			if (trimmed) return trimmed;
		}
	}
	return "";
}

function extractDelegatedText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = extractTextFromBlocks((message as AssistantMessage).content);
		if (text) return text;
	}
	return "";
}

function delegatedMessagesChanged(messages: Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message as AssistantMessage).content) {
			if (block.type !== "toolCall") continue;
			if (block.name === "write" || block.name === "edit") return true;
		}
	}
	return false;
}

function coerceMessages(messages: unknown[]): Message[] {
	if (!Array.isArray(messages)) return [];
	return messages as Message[];
}

function resolveDelegationName(prompt: PromptWithModel, override?: SubagentOverride): string | undefined {
	if (override) {
		return override.agent || (typeof prompt.subagent === "string" ? prompt.subagent : DEFAULT_SUBAGENT_NAME);
	}
	if (prompt.subagent === true) return DEFAULT_SUBAGENT_NAME;
	if (typeof prompt.subagent === "string") return prompt.subagent;
	return undefined;
}

function formatProgressStatus(update: DelegatedSubagentUpdate): string | undefined {
	if (update.currentTool) {
		return `running ${update.currentTool}${update.currentToolArgs ? ` ${update.currentToolArgs}` : ""}`;
	}
	if (update.toolCount && update.toolCount > 0) {
		return `completed ${update.toolCount} tool${update.toolCount === 1 ? "" : "s"}`;
	}
	return undefined;
}

async function requestDelegatedRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	request: DelegatedSubagentRequest,
	signal?: AbortSignal,
): Promise<DelegatedSubagentResponse> {
	return await new Promise((resolve, reject) => {
		let done = false;
		let started = false;
		const startTimeoutMs = Number(process.env.PI_PROMPT_SUBAGENT_START_TIMEOUT_MS ?? "15000");
		const effectiveTimeout = Number.isFinite(startTimeoutMs) && startTimeoutMs > 0 ? startTimeoutMs : 15_000;
		const startTimeout = setTimeout(() => {
			finish(() => reject(new Error(`Prompt \`${request.task}\` delegated subagent \`${request.agent}\` did not start within ${Math.round(effectiveTimeout / 1000)}s.`)));
		}, effectiveTimeout);

		const onStarted = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const requestId = (data as { requestId?: unknown }).requestId;
			if (requestId !== request.requestId) return;
			started = true;
			clearTimeout(startTimeout);
			updateDelegatedLiveState(request.requestId, { status: "running...", toolCount: 0, recentOutput: [] });
			showWidget();
		};

		const onResponse = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const payload = data as Partial<DelegatedSubagentResponse>;
			if (payload.requestId !== request.requestId) return;
			clearTimeout(startTimeout);
			updateDelegatedLiveState(request.requestId, {
				status: payload.isError ? "failed" : "completed",
			});
			clearWidget();
			finish(() => resolve(payload as DelegatedSubagentResponse));
		};

		let lastProgressStatus = "";
		let widgetSet = false;

		const showWidget = () => {
			if (!ctx.hasUI || widgetSet) return;
			widgetSet = true;
			ctx.ui.setWidget(
				DELEGATED_WIDGET_KEY,
				(_tui, theme) => createDelegatedProgressWidget(request.requestId, request.agent, request.context, request.task, theme),
				{ placement: "aboveEditor" },
			);
		};

		const clearWidget = () => {
			if (ctx.hasUI && widgetSet) {
				ctx.ui.setWidget(DELEGATED_WIDGET_KEY, undefined);
				widgetSet = false;
			}
		};

		const onUpdate = (data: unknown) => {
			if (done || !data || typeof data !== "object") return;
			const update = data as DelegatedSubagentUpdate;
			if (update.requestId !== request.requestId) return;
			const progressStatus = formatProgressStatus(update);
			if (progressStatus) {
				lastProgressStatus = progressStatus;
			}
			updateDelegatedLiveState(request.requestId, {
				status: progressStatus ?? (lastProgressStatus || "running..."),
				currentTool: update.currentTool,
				currentToolArgs: update.currentToolArgs,
				toolCount: update.toolCount,
				durationMs: update.durationMs,
				tokens: update.tokens,
			});
			appendDelegatedLiveOutput(request.requestId, update.recentOutput);
			if (!ctx.hasUI) return;
			const statusLine = progressStatus ?? (lastProgressStatus || "running...");
			ctx.ui.setStatus("prompt-subagent", `delegating to ${request.agent} · ${statusLine}`);
		};

		const onTerminalInput = ctx.hasUI
			? ctx.ui.onTerminalInput((input) => {
				if (!matchesKey(input, Key.escape)) return undefined;
				pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, {
					requestId: request.requestId,
					reason: "escape",
				});
				finish(() => reject(new Error("Delegated prompt cancelled.")));
				return { consume: true };
			})
			: undefined;

		const unsubscribeStarted = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT, onStarted);
		const unsubscribeResponse = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT, onResponse);
		const unsubscribeUpdate = pi.events.on(PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT, onUpdate);
		let onAbort: (() => void) | undefined;

		const finish = (next: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(startTimeout);
			unsubscribeStarted();
			unsubscribeResponse();
			unsubscribeUpdate();
			onTerminalInput?.();
			clearWidget();
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			next();
		};

		onAbort = () => {
			pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT, {
				requestId: request.requestId,
				reason: "abort",
			});
			finish(() => reject(new Error("Delegated prompt cancelled.")));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		pi.events.emit(PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT, request);

		if (!started && ctx.hasUI) {
			ctx.ui.setStatus("prompt-subagent", `delegating to ${request.agent}...`);
		}
	});
}

export async function executeSubagentPromptStep(options: DelegatedPromptOptions): Promise<DelegatedPromptOutcome | undefined> {
	const { pi, prompt, args, ctx, currentModel, override, signal, inheritedModel } = options;
	const requestedAgent = resolveDelegationName(prompt, override);
	if (!requestedAgent) return undefined;

	const runtime = await ensureSubagentRuntime(ctx.cwd);
	const agent = resolveDelegatedAgent(runtime, ctx.cwd, requestedAgent);
	const preparationOptions = inheritedModel === undefined ? undefined : { inheritedModel };
	const prepared = await preparePromptExecution(
		prompt,
		args,
		currentModel,
		ctx.modelRegistry as Pick<ModelRegistry, "find" | "getAll" | "getAvailable" | "getApiKey" | "isUsingOAuth">,
		preparationOptions,
	);
	if (!prepared) {
		throw new Error(`No available model from: ${prompt.models.join(", ")}`);
	}
	if ("message" in prepared) {
		if (prepared.warning) notify(ctx, prepared.warning, "warning");
		throw new Error(prepared.message);
	}
	if (prepared.warning) notify(ctx, prepared.warning, "warning");
	const effectiveCwd = prompt.cwd ?? ctx.cwd;
	if (effectiveCwd !== ctx.cwd && !existsSync(effectiveCwd)) {
		throw new Error(`cwd directory does not exist: ${effectiveCwd}`);
	}

	const request: DelegatedSubagentRequest = {
		requestId: randomUUID(),
		agent,
		task: prepared.content,
		context: prompt.inheritContext ? "fork" : "fresh",
		model: `${prepared.selectedModel.model.provider}/${prepared.selectedModel.model.id}`,
		cwd: effectiveCwd,
	};

	if (ctx.hasUI) {
		ctx.ui.setStatus("prompt-subagent", `delegating to ${agent}`);
		ctx.ui.setWorkingMessage(`Running delegated prompt with ${agent}...`);
	}
	notify(ctx, `Delegating prompt \`${prompt.name}\` to subagent \`${agent}\``, "info");

	try {
		const response = await requestDelegatedRun(pi, ctx, request, signal);
		if (response.isError) {
			throw new Error(
				`Prompt \`${prompt.name}\` delegated subagent \`${agent}\` failed: ${response.errorText || "unknown delegated error"}`,
			);
		}

		const messages = coerceMessages(response.messages);
		const text = extractDelegatedText(messages);
		if (!text) {
			throw new Error(`Prompt \`${prompt.name}\` delegated subagent \`${agent}\` returned no assistant text.`);
		}

		pi.sendMessage({
			customType: PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE,
			content: text,
			display: true,
			details: {
				requestId: response.requestId,
				agent,
				task: request.task,
				context: response.context,
				model: response.model,
				messages,
				isError: false,
				errorText: response.errorText,
			},
		});

		return {
			changed: delegatedMessagesChanged(messages),
			text,
			agent,
		};
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(`Prompt \`${prompt.name}\` delegated subagent \`${agent}\` failed:`)) {
			throw error;
		}
		const responseText = error instanceof Error ? error.message : String(error);
		throw new Error(`Prompt \`${prompt.name}\` delegated subagent \`${agent}\` failed: ${responseText}`);
	} finally {
		clearDelegatedLiveState(request.requestId);
		if (ctx.hasUI) {
			ctx.ui.setStatus("prompt-subagent", undefined);
			ctx.ui.setWorkingMessage();
		}
	}
}

