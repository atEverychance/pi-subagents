/**
 * Subagent completion notifications (extension)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.js";

interface ChainStepResult {
	agent: string;
	output: string;
	success: boolean;
}

interface SubagentResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	cancelled?: boolean;
	executionMode?: "sync" | "async";
	summary: string;
	exitCode: number;
	timestamp: number;
	sessionFile?: string;
	receiptPath?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	results?: ChainStepResult[];
	taskIndex?: number;
	totalTasks?: number;
}

export default function registerSubagentNotify(pi: ExtensionAPI): void {
	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		if (result.executionMode === "sync") {
			// Foreground/sync runs already surface completion through the active tool result.
			// Triggering a second turn here can abort the parent handoff before it sends
			// its final summary back to the user.
			return;
		}
		const now = Date.now();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const agent = result.agent ?? "unknown";
		const status = result.cancelled ? "cancelled" : result.success ? "completed" : "failed";
		const subject = result.executionMode === "sync" ? "Delegation" : "Background task";

		const taskInfo =
			result.taskIndex !== undefined && result.totalTasks !== undefined
				? ` (${result.taskIndex + 1}/${result.totalTasks})`
				: "";

		const extra: string[] = [];
		if (result.shareUrl) {
			extra.push(`Session: ${result.shareUrl}`);
		} else if (result.shareError) {
			extra.push(`Session share error: ${result.shareError}`);
		} else if (result.sessionFile) {
			extra.push(`Session file: ${result.sessionFile}`);
		}
		if (result.receiptPath) {
			extra.push(`Receipt: ${result.receiptPath}`);
		}

		const content = [
			`${subject} ${status}: **${agent}**${taskInfo}`,
			"",
			result.summary,
			extra.length ? "" : undefined,
			extra.length ? extra.join("\n") : undefined,
		]
			.filter((line) => line !== undefined)
			.join("\n");

		pi.sendMessage(
			{
				customType: "subagent-notify",
				content,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.events.on("subagent:complete", handleComplete);
}
