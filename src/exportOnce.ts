/**
 * Stage H — one-shot "Export PDF with / without ink" (pure, tested; no DOM / Obsidian imports).
 *
 * The persisted "Include ink in PDF export" toggle stays the default for Obsidian's own export. Our
 * commands / ⋯ menu entries arm a one-shot override, then run Obsidian's export, which is
 * asynchronous: a dialog (desktop: then a native save dialog — cancelling it keeps the dialog open),
 * and only after the dialog closes the hidden render that runs our post-processor once. So:
 *
 *  - `arm`: the override applies to the next print run; it waits while the dialog is open (up to
 *    DIALOG_MS, a fallback for a dialog we failed to see close);
 *  - `dialogClosed`: Export closes the dialog right before the render starts, Cancel closes it for
 *    good — the override survives only PRINT_GRACE_MS more;
 *  - `otherDialog`: a new dialog opening after ours closed means no render followed ours (the user
 *    cancelled and started another export): dropped;
 *  - `take`: the print post-processor reads the effective values ONCE per export and consumes the
 *    override, so the next plain export uses the toggle again.
 *
 * An override carries what it sets for that one export: `include` (ink or not) and/or `style`
 * (themed / document, see docStyle.ts). Whatever it leaves unset comes from the defaults (the
 * "Include ink in PDF export" toggle, the "Default export style" setting).
 */
import type { ExportStyle } from "./docStyle";

export const DIALOG_MS = 30 * 60_000;
export const PRINT_GRACE_MS = 15_000;

/** What a one-shot export sets (unset = the default). */
export interface ExportChoice {
	include?: boolean;
	style?: ExportStyle;
}

/** The effective options of one print run. */
export interface ExportOptions {
	include: boolean;
	style: ExportStyle;
}

export interface ExportOverride extends ExportChoice {
	phase: "dialog" | "closed";
	/** Expiry (ms, same clock as `now`). */
	until: number;
}

export function arm(choice: ExportChoice, now: number): ExportOverride {
	const o: ExportOverride = { phase: "dialog", until: now + DIALOG_MS };
	if (choice.include !== undefined) o.include = choice.include;
	if (choice.style !== undefined) o.style = choice.style;
	return o;
}

/** Our export dialog closed (Export or Cancel): a render, if any, starts right away. */
export function dialogClosed(o: ExportOverride | null, now: number): ExportOverride | null {
	if (!o || o.phase !== "dialog" || now > o.until) return null;
	return { ...o, phase: "closed", until: Math.min(o.until, now + PRINT_GRACE_MS) };
}

/** Another dialog opened: once ours has closed, no render followed it. */
export function otherDialog(o: ExportOverride | null): ExportOverride | null {
	return o && o.phase === "closed" ? null : o;
}

/** Is the override still pending at `now`? */
export function pending(o: ExportOverride | null, now: number): o is ExportOverride {
	return !!o && now <= o.until;
}

/** A print run starts: the effective options and the state afterwards (always consumed). */
export function take(o: ExportOverride | null, defaults: ExportOptions, now: number): ExportOptions & { next: null } {
	const live = pending(o, now) ? o : null;
	return { include: live?.include ?? defaults.include, style: live?.style ?? defaults.style, next: null };
}
