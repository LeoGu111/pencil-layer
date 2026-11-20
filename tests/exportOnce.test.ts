import { describe, expect, it } from "vitest";
import { DIALOG_MS, PRINT_GRACE_MS, arm, dialogClosed, otherDialog, pending, take } from "../src/exportOnce";

const ON = { include: true, style: "themed" } as const;
const OFF = { include: false, style: "themed" } as const;

describe("one-shot PDF export override (Stage H)", () => {
	it("an armed export overrides the toggle for one print run, then the toggle applies again", () => {
		const first = take(arm({ include: false }, 0), ON, 100);
		expect(first.include).toBe(false);
		expect(take(first.next, ON, 200).include).toBe(true);
		expect(take(arm({ include: true }, 0), OFF, 50).include).toBe(true);
	});
	it("without an override the toggle decides", () => {
		expect(take(null, ON, 0).include).toBe(true);
		expect(take(null, OFF, 0).include).toBe(false);
	});
	it("Export: the dialog closes, the render starts within the grace period", () => {
		const o = dialogClosed(arm({ include: true }, 0), 60_000);
		expect(o).toMatchObject({ include: true, phase: "closed", until: 60_000 + PRINT_GRACE_MS });
		expect(take(o, OFF, 61_000).include).toBe(true);
	});
	it("Cancel: no render within the grace period → the next plain export uses the toggle", () => {
		const o = dialogClosed(arm({ include: true }, 0), 1000);
		expect(pending(o, 1000 + PRINT_GRACE_MS)).toBe(true);
		expect(pending(o, 1001 + PRINT_GRACE_MS)).toBe(false);
		expect(take(o, OFF, 2000 + PRINT_GRACE_MS).include).toBe(false);
	});
	it("Cancel, then another export dialog right away: the override is dropped", () => {
		const closed = dialogClosed(arm({ include: true }, 0), 1000);
		expect(otherDialog(closed)).toBeNull();
		expect(take(otherDialog(closed), OFF, 1500).include).toBe(false);
	});
	it("another dialog while ours is still open keeps it", () => {
		const open = arm({ include: false }, 0);
		expect(otherDialog(open)).toBe(open);
	});
	it("a dialog left open forever expires (fallback timeout)", () => {
		const o = arm({ include: false }, 0);
		expect(pending(o, DIALOG_MS)).toBe(true);
		expect(take(o, ON, DIALOG_MS + 1).include).toBe(true);
		expect(dialogClosed(o, DIALOG_MS + 1)).toBeNull();
	});
	it("closing twice or without an override does nothing", () => {
		expect(dialogClosed(null, 0)).toBeNull();
		const c = dialogClosed(arm({ include: true }, 0), 10);
		expect(dialogClosed(c, 20)).toBeNull();
	});
	it("a print before we saw the dialog close (close animation) still gets the override", () => {
		expect(take(arm({ include: false }, 0), ON, 5000).include).toBe(false);
	});
	it("a document-style export sets the style for one run and leaves ink to the toggle", () => {
		const first = take(arm({ style: "document" }, 0), ON, 100);
		expect(first).toMatchObject({ include: true, style: "document" });
		expect(take(first.next, ON, 200)).toMatchObject({ include: true, style: "themed" });
		expect(take(arm({ style: "document" }, 0), OFF, 100)).toMatchObject({ include: false, style: "document" });
	});
	it("with/without-ink exports use the default style; an export can set both", () => {
		const docDefault = { include: true, style: "document" } as const;
		expect(take(arm({ include: false }, 0), docDefault, 10)).toMatchObject({ include: false, style: "document" });
		expect(take(arm({ include: false, style: "themed" }, 0), docDefault, 10)).toMatchObject({ include: false, style: "themed" });
		expect(take(null, docDefault, 10)).toMatchObject({ include: true, style: "document" });
	});
	it("an expired style override falls back to the default style", () => {
		const o = dialogClosed(arm({ style: "document" }, 0), 1000);
		expect(take(o, ON, 2000 + PRINT_GRACE_MS).style).toBe("themed");
	});
});
