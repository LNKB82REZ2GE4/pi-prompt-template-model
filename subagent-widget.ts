import type { Theme } from "@mariozechner/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { getDelegatedLiveState, type DelegatedSubagentLiveState } from "./subagent-runtime.js";

export const DELEGATED_WIDGET_KEY = "prompt-subagent-progress";

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return `${minutes}m${remaining}s`;
}

function formatTokens(n: number | undefined): string {
	if (!n) return "0";
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function createDelegatedProgressWidget(
	requestId: string,
	agent: string,
	context: "fresh" | "fork",
	task: string,
	theme: Theme,
): Container & { dispose?(): void } {
	const contextSuffix = context === "fork" ? theme.fg("warning", " [fork]") : "";
	const taskPreview = task.length > 120 ? `${task.slice(0, 120)}...` : task;

	const container = new Container();
	container.addChild(new Spacer(1));
	const box = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
	container.addChild(box);

	let lastKey = "";

	container.render = (width: number): string[] => {
		const state = getDelegatedLiveState(requestId);
		const elapsed = state ? Date.now() - state.startedAt : 0;
		const key = stateKey(state, elapsed);
		if (key !== lastKey) {
			lastKey = key;
			rebuildBox(box, agent, contextSuffix, taskPreview, state, elapsed, theme);
		}
		return Container.prototype.render.call(container, width);
	};

	return container;
}

function stateKey(state: DelegatedSubagentLiveState | undefined, elapsed: number): string {
	if (!state) return "none";
	const elapsedBucket = Math.floor(elapsed / 1000);
	const tool = state.currentTool ?? state.lastTool ?? "";
	return `${state.status}|${tool}|${state.toolCount}|${state.tokens}|${state.recentOutput.length}|${elapsedBucket}`;
}

function rebuildBox(
	box: Box,
	agent: string,
	contextSuffix: string,
	taskPreview: string,
	state: DelegatedSubagentLiveState | undefined,
	elapsed: number,
	theme: Theme,
): void {
	box.clear();

	const toolCount = state?.toolCount ?? 0;
	const tokens = formatTokens(state?.tokens);
	const duration = formatDuration(elapsed);
	const isThinking = toolCount === 0 && (state?.tokens ?? 0) === 0;
	const icon = theme.fg("warning", "...");
	const stats = isThinking
		? `thinking, ${duration}`
		: `${toolCount} tool${toolCount === 1 ? "" : "s"}, ${tokens} tok, ${duration}`;

	box.addChild(new Text(
		`${icon} ${theme.fg("toolTitle", theme.bold(agent))}${contextSuffix} | ${stats}`,
		0, 0,
	));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("dim", `Task: ${taskPreview}`), 0, 0));

	const activeTool = state?.currentTool;
	const displayTool = activeTool ?? state?.lastTool;
	if (displayTool) {
		const toolArgs = activeTool ? state?.currentToolArgs : state?.lastToolArgs;
		const toolLine = `${displayTool}${toolArgs ? ` ${toolArgs}` : ""}`;
		box.addChild(new Text(theme.fg("dim", toolLine), 0, 0));
	}

	if (state && state.recentOutput.length > 0) {
		for (const line of state.recentOutput.slice(-4)) {
			box.addChild(new Text(theme.fg("dim", `  ${line}`), 0, 0));
		}
	}
}
