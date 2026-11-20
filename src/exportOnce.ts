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
 *  - `take`: the print post-processor reads the effective value ONCE per export and consumes the
 *    override, so the next plain export uses the toggle again.
 */
export const DIALOG_MS = 30 * 60_000;
export const PRINT_GRACE_MS = 15_000;

export interface ExportOverride {
	include: boolean;
	phase: "dialog" | "closed";
	/** Expiry (ms, same clock as `now`). */
	until: number;
}

export function arm(include: boolean, now: number): ExportOverride {
	return { include, phase: "dialog", until: now + DIALOG_MS };
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

/** A print run starts: the effective "include ink" and the state afterwards (always consumed). */
export function take(o: ExportOverride | null, toggle: boolean, now: number): { include: boolean; next: null } {
	return { include: pending(o, now) ? o.include : toggle, next: null };
}
