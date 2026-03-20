import { parseCommandArgs, splitByUnquotedSeparator } from "./args.js";

export interface ChainStep {
	name: string;
	args: string[];
	loopCount?: number;
}

export interface ParsedChainSteps {
	steps: ChainStep[];
	sharedArgs: string[];
	invalidSegments: string[];
}

export interface ParsedChainDeclaration {
	steps: ChainStep[];
	invalidSegments: string[];
}

interface SegmentToken {
	start: number;
	end: number;
	value: string;
	quoted: boolean;
}

function scanSegmentTokens(segment: string): SegmentToken[] {
	const tokens: SegmentToken[] = [];
	let i = 0;

	while (i < segment.length) {
		while (i < segment.length && /\s/.test(segment[i])) i++;
		if (i >= segment.length) break;

		const start = i;
		let inQuote: string | null = null;
		let value = "";
		let sawQuoted = false;
		let sawUnquoted = false;

		while (i < segment.length) {
			const char = segment[i];
			if (inQuote) {
				if (char === inQuote) {
					inQuote = null;
				} else {
					value += char;
				}
				i++;
				continue;
			}

			if (char === '"' || char === "'") {
				inQuote = char;
				sawQuoted = true;
				i++;
				continue;
			}
			if (/\s/.test(char)) break;

			value += char;
			sawUnquoted = true;
			i++;
		}

		tokens.push({
			start,
			end: i,
			value,
			quoted: sawQuoted && !sawUnquoted,
		});
	}

	return tokens;
}

function extractStepLoopCount(segment: string): { cleanedSegment: string; loopCount?: number } {
	const tokens = scanSegmentTokens(segment);
	const loopTokenRanges: Array<{ start: number; end: number }> = [];
	let loopCount: number | undefined;

	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.quoted) continue;

		if (token.value.startsWith("--loop=")) {
			loopTokenRanges.push({ start: token.start, end: token.end });
			const value = token.value.slice("--loop=".length);
			if (!/^\d+$/.test(value)) continue;
			const parsed = parseInt(value, 10);
			if (parsed >= 1 && parsed <= 999 && loopCount === undefined) {
				loopCount = parsed;
			}
			continue;
		}

		if (token.value === "--loop" && i + 1 < tokens.length) {
			const next = tokens[i + 1];
			if (!next.quoted && /^\d+$/.test(next.value)) {
				loopTokenRanges.push({ start: token.start, end: token.end }, { start: next.start, end: next.end });
				const parsed = parseInt(next.value, 10);
				if (parsed >= 1 && parsed <= 999 && loopCount === undefined) {
					loopCount = parsed;
				}
				i++;
				continue;
			}
		}
	}

	if (loopCount === undefined || loopTokenRanges.length === 0) {
		return { cleanedSegment: segment };
	}

	loopTokenRanges.sort((a, b) => b.start - a.start);
	let cleanedSegment = segment;
	for (const { start, end } of loopTokenRanges) {
		cleanedSegment = `${cleanedSegment.slice(0, start)}${cleanedSegment.slice(end)}`;
	}

	return { cleanedSegment: cleanedSegment.trim(), loopCount };
}

export function parseChainSteps(args: string): ParsedChainSteps {
	const sharedArgsSplit = splitByUnquotedSeparator(args, " -- ");
	const templatesPart = sharedArgsSplit[0];
	const argsPart = sharedArgsSplit.length > 1 ? sharedArgsSplit.slice(1).join(" -- ") : "";

	const invalidSegments: string[] = [];
	const steps: ChainStep[] = [];

	for (const rawSegment of splitByUnquotedSeparator(templatesPart, "->")) {
		const segment = rawSegment.trim();
		if (!segment) {
			invalidSegments.push(rawSegment);
			continue;
		}
		const { cleanedSegment, loopCount } = extractStepLoopCount(segment);
		const tokens = parseCommandArgs(cleanedSegment);
		if (tokens.length === 0) {
			invalidSegments.push(segment);
			continue;
		}
		steps.push({ name: tokens[0], args: tokens.slice(1), loopCount });
	}

	return { steps, sharedArgs: parseCommandArgs(argsPart), invalidSegments };
}

export function parseChainDeclaration(chain: string): ParsedChainDeclaration {
	const invalidSegments: string[] = [];
	const steps: ChainStep[] = [];

	for (const rawSegment of splitByUnquotedSeparator(chain, "->")) {
		const segment = rawSegment.trim();
		if (!segment) {
			invalidSegments.push(rawSegment);
			continue;
		}

		const { cleanedSegment, loopCount } = extractStepLoopCount(segment);
		const tokens = parseCommandArgs(cleanedSegment);
		if (tokens.length === 0) {
			invalidSegments.push(segment);
			continue;
		}

		steps.push({
			name: tokens[0],
			args: tokens.slice(1),
			loopCount,
		});
	}

	return { steps, invalidSegments };
}
