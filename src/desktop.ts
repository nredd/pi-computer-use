import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getComputerUseConfig } from "./config.ts";
import { macosHelper } from "./platform/macos/helper.ts";

/** Global-desktop tools: whole-screen capture and physical input in global point coordinates (macOS). */

export interface DesktopCaptureParams {
	display?: number;
	maxDimension?: number;
}

export type DesktopInputParams =
	| { action: "moveMouse"; x: number; y: number }
	| { action: "click"; x: number; y: number; button?: "left" | "right" | "middle"; clickCount?: number }
	| { action: "scroll"; x: number; y: number; scrollX?: number; scrollY?: number }
	| { action: "drag"; path: Array<{ x: number; y: number }> }
	| { action: "typeText"; text: string }
	| { action: "keypress"; keys: string[] }
	| { action: "activateApp"; app: string }
	| { action: "readClipboard" }
	| { action: "writeClipboard"; text: string };

interface DisplayInfo {
	index: number;
	isMain: boolean;
	frame: { x: number; y: number; w: number; h: number };
}

function assertDesktopControlAllowed(): void {
	if (process.platform !== "darwin") throw new Error("Desktop control is only implemented on macOS.");
	const config = getComputerUseConfig();
	if (config.headless) throw new Error("Desktop control is unavailable while headless is enabled (it moves the real cursor and keyboard).");
	if (!config.desktop_control) throw new Error("Desktop control is disabled (desktop_control: false / PI_COMPUTER_USE_DESKTOP_CONTROL=0).");
}

let desktopQueue: Promise<unknown> = Promise.resolve();

/** Desktop tools share one physical keyboard and pointer: run whole calls one at a time, in arrival order. */
export function withDesktopLock<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	const guarded = async () => {
		// A call aborted while it waited its turn must not run afterwards.
		if (signal?.aborted) throw new Error("Operation aborted.");
		return await work();
	};
	const run = desktopQueue.then(guarded, guarded);
	desktopQueue = run.catch(() => undefined);
	return run;
}

/** Validate before touching the helper so bad input never reaches physical devices. */
export function validateDesktopInput(params: DesktopInputParams): void {
	const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
	switch (params.action) {
		case "moveMouse":
		case "click":
		case "scroll":
			if (!finite(params.x) || !finite(params.y)) throw new Error(`${params.action} requires finite x and y.`);
			if (params.action === "click" && params.clickCount !== undefined && (!Number.isInteger(params.clickCount) || params.clickCount < 1 || params.clickCount > 3)) {
				throw new Error("clickCount must be an integer from 1 to 3.");
			}
			if (params.action === "scroll" && !(Math.trunc(params.scrollX ?? 0) || Math.trunc(params.scrollY ?? 0))) throw new Error("scroll requires a whole-number scrollX or scrollY of at least 1 in magnitude.");
			return;
		case "drag":
			if (!Array.isArray(params.path) || params.path.length < 2 || params.path.some((p) => !finite(p?.x) || !finite(p?.y))) {
				throw new Error("drag requires a path of at least two finite points.");
			}
			return;
		case "typeText":
		case "writeClipboard":
			if (typeof params.text !== "string" || params.text.length === 0) throw new Error(`${params.action} requires non-empty text.`);
			return;
		case "activateApp":
			if (typeof params.app !== "string" || params.app.trim().length === 0) throw new Error("activateApp requires app (a name or bundle id).");
			return;
		case "readClipboard":
			return;
		case "keypress":
			if (!Array.isArray(params.keys) || params.keys.length === 0) throw new Error("keypress requires keys.");
			return;
		default:
			throw new Error(`Unknown desktop action '${(params as { action?: string }).action}'.`);
	}
}

export async function executeDesktopScreenshot(
	_id: string,
	params: DesktopCaptureParams,
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	_ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	assertDesktopControlAllowed();
	const result = await withDesktopLock(() => macosHelper.command<{ displays: DisplayInfo[]; display: number; frame: DisplayInfo["frame"]; image: { jpegBase64: string; width: number; height: number } }>(
		"captureDisplay",
		{ display: params.display ?? 0, maxDimension: params.maxDimension ?? 1600 },
		{ signal, timeoutMs: 15_000 },
	), signal);
	const f = result.frame;
	const layout = result.displays.map((d) => `display ${d.index}${d.isMain ? " (main)" : ""}: origin ${Math.round(d.frame.x)},${Math.round(d.frame.y)} size ${Math.round(d.frame.w)}x${Math.round(d.frame.h)}`).join("\n");
	const scale = result.image.width / f.w;
	return {
		content: [
			{
				type: "text",
				text: `Display ${result.display}, image ${result.image.width}x${result.image.height} for global frame ${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}x${Math.round(f.h)}.\nGlobal point = frame origin + image pixel / ${scale.toFixed(3)}.\n${layout}`,
			},
			{ type: "image", data: result.image.jpegBase64, mimeType: "image/jpeg" },
		],
		details: { tool: "desktop_screenshot", display: result.display, frame: f, displays: result.displays, scale },
	};
}

interface DesktopInputResult {
	performed: string;
	mouse?: { x: number; y: number };
	pid?: number;
	appName?: string;
	bundleId?: string;
	text?: string;
	truncated?: boolean;
	length?: number;
}

/** Model-facing summary of one desktop_input result. */
export function desktopInputText(result: DesktopInputResult): string {
	switch (result.performed) {
		case "activateApp":
			return `${result.appName} (pid ${result.pid}) is now the frontmost app; desktop_input keys and text go to it.`;
		case "readClipboard":
			return `Clipboard text (${result.length} chars${result.truncated ? ", truncated to 100000" : ""}):\n${result.text}`;
		case "writeClipboard":
			return `Clipboard set (${result.length} chars).`;
		default:
			return `Performed ${result.performed}. Take a desktop_screenshot to verify the result.`;
	}
}

export async function executeDesktopInput(
	_id: string,
	params: DesktopInputParams,
	signal: AbortSignal | undefined,
	_onUpdate: unknown,
	_ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	assertDesktopControlAllowed();
	validateDesktopInput(params);
	const wire = params.action === "typeText" ? { ...params, action: "type" } : params.action === "keypress" ? { ...params, action: "key" } : params;
	const result = await withDesktopLock(() => macosHelper.command<DesktopInputResult>("desktopInput", { ...wire }, { signal, timeoutMs: 30_000 }), signal);
	return {
		content: [{ type: "text", text: desktopInputText(result) }],
		details: { tool: "desktop_input", action: result.performed, ...(result.pid !== undefined ? { pid: result.pid, appName: result.appName } : {}), ...(result.truncated !== undefined ? { truncated: result.truncated, length: result.length } : {}) },
	};
}
