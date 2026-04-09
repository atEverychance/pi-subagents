import { spawnSync } from "node:child_process";

export type CmuxAsyncHostMode = "off" | "auto" | "split" | "workspace";
export type CmuxSplitDirection = "left" | "right" | "up" | "down";
export type CmuxPlacement = "split" | "workspace";
export type CmuxHostCleanupState = "pending" | "closed" | "already_closed" | "error";

export interface CmuxHost {
	mode: CmuxPlacement;
	title: string;
	workspaceId?: string;
	workspaceRef?: string;
	surfaceRef?: string;
	originWorkspaceId?: string;
	originSurfaceId?: string;
	cleanupState?: CmuxHostCleanupState;
	cleanupAt?: number;
	cleanupError?: string;
}

export interface CmuxAsyncConfig {
	mode: CmuxAsyncHostMode;
	splitDirection: CmuxSplitDirection;
	keepShellOpen: boolean;
	bin: string;
}

export interface CmuxLaunchOptions {
	placement: CmuxPlacement;
	title: string;
	bin: string;
	splitDirection: CmuxSplitDirection;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
	if (value == null) return fallback;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function normalizeMode(value: string | undefined, fallback: CmuxAsyncHostMode): CmuxAsyncHostMode {
	switch ((value || fallback).toLowerCase()) {
		case "off":
			return "off";
		case "split":
			return "split";
		case "workspace":
			return "workspace";
		default:
			return "auto";
	}
}

function normalizeSplitDirection(value: string | undefined, fallback: CmuxSplitDirection): CmuxSplitDirection {
	switch ((value || fallback).toLowerCase()) {
		case "left":
			return "left";
		case "up":
			return "up";
		case "down":
			return "down";
		default:
			return "right";
	}
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function parseCreatedId(output: string): string | undefined {
	return output.trim().split(/\s+/).pop();
}

function parseWorkspaceRef(output: string): string | undefined {
	const match = output.match(/workspace:\d+/);
	return match?.[0];
}

function parseJson<T>(text: string): T | null {
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

type CmuxExecResult = { ok: boolean; stdout: string; stderr: string };
type CmuxExec = (bin: string, args: string[]) => CmuxExecResult;

function execCmux(bin: string, args: string[]): CmuxExecResult {
	const result = spawnSync(bin, args, { encoding: "utf-8" });
	return {
		ok: result.status === 0,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
	};
}

function cmuxMessage(result: CmuxExecResult): string {
	return `${result.stderr || ""}\n${result.stdout || ""}`.trim();
}

function isMissingCmuxTarget(text: string): boolean {
	return /not found|no such|does not exist|unknown\s+(?:surface|workspace)|invalid\s+(?:surface|workspace)/i.test(text);
}

function isUnsupportedCmuxCommand(text: string): boolean {
	return /unknown command|unknown option|invalid option|usage:/i.test(text);
}

function isInsideCmux(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.CMUX_WORKSPACE_ID || env.CMUX_SURFACE_ID || env.CMUX_SOCKET_PATH);
}

export function clipTitle(text: string, max = 80): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "π subagent";
	if (normalized.length <= max) return normalized;
	return normalized.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

export function getCmuxAsyncConfig(
	config: {
		cmuxAsyncHost?: string;
		cmuxSplitDirection?: string;
		cmuxKeepShellOpen?: boolean;
		cmuxBin?: string;
	} | undefined,
	env: NodeJS.ProcessEnv = process.env,
): CmuxAsyncConfig {
	const envMode = env.PI_SUBAGENTS_CMUX_ASYNC;
	const envSplitDirection = env.PI_SUBAGENTS_CMUX_SPLIT_DIRECTION;
	const envKeepShellOpen = env.PI_SUBAGENTS_CMUX_KEEP_SHELL_OPEN;
	const envBin = env.PI_SUBAGENTS_CMUX_BIN;
	return {
		mode: normalizeMode(envMode ?? config?.cmuxAsyncHost, "auto"),
		splitDirection: normalizeSplitDirection(envSplitDirection ?? config?.cmuxSplitDirection, "right"),
		keepShellOpen: envBool(envKeepShellOpen, config?.cmuxKeepShellOpen ?? true),
		bin: (envBin || config?.cmuxBin || "cmux").trim() || "cmux",
	};
}

export function shouldUseCmuxAsyncHost(
	config: CmuxAsyncConfig,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (config.mode === "off") return false;
	if (!isInsideCmux(env)) return false;
	const ping = execCmux(config.bin, ["ping"]);
	return ping.ok;
}

export function chooseCmuxPlacement(
	config: CmuxAsyncConfig,
	hint: CmuxPlacement,
	env: NodeJS.ProcessEnv = process.env,
): CmuxPlacement | null {
	if (!shouldUseCmuxAsyncHost(config, env)) return null;
	if (config.mode === "split") return "split";
	if (config.mode === "workspace") return "workspace";
	return hint;
}

export function buildHostedCommand(
	runnerCommand: string,
	title: string,
	placement: CmuxPlacement,
	keepShellOpen: boolean,
): string {
	const finalSuccessTitle = clipTitle(`✓ ${title}`, 90);
	const finalFailureTitle = clipTitle(`✗ ${title}`, 90);
	const renameCommand = placement === "workspace"
		? `if [ -n "${"${CMUX_WORKSPACE_ID:-}"}" ]; then cmux rename-workspace --workspace "${"${CMUX_WORKSPACE_ID}"}" ${shQuote(finalSuccessTitle)} >/dev/null 2>&1 || true; fi`
		: `if [ -n "${"${CMUX_SURFACE_ID:-}"}" ]; then cmux tab-action --action rename --surface "${"${CMUX_SURFACE_ID}"}" --title ${shQuote(finalSuccessTitle)} >/dev/null 2>&1 || true; fi`;
	const renameFailureCommand = placement === "workspace"
		? `if [ -n "${"${CMUX_WORKSPACE_ID:-}"}" ]; then cmux rename-workspace --workspace "${"${CMUX_WORKSPACE_ID}"}" ${shQuote(finalFailureTitle)} >/dev/null 2>&1 || true; fi`
		: `if [ -n "${"${CMUX_SURFACE_ID:-}"}" ]; then cmux tab-action --action rename --surface "${"${CMUX_SURFACE_ID}"}" --title ${shQuote(finalFailureTitle)} >/dev/null 2>&1 || true; fi`;

	const lines = [
		runnerCommand,
		"status=$?",
		"if [ \"$status\" -eq 0 ]; then",
		`  ${renameCommand}`,
		"else",
		`  ${renameFailureCommand}`,
		"fi",
		"printf '\n[pi-subagents] run exited with status %s\n' \"$status\"",
	];
	if (keepShellOpen) lines.push("exec $SHELL -l");
	else lines.push("exit $status");
	return `bash -lc ${shQuote(lines.join("\n"))}`;
}

export function launchRunnerInCmux(options: CmuxLaunchOptions): CmuxHost | null {
	const originWorkspaceId = process.env.CMUX_WORKSPACE_ID;
	const originSurfaceId = process.env.CMUX_SURFACE_ID;
	if (options.placement === "workspace") {
		const created = execCmux(options.bin, ["new-workspace"]);
		if (!created.ok) return null;
		const workspaceId = parseCreatedId(created.stdout);
		if (!workspaceId) return null;
		const renamed = execCmux(options.bin, ["rename-workspace", "--workspace", workspaceId, options.title]);
		return {
			mode: "workspace",
			title: options.title,
			workspaceId,
			workspaceRef: parseWorkspaceRef(renamed.stdout),
			originWorkspaceId,
			originSurfaceId,
			cleanupState: "pending",
		};
	}

	const created = execCmux(options.bin, ["--json", "new-split", options.splitDirection]);
	if (!created.ok) return null;
	const parsed = parseJson<{ workspace_ref?: string; surface_ref?: string }>(created.stdout);
	if (!parsed?.surface_ref) return null;
	execCmux(options.bin, ["tab-action", "--action", "rename", "--surface", parsed.surface_ref, "--title", options.title]);
	return {
		mode: "split",
		title: options.title,
		workspaceRef: parsed.workspace_ref,
		surfaceRef: parsed.surface_ref,
		originWorkspaceId,
		originSurfaceId,
		cleanupState: "pending",
	};
}

export function sendCommandToCmuxHost(host: CmuxHost, command: string, bin: string): boolean {
	if (host.mode === "workspace" && host.workspaceId) {
		return execCmux(bin, ["send", "--workspace", host.workspaceId, command + "\n"]).ok;
	}
	if (host.mode === "split" && host.surfaceRef) {
		return execCmux(bin, ["send", "--surface", host.surfaceRef, command + "\n"]).ok;
	}
	return false;
}

export function closeCmuxHost(
	host: CmuxHost,
	bin: string,
	exec: CmuxExec = execCmux,
): { state: Exclude<CmuxHostCleanupState, "pending">; message?: string } {
	if (host.mode === "split") {
		if (!host.surfaceRef) return { state: "already_closed", message: "Missing surface reference" };
		const closeResult = exec(bin, ["tab-action", "--action", "close", "--surface", host.surfaceRef]);
		if (closeResult.ok) return { state: "closed" };
		const closeMessage = cmuxMessage(closeResult);
		if (isMissingCmuxTarget(closeMessage)) return { state: "already_closed", message: closeMessage };
		const probe = exec(bin, ["tab-action", "--action", "rename", "--surface", host.surfaceRef, "--title", host.title]);
		const probeMessage = cmuxMessage(probe);
		if (!probe.ok && isMissingCmuxTarget(probeMessage)) {
			return { state: "already_closed", message: probeMessage };
		}
		return { state: "error", message: closeMessage || probeMessage || "Failed to close cmux surface" };
	}

	if (!host.workspaceId) return { state: "already_closed", message: "Missing workspace reference" };
	const workspaceCloseCommands: string[][] = [
		["workspace-action", "--action", "close", "--workspace", host.workspaceId],
		["close-workspace", "--workspace", host.workspaceId],
	];
	let lastMessage = "";
	for (const args of workspaceCloseCommands) {
		const result = exec(bin, args);
		if (result.ok) return { state: "closed" };
		const message = cmuxMessage(result);
		if (isMissingCmuxTarget(message)) return { state: "already_closed", message };
		if (!isUnsupportedCmuxCommand(message)) {
			lastMessage = message || lastMessage;
			break;
		}
		lastMessage = message || lastMessage;
	}

	const probe = exec(bin, ["rename-workspace", "--workspace", host.workspaceId, host.title]);
	const probeMessage = cmuxMessage(probe);
	if (!probe.ok && isMissingCmuxTarget(probeMessage)) {
		return { state: "already_closed", message: probeMessage };
	}
	return { state: "error", message: lastMessage || probeMessage || "Failed to close cmux workspace" };
}
