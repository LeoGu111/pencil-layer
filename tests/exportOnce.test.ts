import { describe, expect, it } from "vitest";
import { DIALOG_MS, PRINT_GRACE_MS, arm, dialogClosed, otherDialog, pending, take } from "../src/exportOnce";

describe("one-shot PDF export override (Stage H)", () => {
	it("an armed export overrides the toggle for one print run, then the toggle applies again", () => {
		const first = take(arm(false, 0), true, 100);
		expect(first.include).toBe(false);
		expect(take(first.next, true, 200).include).toBe(true);
		expect(take(arm(true, 0), false, 50).include).toBe(true);
	});
	it("without an override the toggle decides", () => {
		expect(take(null, true, 0).include).toBe(true);
		expect(take(null, false, 0).include).toBe(false);
	});
	it("Export: the dialog closes, the render starts within the grace period", () => {
		const o = dialogClosed(arm(true, 0), 60_000);
		expect(o).toMatchObject({ include: true, phase: "closed", until: 60_000 + PRINT_GRACE_MS });
		expect(take(o, false, 61_000).include).toBe(true);
	});
	it("Cancel: no render within the grace period → the next plain export uses the toggle", () => {
		const o = dialogClosed(arm(true, 0), 1000);
		expect(pending(o, 1000 + PRINT_GRACE_MS)).toBe(true);
		expect(pending(o, 1001 + PRINT_GRACE_MS)).toBe(false);
		expect(take(o, false, 2000 + PRINT_GRACE_MS).include).toBe(false);
	});
	it("Cancel, then another export dialog right away: the override is dropped", () => {
		const closed = dialogClosed(arm(true, 0), 1000);
		expect(otherDialog(closed)).toBeNull();
		expect(take(otherDialog(closed), false, 1500).include).toBe(false);
	});
	it("another dialog while ours is still open keeps it", () => {
		const open = arm(false, 0);
		expect(otherDialog(open)).toBe(open);
	});
	it("a dialog left open forever expires (fallback timeout)", () => {
		const o = arm(false, 0);
		expect(pending(o, DIALOG_MS)).toBe(true);
		expect(take(o, true, DIALOG_MS + 1).include).toBe(true);
		expect(dialogClosed(o, DIALOG_MS + 1)).toBeNull();
	});
	it("closing twice or without an override does nothing", () => {
		expect(dialogClosed(null, 0)).toBeNull();
		const c = dialogClosed(arm(true, 0), 10);
		expect(dialogClosed(c, 20)).toBeNull();
	});
	it("a print before we saw the dialog close (close animation) still gets the override", () => {
		expect(take(arm(false, 0), true, 5000).include).toBe(false);
	});
});
