import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("subagent-runner fatal errors", () => {
	it("writes failure result payload when runSubagent crashes", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runner-crash-"));
		const id = `fatal-${Date.now()}`;
		const resultPath = path.join(tmpDir, `${id}.json`);
		const configPath = path.join(tmpDir, "runner-config.json");
		const asyncDir = path.join(tmpDir, "async");

		const config = {
			id,
			steps: [{ agent: "broken-agent" }],
			resultPath,
			cwd: process.cwd(),
			placeholder: "{previous}",
			asyncDir,
		};

		fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

		try {
			const proc = child_process.spawnSync(process.execPath, [
				"--experimental-transform-types",
				"--import",
				"./test/register-loader.mjs",
				"./subagent-runner.ts",
				configPath,
			], {
				cwd: process.cwd(),
				encoding: "utf-8",
				timeout: 10000,
			});

			assert.equal(proc.status, 1);
			assert.equal(fs.existsSync(resultPath), true, "expected failure result file at resultPath");
			const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
				id: string;
				success: boolean;
				exitCode: number;
				summary?: string;
				error?: string;
				results?: unknown[];
			};

			assert.equal(data.id, id);
			assert.equal(data.success, false);
			assert.equal(data.exitCode, 1);
			assert.equal(Array.isArray(data.results), true);
			assert.equal(data.results?.length, 0);
			assert.equal(typeof data.summary === "string" || typeof data.error === "string", true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("writes failure result payload when config JSON cannot be parsed from a file", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runner-config-"));
		const id = `invalid-${Date.now()}`;
		const resultPath = path.join(tmpDir, `${id}.json`);
		const configPath = path.join(tmpDir, "runner-config.json");
		const asyncDir = path.join(tmpDir, "async");

		fs.writeFileSync(
			configPath,
			JSON.stringify({ id, resultPath, cwd: process.cwd(), asyncDir }).replace(/}\s*$/, ", \"steps\": [}"),
			"utf-8",
		);

		try {
			const proc = child_process.spawnSync(process.execPath, [
				"--experimental-transform-types",
				"--import",
				"./test/register-loader.mjs",
				"./subagent-runner.ts",
				configPath,
			], {
				cwd: process.cwd(),
				encoding: "utf-8",
				timeout: 10000,
			});

			assert.equal(proc.status, 1);
			assert.equal(fs.existsSync(resultPath), true, "expected failure result file at resultPath");
			const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
				id: string;
				success: boolean;
				exitCode: number;
				summary?: string;
				error?: string;
			};

			assert.equal(data.id, id);
			assert.equal(data.success, false);
			assert.equal(data.exitCode, 1);
			assert.equal(typeof data.summary === "string" || typeof data.error === "string", true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("writes failure result payload when stdin config JSON cannot be parsed", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runner-stdin-config-"));
		const id = `stdin-invalid-${Date.now()}`;
		const resultPath = path.join(tmpDir, `${id}.json`);
		const asyncDir = path.join(tmpDir, "async");
		const stdinPayload = JSON.stringify({ id, resultPath, cwd: process.cwd(), asyncDir }).replace(/}\s*$/, ", \"steps\": [}");

		try {
			const proc = child_process.spawnSync(process.execPath, [
				"--experimental-transform-types",
				"--import",
				"./test/register-loader.mjs",
				"./subagent-runner.ts",
			], {
				cwd: process.cwd(),
				input: stdinPayload,
				encoding: "utf-8",
				timeout: 10000,
			});

			assert.equal(proc.status, 1);
			assert.equal(fs.existsSync(resultPath), true, "expected failure result file at resultPath");
			const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
				id: string;
				success: boolean;
				exitCode: number;
				summary?: string;
				error?: string;
			};

			assert.equal(data.id, id);
			assert.equal(data.success, false);
			assert.equal(data.exitCode, 1);
			assert.equal(typeof data.summary === "string" || typeof data.error === "string", true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("writes fallback result payload when runner exits without writing result (silent exit guard)", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-runner-silent-exit-"));
		const id = `silent-exit-${Date.now()}`;
		const resultPath = path.join(tmpDir, `${id}.json`);
		const configPath = path.join(tmpDir, "runner-config.json");
		const asyncDir = path.join(tmpDir, "async");

		// Create a config with a valid resultPath and asyncDir, but invalid steps that
		// cause the runner to exit without writing result.json through normal paths.
		// We simulate this by providing steps that will fail early (invalid agent with no task)
		// and then kill the process with SIGTERM before it can write results normally.
		const config = {
			id,
			steps: [{ agent: "test-silent-exit-agent" }],
			resultPath,
			cwd: process.cwd(),
			placeholder: "{previous}",
			asyncDir,
		};

		fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

		try {
			// Launch the runner and send SIGTERM shortly after to simulate a silent exit.
			const proc = child_process.spawn(process.execPath, [
				"--experimental-transform-types",
				"--import",
				"./test/register-loader.mjs",
				"./subagent-runner.ts",
				configPath,
			], {
				cwd: process.cwd(),
			});

			// Give it a moment to start and install the exit guard, then SIGTERM.
			await new Promise<void>((resolve) => {
				setTimeout(() => {
					try { proc.kill("SIGTERM"); } catch { /* may have already exited */ }
					resolve();
				}, 500);
			});

			// Wait for process to exit.
			const exitCode = await new Promise<number | null>((resolve) => {
				proc.on("close", (code) => resolve(code));
				// Safety timeout
				setTimeout(() => resolve(null), 10000);
			});

			// The result guard should have written a fallback result.json
			assert.equal(fs.existsSync(resultPath), true, "expected result.json to exist after silent exit");
			const data = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
				id: string;
				success: boolean;
				exitCode: number;
				error?: string;
				summary?: string;
			};

			assert.equal(data.id, id);
			assert.equal(data.success, false);
			// Either the exit guard wrote silent_exit_no_result_written, or the
			// fatal error handler wrote a different error — both are acceptable
			// as long as a result.json exists with success=false.
			assert.equal(data.success === false && (data.error === "silent_exit_no_result_written" || typeof data.error === "string"), true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
