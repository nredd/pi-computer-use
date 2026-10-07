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
	| { action: "keypress"; keys: string[] };

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
export function withDesktopLock<T>(work: () => Promise<T>): Promise<T> {
	const run = desktopQueue.then(work, work);
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
			if (typeof params.text !== "string" || params.text.length === 0) throw new Error("typeText requires non-empty text.");
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
	));
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
	const result = await withDesktopLock(() => macosHelper.command<{ performed: string; mouse: { x: number; y: number } }>("desktopInput", { ...wire }, { signal, timeoutMs: 30_000 }));
	return {
		content: [{ type: "text", text: `Performed ${result.performed}. Take a desktop_screenshot to verify the result.` }],
		details: { tool: "desktop_input", action: result.performed },
	};
}
