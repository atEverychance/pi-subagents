import { describe, it } from "node:test";
import assert from "node:assert/strict";
import registerSubagentNotify from "../notify.ts";

class FakeEvents {
	private handlers = new Map<string, Array<(payload: unknown) => void>>();

	on(event: string, handler: (payload: unknown) => void): void {
		const existing = this.handlers.get(event) ?? [];
		existing.push(handler);
		this.handlers.set(event, existing);
	}

	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(payload);
		}
	}
}

describe("subagent notifications", () => {
	it("does not trigger a second turn for sync completions", () => {
		const events = new FakeEvents();
		const sent: Array<{ message: unknown; options: unknown }> = [];
		registerSubagentNotify({
			events,
			sendMessage: (message: unknown, options: unknown) => {
				sent.push({ message, options });
			},
		} as any);

		events.emit("subagent:complete", {
			id: "sync-123",
			agent: "writer",
			success: true,
			executionMode: "sync",
			summary: "Updated README.md",
			exitCode: 0,
			timestamp: Date.now(),
			receiptPath: "/tmp/receipt.json",
		});

		assert.equal(sent.length, 0);
	});

	it("still notifies for async completions", () => {
		const events = new FakeEvents();
		const sent: Array<{ message: any; options: any }> = [];
		registerSubagentNotify({
			events,
			sendMessage: (message: unknown, options: unknown) => {
				sent.push({ message, options });
			},
		} as any);

		events.emit("subagent:complete", {
			id: "async-123",
			agent: "writer",
			success: true,
			executionMode: "async",
			summary: "Updated README.md",
			exitCode: 0,
			timestamp: Date.now(),
			receiptPath: "/tmp/receipt.json",
		});

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message?.customType, "subagent-notify");
		assert.equal(sent[0]?.options?.triggerTurn, true);
		assert.match(sent[0]?.message?.content ?? "", /Background task completed: \*\*writer\*\*/);
	});
});
