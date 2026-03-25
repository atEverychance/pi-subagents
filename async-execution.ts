/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";
import { applyThinkingSuffix } from "./pi-args.js";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "./single-output.js";
import { isParallelStep, resolveStepBehavior, type ChainStep, type SequentialStep, type StepOverrides } from "./settings.js";
import type { RunnerStep } from "./parallel-utils.js";
import { resolvePiPackageRoot } from "./pi-spawn.js";
import { buildSkillInjection, normalizeSkillInput, resolveSkills } from "./skills.js";
import {
	type ArtifactConfig,
	type Details,
	type ExtensionConfig,
	type MaxOutputConfig,
	ASYNC_DIR,
	RESULTS_DIR,
} from "./types.js";
import {
	type CmuxHost,
	type CmuxPlacement,
	buildHostedCommand,
	chooseCmuxPlacement,
	clipTitle,
	getCmuxAsyncConfig,
	launchRunnerInCmux,
	sendCommandToCmuxHost,
} from "./cmux-async.js";

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();
const jitiCliPath: string | undefined = (() => {
	const candidates: Array<() => string> = [
		() => path.join(path.dirname(require.resolve("jiti/package.json")), "lib/jiti-cli.mjs"),
		() => path.join(path.dirname(require.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs"),
		() => {
			const piEntry = fs.realpathSync(process.argv[1]);
			const piRequire = createRequire(piEntry);
			return path.join(path.dirname(piRequire.resolve("@mariozechner/jiti/package.json")), "lib/jiti-cli.mjs");
		},
	];
	for (const candidate of candidates) {
		try {
			const p = candidate();
			if (fs.existsSync(p)) return p;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
})();

export interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
}

export interface AsyncChainParams {
	chain: ChainStep[];
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	config: ExtensionConfig;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
}

export interface AsyncSingleParams {
	agent: string;
	task: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	config: ExtensionConfig;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	skills?: string[];
	output?: string | false;
}

export interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

interface RunnerConfigPayload {
	id: string;
	steps: RunnerStep[];
	resultPath: string;
	cwd: string;
	placeholder: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	share?: boolean;
	sessionDir?: string;
	asyncDir: string;
	sessionId?: string;
	piPackageRoot?: string;
	displayLabel?: string;
	cmuxHost?: CmuxHost;
	streamToStdout?: boolean;
}

interface SpawnRunnerResult {
	pid?: number;
	cmuxHost?: CmuxHost;
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(): boolean {
	return jitiCliPath !== undefined;
}

function buildRunnerInvocation(suffix: string): { cfgPath: string; runner: string; nodeArgs: string[] } | null {
	if (!jitiCliPath) return null;
	const cfgPath = path.join(os.tmpdir(), `pi-async-cfg-${suffix}.json`);
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");
	return { cfgPath, runner, nodeArgs: [jitiCliPath, runner, cfgPath] };
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildRunnerCommand(cwd: string, nodeArgs: string[]): string {
	const argv = ["node", ...nodeArgs].map((arg) => shQuote(arg)).join(" ");
	return `cd ${shQuote(cwd)} && ${argv}`;
}

function inferPlacementHint(cfg: RunnerConfigPayload): CmuxPlacement {
	const stepCount = cfg.steps.length;
	if (stepCount > 1) return "workspace";
	const firstStep = cfg.steps[0];
	return "parallel" in firstStep ? "workspace" : "split";
}

/**
 * Spawn the async runner process
 */
function spawnRunner(cfg: RunnerConfigPayload, suffix: string, cwd: string, config: ExtensionConfig): SpawnRunnerResult {
	const invocation = buildRunnerInvocation(suffix);
	if (!invocation) return {};

	fs.writeFileSync(invocation.cfgPath, JSON.stringify(cfg));

	const cmuxConfig = getCmuxAsyncConfig(config);
	const placement = chooseCmuxPlacement(cmuxConfig, inferPlacementHint(cfg));
	if (placement) {
		const title = clipTitle(`π subagent · ${cfg.displayLabel || suffix}`, 80);
		const cmuxCommand = buildHostedCommand(
			buildRunnerCommand(cwd, invocation.nodeArgs),
			title,
			placement,
			cmuxConfig.keepShellOpen,
		);
		const host = launchRunnerInCmux({
			placement,
			title,
			bin: cmuxConfig.bin,
			splitDirection: cmuxConfig.splitDirection,
		});
		if (host) {
			const updatedCfg = { ...cfg, cmuxHost: host, streamToStdout: true };
			fs.writeFileSync(invocation.cfgPath, JSON.stringify(updatedCfg));
			if (sendCommandToCmuxHost(host, cmuxCommand, cmuxConfig.bin)) {
				return { cmuxHost: host };
			}
			fs.writeFileSync(invocation.cfgPath, JSON.stringify(cfg));
		}
	}

	const proc = spawn("node", invocation.nodeArgs, {
		cwd,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	proc.unref();
	return { pid: proc.pid };
}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		config,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
	} = params;
	const chainSkills = params.chainSkills ?? [];

	// Validate all agents exist before building steps
	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${agentName}` }],
					isError: true,
					details: { mode: "chain" as const, results: [] },
				};
			}
		}
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "chain" as const, results: [] },
		};
	}

	/** Build a resolved runner step from a SequentialStep */
	const buildSeqStep = (s: SequentialStep, sessionFile?: string) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const stepSkillInput = normalizeSkillInput(s.skill);
		const stepOverrides: StepOverrides = { skills: stepSkillInput };
		const behavior = resolveStepBehavior(a, stepOverrides, chainSkills);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills } = resolveSkills(skillNames, ctx.cwd);

		let systemPrompt = a.systemPrompt?.trim() || null;
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		// Resolve output path and inject instruction into task
		// Use step's cwd if specified, otherwise fall back to chain-level cwd
		const outputPath = resolveSingleOutputPath(s.output, ctx.cwd, s.cwd ?? cwd);
		const task = injectSingleOutputInstruction(s.task ?? "{previous}", outputPath);

		return {
			agent: s.agent,
			task,
			cwd: s.cwd,
			model: applyThinkingSuffix(s.model ?? a.model, a.thinking),
			tools: a.tools,
			extensions: a.extensions,
			mcpDirectTools: a.mcpDirectTools,
			systemPrompt,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			sessionFile,
		};
	};

	let flatStepIndex = 0;
	const nextSessionFile = (): string | undefined => {
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return sessionFile;
	};

	// Build runner steps — sequential steps become flat objects,
	// parallel steps become { parallel: [...], concurrency?, failFast? }
	const steps: RunnerStep[] = chain.map((s) => {
		if (isParallelStep(s)) {
			return {
				parallel: s.parallel.map((t) => buildSeqStep({
					agent: t.agent,
					task: t.task,
					cwd: t.cwd,
					skill: t.skill,
					model: t.model,
					output: t.output,
				}, nextSessionFile())),
				concurrency: s.concurrency,
				failFast: s.failFast,
			};
		}
		return buildSeqStep(s as SequentialStep, nextSessionFile());
	});

	// Build chain description with parallel groups shown as [agent1+agent2]
	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	const runnerCwd = cwd ?? ctx.cwd;
	const spawned = spawnRunner(
		{
			id,
			steps,
			resultPath: path.join(RESULTS_DIR, `${id}.json`),
			cwd: runnerCwd,
			placeholder: "{previous}",
			maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			share: shareEnabled,
			sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
			asyncDir,
			sessionId: ctx.currentSessionId,
			piPackageRoot,
			displayLabel: chainDesc,
		},
		id,
		runnerCwd,
		config,
	);

	if (spawned.pid || spawned.cmuxHost) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: [(firstStep as SequentialStep).agent];
		ctx.pi.events.emit("subagent:started", {
			id,
			pid: spawned.pid,
			agent: firstAgents[0],
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : (s as SequentialStep).agent,
			),
			cwd: runnerCwd,
			asyncDir,
			cmuxHost: spawned.cmuxHost,
		});
	}

	const chainMessage = spawned.cmuxHost
		? `Async chain: ${chainDesc} [${id}] via cmux ${spawned.cmuxHost.mode}`
		: `Async chain: ${chainDesc} [${id}]`;
	return {
		content: [{ type: "text", text: chainMessage }],
		details: { mode: "chain", results: [], asyncId: id, asyncDir },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		task,
		agentConfig,
		ctx,
		config,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
	} = params;
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const { resolved: resolvedSkills } = resolveSkills(skillNames, ctx.cwd);
	let systemPrompt = agentConfig.systemPrompt?.trim() || null;
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const runnerCwd = cwd ?? ctx.cwd;
	const outputPath = resolveSingleOutputPath(params.output, ctx.cwd, cwd);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
	const spawned = spawnRunner(
		{
			id,
			steps: [
				{
					agent,
					task: taskWithOutputInstruction,
					cwd,
					model: applyThinkingSuffix(agentConfig.model, agentConfig.thinking),
					tools: agentConfig.tools,
					extensions: agentConfig.extensions,
					mcpDirectTools: agentConfig.mcpDirectTools,
					systemPrompt,
					skills: resolvedSkills.map((r) => r.name),
					outputPath,
					sessionFile,
				},
			],
			resultPath: path.join(RESULTS_DIR, `${id}.json`),
			cwd: runnerCwd,
			placeholder: "{previous}",
			maxOutput,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			share: shareEnabled,
			sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
			asyncDir,
			sessionId: ctx.currentSessionId,
			piPackageRoot,
			displayLabel: `${agent}: ${task.slice(0, 40)}`,
		},
		id,
		runnerCwd,
		config,
	);

	if (spawned.pid || spawned.cmuxHost) {
		ctx.pi.events.emit("subagent:started", {
			id,
			pid: spawned.pid,
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
			cmuxHost: spawned.cmuxHost,
		});
	}

	const singleMessage = spawned.cmuxHost
		? `Async: ${agent} [${id}] via cmux ${spawned.cmuxHost.mode}`
		: `Async: ${agent} [${id}]`;
	return {
		content: [{ type: "text", text: singleMessage }],
		details: { mode: "single", results: [], asyncId: id, asyncDir },
	};
}
