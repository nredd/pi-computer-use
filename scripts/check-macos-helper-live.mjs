#!/usr/bin/env node
// Opt-in live check of the Swift helper glue against a real modal NSAlert.
// Run: PI_COMPUTER_USE_LIVE=1 npm run test:macos-live   (needs Accessibility; sends no input events, but it
// RESTARTS the shared helper daemon, which invalidates native refs of any other running pi session)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (process.platform !== "darwin" || process.env.PI_COMPUTER_USE_LIVE !== "1") {
	console.log("macos live helper checks skipped (set PI_COMPUTER_USE_LIVE=1 on macOS)");
	process.exit(0);
}
const { macosBackend } = await import("../src/platform/macos/backend.ts");
const { macosHelper } = await import("../src/platform/macos/helper.ts");

const dir = mkdtempSync(path.join(tmpdir(), "pcu-alert-"));
const bin = path.join(dir, "alertapp");
execFileSync("swiftc", ["-o", bin, new URL("./fixtures/alert-app.swift", import.meta.url).pathname], { stdio: "inherit" });
const child = spawn(bin, [], { stdio: "ignore" });
try {
	let roots = [];
	for (let i = 0; i < 30 && roots.length === 0; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		roots = await macosBackend.listRoots({ pid: child.pid });
	}
	assert.equal(roots.length, 1, "alert root not found");
	const ref = roots[0].rootRef;
	const refOnly = { pid: child.pid, rootRef: ref, windowRef: ref };

	// Visual look of a ref-only (unpaired-by-request) root: clear error, no other window captured.
	await assert.rejects(macosBackend.observe({ target: refOnly, readText: "never", includeImage: true }), (error) => error.code === "root_not_capturable");
	// Semantic look works from the ref alone and records windowId 0.
	let look = await macosBackend.observe({ target: refOnly, readText: "never", includeImage: false });
	assert.equal(look.window.windowId, 0);

	// A stale/bogus ref must fail, never fall back to the app's first window.
	await assert.rejects(macosBackend.observe({ target: { pid: child.pid, windowRef: "w-bogus" }, readText: "never", includeImage: false }), (error) => error.code === "root_not_found");
	// Commands that already know the pid reach windowElement: a bogus ref must not resolve to the first window.
	const bogusWait = await macosHelper.command("axWaitFor", { pid: child.pid, windowRef: "w-bogus", text: "Cancel", gone: false, timeoutMs: 200 });
	assert.equal(bogusWait.found, false);
	assert.equal(bogusWait.reason, "window_not_found");
	const realWait = await macosHelper.command("axWaitFor", { pid: child.pid, windowRef: ref, text: "Cancel", gone: false, timeoutMs: 1000 });
	assert.equal(realWait.found, true, "the real ref must resolve");

	// Refs carry a per-process epoch (w<epoch>-<n>), so a restarted helper cannot reuse an old ref.
	assert.match(ref, /^w[0-9a-f]+-\d+$/, `unexpected native ref shape: ${ref}`);
	await macosHelper.restart();
	const afterRestart = await macosHelper.command("axWaitFor", { pid: child.pid, windowRef: ref, text: "Cancel", gone: false, timeoutMs: 200 });
	assert.equal(afterRestart.found, false, "a ref from before a helper restart must not resolve");
	const fresh = (await macosBackend.listRoots({ pid: child.pid }))[0].rootRef;
	assert.notEqual(fresh, ref, "restarted helper must issue a different ref for the same window");
	// The look above came from the old helper; take a new one for the act below.
	look = await macosBackend.observe({ target: { pid: child.pid, rootRef: fresh, windowRef: fresh }, readText: "never", includeImage: false });

	// No id and no ref: nothing identifies the root, so look must refuse rather than pick a window.
	await assert.rejects(macosBackend.observe({ target: { pid: child.pid }, readText: "never", includeImage: false }), (error) => error.code === "root_not_found");

	// Swift argument parsing for desktop commands rejects bad input without posting events.
	for (const args of [{ action: "click" }, { action: "drag", path: [{ x: 1, y: 1 }] }, { action: "key", keys: [] }, { action: "nope" }]) {
		await assert.rejects(macosHelper.command("desktopInput", args), (error) => error.code === "invalid_args", JSON.stringify(args));
	}
	await assert.rejects(macosHelper.command("captureDisplay", { display: 99 }), (error) => error.code === "display_not_found");

	// act by ref on an unpaired look: dismiss the dialog with Cancel.
	const flat = [];
	(function walk(node) { flat.push(node); (node.children ?? []).forEach(walk); })(look.parsedOutline.root);
	const cancel = flat.find((node) => node.role === "AXButton" && /cancel/i.test(node.title ?? node.label ?? ""));
	assert.ok(cancel?.wireRef, "Cancel button not found");
	const result = await macosBackend.act({ lookId: look.lookId, pid: child.pid, target: { ref: cancel.wireRef }, action: "press", params: {}, policy: "ax_only" });
	assert.equal(result.outcome, "worked");
	console.log("macos live helper checks passed");
} finally {
	child.kill();
	rmSync(dir, { recursive: true, force: true });
}
