#!/usr/bin/env node
// Whole-desktop tools: input validation and helper wire mapping (no real input is posted).
import assert from "node:assert/strict";

const { macosHelper } = await import("../src/platform/macos/helper.ts");
const { executeDesktopInput, validateDesktopInput } = await import("../src/desktop.ts");

for (const bad of [
	{ action: "click", x: Number.NaN, y: 1 },
	{ action: "click", x: 1, y: 1, clickCount: 4 },
	{ action: "scroll", x: 1, y: 1 },
	{ action: "drag", path: [{ x: 1, y: 1 }] },
	{ action: "typeText", text: "" },
	{ action: "keypress", keys: [] },
	{ action: "bogus" },
]) assert.throws(() => validateDesktopInput(bad), undefined, JSON.stringify(bad));
for (const good of [
	{ action: "moveMouse", x: -500, y: 20 },
	{ action: "click", x: 1, y: 2, button: "right", clickCount: 2 },
	{ action: "scroll", x: 1, y: 1, scrollY: -3 },
	{ action: "drag", path: [{ x: 0, y: 0 }, { x: 5, y: 5 }] },
	{ action: "typeText", text: "hi" },
	{ action: "keypress", keys: ["cmd+space"] },
]) assert.doesNotThrow(() => validateDesktopInput(good));

const sent = [];
macosHelper.command = async (name, args) => {
	sent.push({ name, args });
	return { performed: args.action, mouse: { x: 0, y: 0 } };
};
await executeDesktopInput("1", { action: "typeText", text: "x" });
await executeDesktopInput("2", { action: "keypress", keys: ["return"] });
await executeDesktopInput("3", { action: "click", x: 3, y: 4 });
assert.deepEqual(sent.map((c) => [c.name, c.args.action]), [["desktopInput", "type"], ["desktopInput", "key"], ["desktopInput", "click"]]);
await assert.rejects(executeDesktopInput("4", { action: "click", x: Number.NaN, y: 0 }));
assert.equal(sent.length, 3, "invalid input must not reach the helper");
// Gating: disabled and headless both refuse before any helper call.
const { loadComputerUseConfig } = await import("../src/config.ts");
const before = sent.length;
process.env.PI_COMPUTER_USE_DESKTOP_CONTROL = "0";
loadComputerUseConfig(process.cwd());
await assert.rejects(executeDesktopInput("5", { action: "click", x: 1, y: 1 }), /disabled/);
delete process.env.PI_COMPUTER_USE_DESKTOP_CONTROL;
process.env.PI_COMPUTER_USE_HEADLESS = "1";
loadComputerUseConfig(process.cwd());
await assert.rejects(executeDesktopInput("6", { action: "click", x: 1, y: 1 }), /headless/);
delete process.env.PI_COMPUTER_USE_HEADLESS;
loadComputerUseConfig(process.cwd());
assert.equal(sent.length, before, "gated calls must not reach the helper");
assert.throws(() => validateDesktopInput({ action: "scroll", x: 1, y: 1, scrollY: 0.5 }), /whole-number/);

// Calls are serialized.
const { withDesktopLock } = await import("../src/desktop.ts");
const order = [];
await Promise.all([
	withDesktopLock(async () => { order.push("a1"); await new Promise((r) => setTimeout(r, 30)); order.push("a2"); }),
	withDesktopLock(async () => { order.push("b1"); order.push("b2"); }),
]);
assert.deepEqual(order, ["a1", "a2", "b1", "b2"]);

console.log("desktop tool checks passed");
