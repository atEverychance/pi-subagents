import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHostedCommand, clipTitle, getCmuxAsyncConfig } from "./cmux-async.ts";

describe("clipTitle", () => {
	it("truncates long titles safely", () => {
		const clipped = clipTitle("π subagent " + "x".repeat(200), 20);
		assert.equal(clipped.endsWith("…"), true);
		assert.equal(clipped.length <= 20, true);
	});
});

describe("getCmuxAsyncConfig", () => {
	it("prefers env overrides over config", () => {
		const cfg = getCmuxAsyncConfig(
			{ cmuxAsyncHost: "off", cmuxSplitDirection: "left", cmuxKeepShellOpen: false, cmuxBin: "cmux-a" },
			{
				PI_SUBAGENTS_CMUX_ASYNC: "workspace",
				PI_SUBAGENTS_CMUX_SPLIT_DIRECTION: "down",
				PI_SUBAGENTS_CMUX_KEEP_SHELL_OPEN: "1",
				PI_SUBAGENTS_CMUX_BIN: "cmux-b",
			} as NodeJS.ProcessEnv,
		);
		assert.equal(cfg.mode, "workspace");
		assert.equal(cfg.splitDirection, "down");
		assert.equal(cfg.keepShellOpen, true);
		assert.equal(cfg.bin, "cmux-b");
	});
});

describe("buildHostedCommand", () => {
	it("wraps a runner command and keeps shell open when requested", () => {
		const command = buildHostedCommand("node /tmp/runner.js", "π subagent · scout", "split", true);
		assert.match(command, /bash -lc/);
		assert.match(command, /tab-action --action rename/);
		assert.match(command, /exec \$SHELL -l/);
	});
});
