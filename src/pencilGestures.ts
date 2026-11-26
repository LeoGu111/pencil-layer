/**
 * Apple Pencil hardware / gesture resolution (pure, tested in tests/pencilGestures.test.ts).
 *
 * Supports:
 * - Screen tip double-tap (gestures.ts)
 * - Bridged native iPadOS UIPencilInteraction events (`doubleTap` / `squeeze`), if provided by
 *   the host or a native bridge (`pdf-notes-pencil-gesture`, `obsidian-pencil-gesture`,
 *   `applePencilGesture`).
 */
import type { ActiveTool } from "./settings";

export const PENCIL_GESTURE_ACTIONS = [
	{ value: "system", label: "Follow iPadOS setting" },
	{ value: "eraser", label: "Toggle eraser" },
	{ value: "previous-tool", label: "Previous tool" },
	{ value: "palette", label: "Toggle tool palette" },
	{ value: "undo", label: "Undo ink" },
	{ value: "none", label: "Do nothing" },
] as const;

export type PencilGestureAction = (typeof PENCIL_GESTURE_ACTIONS)[number]["value"];

export interface PencilGestureDetail {
	kind: "doubleTap" | "squeeze";
	preferredAction?: string;
	platform?: string;
}

export interface PencilGestureResolution {
	tool?: ActiveTool;
	palette?: boolean;
	undo?: boolean;
}

export function sanitizePencilGestureAction(v: unknown, fallback: PencilGestureAction = "system"): PencilGestureAction {
	return PENCIL_GESTURE_ACTIONS.some((a) => a.value === v) ? (v as PencilGestureAction) : fallback;
}

/** Map a Pencil gesture action (and optional native iPadOS preferred action) into an app action. */
export function resolvePencilAction(
	action: PencilGestureAction,
	preferredAction: string | undefined,
	tool: ActiveTool,
	previousTool: ActiveTool | null,
): PencilGestureResolution {
	if (preferredAction === "ignore" || preferredAction === "runSystemShortcut") return {};
	let effective = action;
	if (effective === "system") {
		if (preferredAction === "switchEraser") effective = "eraser";
		else if (preferredAction === "switchPrevious") effective = "previous-tool";
		else if (
			preferredAction === "showColorPalette" ||
			preferredAction === "showInkAttributes" ||
			preferredAction === "showContextualPalette"
		) {
			effective = "palette";
		} else {
			return {};
		}
	}
	const prev = previousTool && previousTool !== "eraser" ? previousTool : "pen";
	if (effective === "eraser") return { tool: tool === "eraser" ? prev : "eraser" };
	if (effective === "previous-tool") return { tool: previousTool && previousTool !== tool ? previousTool : prev };
	if (effective === "palette") return { palette: true };
	if (effective === "undo") return { undo: true };
	return {};
}

/** Resolve an incoming native Pencil gesture event using the configured double-tap / squeeze actions. */
export function resolvePencilGesture(
	detail: PencilGestureDetail | undefined,
	doubleTap: PencilGestureAction,
	squeeze: PencilGestureAction,
	tool: ActiveTool,
	previousTool: ActiveTool | null,
): PencilGestureResolution {
	if (!detail || (detail.platform && detail.platform !== "ios")) return {};
	if (detail.kind === "doubleTap") return resolvePencilAction(doubleTap, detail.preferredAction, tool, previousTool);
	if (detail.kind === "squeeze") return resolvePencilAction(squeeze, detail.preferredAction, tool, previousTool);
	return {};
}
