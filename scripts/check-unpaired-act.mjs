#!/usr/bin/env node
// act_ui on an unpaired root (no windowId) must succeed with a semantic successor, never root_not_capturable.
import assert from "node:assert/strict";

const { currentPlatformBackend } = await import("../src/platform/index.ts");
const { executeFind, executeObserve, executeAct } = await import("../src/bridge.ts");
const { parseLookResponse } = await import("../src/outline.ts");

const root = {
	kind: "dialog", rootRef: "ax:dlg", windowRef: "ax:dlg", pid: 7, appName: "App", title: "Unpaired", zOrder: 0,
	framePoints: { x: 0, y: 0, w: 300, h: 200 }, scaleFactor: 1, isOnscreen: true, isFocused: true, isMinimized: false, isMain: false, isModal: true,
};
const observeCalls = [];
const lookPayload = (n) => ({
	lookId: `look${n}`, capturedAt: 1,
	window: { windowId: 0, rootRef: "ax:dlg", kind: "dialog", framePoints: root.framePoints, scaleFactor: 1, isModal: true, role: "AXWindow", subrole: "AXDialog", metadata: { pairing: { confidence: "low", score: 0 }, sheetCount: 0 } },
	outline: { ref: "w", wireRef: "w", role: "AXWindow", subrole: "AXDialog", title: "Unpaired", label: "", value: "", actions: [], rect: { x: 0, y: 0, w: 300, h: 200 }, children: [{ ref: "b", wireRef: "b", role: "AXButton", subrole: "", title: "Go", label: "Go", value: "", actions: ["AXPress"], rect: { x: 10, y: 10, w: 50, h: 20 }, children: [] }] },
	timings: { captureMs: 0, describeMs: 0, readTextMs: 0 },
});
Object.assign(currentPlatformBackend, {
	ensureReady: async () => ({ permissionStatus: { accessibility: true, screenRecording: true }, lastPermissionCheckAt: Date.now() }),
	listApps: async () => [{ appName: "App", pid: 7, isFrontmost: true }],
	listRoots: async () => [root],
	getFrontmost: async () => ({ appName: "App", pid: 7 }),
	observe: async (request) => {
		observeCalls.push(request);
		if (request.includeImage !== false && !request.target.windowId) throw Object.assign(new Error("Root has no capturable window"), { code: "root_not_capturable" });
		return parseLookResponse(lookPayload(observeCalls.length));
	},
	act: async () => ({ outcome: "worked", performed: { delivery: "pid" } }),
	actBatch: async () => ({ outcome: "worked", performed: { delivery: "pid", transaction: true, actionCount: 1 }, steps: [{ outcome: "worked" }] }),
});

const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
const call = (fn, params) => fn("t", params, undefined, undefined, ctx);
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

await call(executeFind, { app: "App" });
const observed = await call(executeObserve, { root: "@r1", mode: "semantic" });
const stateId = text(observed).match(/stateId ([0-9a-f-]{36})/)[1];
observeCalls.length = 0;
const result = await call(executeAct, { stateId, actions: [{ action: "press", ref: text(observed).match(/(@e\d+) AXButton/)[1] }] });
assert.notEqual(result.details?.status, "post_action_observation_failed", text(result));
assert.match(text(result), /Executed 1 checked UI action/);
const successor = observeCalls.at(-1);
assert.equal(successor.includeImage, false, "unpaired successor must be semantic");
assert.equal(successor.target.windowId, undefined, "windowId 0 must not be sent");
assert.equal(successor.target.windowRef, "ax:dlg");
// Root delta refs: the ref shown for a new dialog must be the one find_roots issues for it, even when the
// dialog has a real windowId (helper deltas carry helper-native refs, a different namespace).
const dialog2 = { ...root, rootRef: "ax:dlg2", windowRef: "ax:dlg2", windowId: 99, title: "Confirm", framePoints: { x: 50, y: 50, w: 200, h: 100 } };
const mainWindow = { ...root, kind: "window", rootRef: "ax:main", windowRef: "ax:main", windowId: 5, title: "Main", isModal: false, isMain: true, isFocused: false };
currentPlatformBackend.listRoots = async () => [mainWindow, dialog2, root];
const appeared = [{ change: "appeared", kind: "dialog", ref: "ax:dlg2", title: "Confirm", pid: 7, isModal: true }];
currentPlatformBackend.act = async () => ({ outcome: "worked", performed: { delivery: "pid" }, rootDelta: appeared });
currentPlatformBackend.actBatch = async () => ({
	outcome: "worked",
	performed: { delivery: "pid", transaction: true, actionCount: 1 },
	steps: [{ outcome: "worked", rootDelta: appeared }],
	rootDelta: appeared,
});
const second = await call(executeObserve, { root: "@r1", mode: "semantic" });
const second_state = text(second).match(/stateId ([0-9a-f-]{36})/)[1];
const acted = await call(executeAct, { stateId: second_state, actions: [{ action: "press", ref: text(second).match(/(@e\d+) AXButton/)[1] }] });
const deltaRef = text(acted).match(/New root: dialog "Confirm"[^\n]*\((@r\d+)\)/)?.[1];
assert.ok(deltaRef, `delta line missing an @r ref:\n${text(acted)}`);
const refreshed = await call(executeFind, { app: "App" });
const findRef = text(refreshed).match(/(@r\d+) dialog App[^\n]*Confirm/)?.[1];
assert.equal(deltaRef, findRef, "delta ref and find_roots ref must name the same root with one @r ref");
assert.doesNotMatch(text(acted), /Unknown App/);

console.log("unpaired act checks passed");
