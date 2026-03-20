import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";
export const PROMPT_TEMPLATE_SUBAGENT_MESSAGE_TYPE = "prompt-template-subagent";
export const DEFAULT_SUBAGENT_NAME = "delegate";

export interface DelegatedSubagentRequest {
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
}

export interface DelegatedSubagentResponse {
	requestId: string;
	agent: string;
	task: string;
	context: "fresh" | "fork";
	model: string;
	cwd: string;
	messages: unknown[];
	isError: boolean;
	errorText?: string;
}

export interface DelegatedSubagentUpdate {
	requestId: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: string;
	toolCount?: number;
	durationMs?: number;
	tokens?: number;
}

export interface DelegatedSubagentLiveState {
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastTool?: string;
	lastToolArgs?: string;
	recentOutput: string[];
	toolCount: number;
	durationMs: number;
	tokens: number;
	startedAt: number;
	updatedAt: number;
}

interface RuntimeAgent {
	name: string;
}

interface DiscoverAgentsResult {
	agents: RuntimeAgent[];
}

type DiscoverAgentsFn = (cwd: string, scope: "user" | "project" | "both") => DiscoverAgentsResult;

export interface SubagentRuntime {
	root: string;
	discoverAgents: DiscoverAgentsFn;
}

let runtimeCache: SubagentRuntime | null = null;
const delegatedLiveState = new Map<string, DelegatedSubagentLiveState>();

function runtimeCandidates(cwd: string): string[] {
	const fromEnv = process.env.PI_SUBAGENT_RUNTIME_ROOT?.trim();
	if (fromEnv) return [resolve(fromEnv)];
	const localSibling = resolve(dirname(fileURLToPath(import.meta.url)), "..", "subagent");
	return [
		resolve(cwd, ".pi", "agent", "extensions", "subagent"),
		join(homedir(), ".pi", "agent", "extensions", "subagent"),
		localSibling,
	];
}

function findSubagentRoot(cwd: string): string | undefined {
	for (const candidate of runtimeCandidates(cwd)) {
		if (existsSync(join(candidate, "agents.ts")) || existsSync(join(candidate, "agents.js"))) {
			return candidate;
		}
	}
	return undefined;
}

async function importRuntimeModule(root: string, baseName: string): Promise<unknown> {
	const candidates = [
		join(root, `${baseName}.ts`),
		join(root, `${baseName}.mts`),
		join(root, `${baseName}.js`),
		join(root, `${baseName}.mjs`),
	];

	let lastError: unknown;
	for (const filePath of candidates) {
		if (!existsSync(filePath)) continue;
		try {
			return await import(pathToFileURL(filePath).href);
		} catch (error) {
			lastError = error;
		}
	}

	if (lastError !== undefined) {
		throw lastError;
	}
	throw new Error(`Missing runtime module: ${baseName}`);
}

export function updateDelegatedLiveState(requestId: string, update: Partial<DelegatedSubagentLiveState>): void {
	const now = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? {
		recentOutput: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		startedAt: now,
		updatedAt: now,
	};
	// When a tool finishes (currentTool goes undefined), preserve it as lastTool
	const toolJustCleared = update.currentTool === undefined && existing.currentTool !== undefined;
	const lastTool = toolJustCleared ? existing.currentTool : (update.currentTool ?? existing.lastTool);
	const lastToolArgs = toolJustCleared ? existing.currentToolArgs : (update.currentToolArgs ?? existing.lastToolArgs);

	const next: DelegatedSubagentLiveState = {
		...existing,
		...update,
		recentOutput: update.recentOutput ?? existing.recentOutput,
		toolCount: update.toolCount ?? existing.toolCount,
		durationMs: update.durationMs ?? (now - existing.startedAt),
		tokens: update.tokens ?? existing.tokens,
		lastTool,
		lastToolArgs,
		startedAt: existing.startedAt,
		updatedAt: now,
	};
	delegatedLiveState.set(requestId, next);
}

export function appendDelegatedLiveOutput(requestId: string, line?: string): void {
	if (!line || !line.trim() || line.trim() === "(running...)") return;
	const fallbackNow = Date.now();
	const existing = delegatedLiveState.get(requestId) ?? {
		recentOutput: [],
		toolCount: 0,
		durationMs: 0,
		tokens: 0,
		startedAt: fallbackNow,
		updatedAt: fallbackNow,
	};
	const recentOutput = [...existing.recentOutput, line].slice(-12);
	delegatedLiveState.set(requestId, {
		...existing,
		recentOutput,
		updatedAt: Date.now(),
	});
}

export function getDelegatedLiveState(requestId: string): DelegatedSubagentLiveState | undefined {
	return delegatedLiveState.get(requestId);
}

export function clearDelegatedLiveState(requestId: string): void {
	delegatedLiveState.delete(requestId);
}

export async function ensureSubagentRuntime(cwd: string): Promise<SubagentRuntime> {
	const root = findSubagentRoot(cwd);
	if (!root) {
		throw new Error(
			"Delegated prompt execution requires the subagent extension runtime at ~/.pi/agent/extensions/subagent.",
		);
	}

	if (runtimeCache && runtimeCache.root === root) {
		return runtimeCache;
	}

	const module = await importRuntimeModule(root, "agents");
	const discoverAgents = (module as { discoverAgents?: unknown }).discoverAgents;
	if (typeof discoverAgents !== "function") {
		throw new Error(`Invalid subagent runtime at ${root}: expected discoverAgents(cwd, scope).`);
	}

	runtimeCache = {
		root,
		discoverAgents: discoverAgents as DiscoverAgentsFn,
	};
	return runtimeCache;
}

export function resolveDelegatedAgent(runtime: SubagentRuntime, cwd: string, requested: string): string {
	const discovered = runtime.discoverAgents(cwd, "both");
	if (!discovered.agents.some((agent) => agent.name === requested)) {
		throw new Error(
			`Delegated subagent \`${requested}\` not found. Available agents: ${discovered.agents.map((a) => a.name).join(", ") || "none"}.`,
		);
	}
	return requested;
}
