interface BuildCompactSyncCloseoutParams {
	agent: string;
	success: boolean;
	cancelled?: boolean;
	outputText?: string;
	errorText?: string;
	sessionFile?: string;
	receiptPath?: string;
}

function firstMeaningfulLine(text: string): string {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		return line;
	}
	return "";
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function buildCompactSyncCloseout(params: BuildCompactSyncCloseoutParams): string {
	const status = params.cancelled ? "cancelled" : params.success ? "completed" : "failed";
	const headline = `Subagent ${params.agent} ${status}.`;
	const previewSource = params.errorText?.trim() || params.outputText?.trim() || "";
	const previewLine = clip(firstMeaningfulLine(previewSource), 220);
	const lines = [headline];
	if (previewLine) lines.push(`Preview: ${previewLine}`);
	if (params.sessionFile) lines.push(`Session: ${params.sessionFile}`);
	if (params.receiptPath) lines.push(`Receipt: ${params.receiptPath}`);
	lines.push("Foreground sync handoffs are intentionally compact for reliability; inspect the child session or receipt for the full output.");
	return lines.join("\n");
}
