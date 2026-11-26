/**
 * Stage E double-tap rules, replayed against realistic handwriting contact sequences.
 *
 * `replay` mirrors InkView's logic: a contact that may be the first tap is held back (its dot is
 * committed only if no second tap follows within the gap); a second tap pairs only if the pair is
 * a double tap; every committed contact (stroke or dot) becomes "recent ink" for the writing guard.
 */
import { describe, expect, it } from "vitest";
import { INK_GUARD, RecentInk, TAP, Tap, canPair, isDoubleTap, isFirstTap, isTap, nearRecentInk } from "../src/gestures";

interface Contact {
	/** Down/up timestamps (ms). */
	down: number;
	up: number;
	/** Where the pen went down. */
	x: number;
	y: number;
	/** Largest movement from the down point (px); 0.5 for a dot. */
	move: number;
	/** Bbox of the ink it leaves (defaults to the point). */
	box?: RecentInk["box"];
}

/** Commit delay of a held-back tap (InkView: setTimeout(maxGapMs + 30)). */
const HOLD = TAP.maxGapMs + 30;

function replay(contacts: Contact[]): { toggles: number; dots: number } {
	const recent: RecentInk[] = [];
	type Held = { tap: Tap; box: RecentInk["box"] };
	let pending: Held | null = null;
	let toggles = 0;
	let dots = 0;
	const commit = (box: RecentInk["box"], at: number) => {
		recent.push({ box, at });
		dots++;
	};
	for (const c of contacts) {
		const box = c.box ?? { minX: c.x, minY: c.y, maxX: c.x, maxY: c.y };
		// The hold timer fired before this contact started.
		if (pending && c.down > pending.tap.upAt + HOLD) {
			commit(pending.box, pending.tap.upAt + HOLD);
			pending = null;
		}
		let pairWith: Held | null = null;
		if (pending) {
			if (canPair(pending.tap, c.x, c.y, c.down, recent)) pairWith = pending;
			else {
				commit(pending.box, c.down);
				pending = null;
			}
		}
		const tap: Tap = { x: c.x, y: c.y, downAt: c.down, upAt: c.up, maxMove: c.move };
		if (pending && pairWith === pending && isDoubleTap(pending.tap, tap, recent)) {
			pending = null;
			toggles++;
			continue;
		}
		if (isFirstTap(tap, recent)) {
			if (pending) commit(pending.box, c.up);
			pending = { tap, box };
			continue;
		}
		if (pending) {
			commit(pending.box, c.up);
			pending = null;
		}
		commit(box, c.up);
	}
	if (pending) commit(pending.box, pending.tap.upAt + HOLD);
	return { toggles, dots };
}

/** A handwriting stroke covering `box`, drawn from t to t + ms. */
function stroke(t: number, ms: number, minX: number, minY: number, maxX: number, maxY: number): Contact {
	return { down: t, up: t + ms, x: minX, y: minY, move: Math.hypot(maxX - minX, maxY - minY), box: { minX, minY, maxX, maxY } };
}

/** A pen dot: a short contact (default 45 ms, typical for a quick i-dot) with sub-pixel jitter. */
function dot(t: number, x: number, y: number, ms = 45, move = 0.6): Contact {
	return { down: t, up: t + ms, x, y, move };
}

describe("tap rules", () => {
	it("a tap is very short and nearly motionless", () => {
		expect(isTap({ x: 0, y: 0, downAt: 0, upAt: 100, maxMove: 1 })).toBe(true);
		expect(isTap({ x: 0, y: 0, downAt: 0, upAt: 210, maxMove: 1 })).toBe(false); // 210 ms: a press
		expect(isTap({ x: 0, y: 0, downAt: 0, upAt: 60, maxMove: 7.5 })).toBe(false); // moved 7.5 px
	});

	it("pairs only very close (< 14 px) and quick (< 340 ms) taps", () => {
		const a: Tap = { x: 100, y: 100, downAt: 0, upAt: 50, maxMove: 0.5 };
		expect(isDoubleTap(a, { x: 103, y: 103, downAt: 250, upAt: 290, maxMove: 0.5 })).toBe(true);
		expect(isDoubleTap(a, { x: 115, y: 108, downAt: 250, upAt: 290, maxMove: 0.5 })).toBe(false); // ~19 px
		expect(isDoubleTap(a, { x: 100, y: 100, downAt: 420, upAt: 460, maxMove: 0.5 })).toBe(false); // 370 ms gap
	});

	it("the writing guard: ink finished < 1.5 s ago within 40 px blocks a tap", () => {
		const ink: RecentInk[] = [{ box: { minX: 0, minY: 0, maxX: 50, maxY: 20 }, at: 1000 }];
		expect(nearRecentInk(60, 10, 1500, ink)).toBe(true); // 10 px right of it
		expect(nearRecentInk(95, 10, 1500, ink)).toBe(false); // 45 px away
		expect(nearRecentInk(60, 10, 1000 + INK_GUARD.ms + 1, ink)).toBe(false); // too old
	});
});

describe("handwriting never toggles the eraser", () => {
	it('"it" — the i is dotted after the t', () => {
		const seq = [
			stroke(0, 160, 100, 100, 102, 118), // i stem
			stroke(220, 200, 110, 92, 116, 118), // t stem
			stroke(470, 90, 106, 100, 122, 101), // t bar
			dot(650, 101, 92), // i dot
		];
		expect(replay(seq)).toEqual({ toggles: 0, dots: 4 });
	});

	it('"i" re-dotted quickly (the dot didn\'t show up well)', () => {
		const seq = [stroke(0, 150, 100, 100, 102, 118), dot(300, 101, 91), dot(420, 101.5, 91.5)];
		expect(replay(seq).toggles).toBe(0);
	});

	it('"j" and "ij" with quick dots', () => {
		const j = [stroke(0, 260, 200, 100, 206, 130), dot(330, 204, 92, 35, 0.3)];
		expect(replay(j).toggles).toBe(0);
		const ij = [stroke(0, 150, 100, 100, 102, 118), stroke(200, 250, 108, 100, 114, 130), dot(520, 101, 92, 30, 0.2), dot(640, 111, 92, 30, 0.2)];
		expect(replay(ij).toggles).toBe(0);
	});

	it('punctuation right after a word: "end." / "a:" / "so…"', () => {
		const word = stroke(0, 700, 100, 100, 150, 118);
		expect(replay([word, dot(820, 154, 117)]).toggles).toBe(0);
		// Colon: two dots ~5 px apart vertically, quick.
		expect(replay([word, dot(800, 155, 106, 40, 0.3), dot(980, 155, 111, 40, 0.3)]).toggles).toBe(0);
		// Ellipsis with tightly packed dots.
		expect(replay([word, dot(800, 154, 117, 30), dot(930, 158, 117, 30), dot(1060, 162, 117, 30)]).toggles).toBe(0);
	});

	it("umlaut dots (ü) right after the u", () => {
		const u = stroke(0, 400, 100, 104, 112, 118);
		expect(replay([u, dot(520, 103, 98, 30, 0.2), dot(640, 108, 98, 30, 0.2)]).toggles).toBe(0);
	});

	it("a whole line of dotted words", () => {
		const seq: Contact[] = [];
		let t = 0;
		let x = 0;
		for (let w = 0; w < 6; w++) {
			seq.push(stroke(t, 500, x, 100, x + 40, 118));
			t += 600;
			seq.push(dot(t, x + 8, 92, 40, 0.4));
			t += 150;
			seq.push(dot(t, x + 20, 92, 40, 0.4)); // second i in the word
			t += 400;
			x += 60;
		}
		seq.push(dot(t, x - 16, 117, 40, 0.3)); // full stop
		seq.push(dot(t + 140, x - 14, 117, 40, 0.3)); // accidental re-tap
		expect(replay(seq).toggles).toBe(0);
	});
});

describe("a real double tap still works", () => {
	it("in the margin, far from what was just written", () => {
		const seq = [stroke(0, 700, 100, 100, 150, 118), dot(900, 400, 300, 50, 0.5), dot(1100, 402, 301, 50, 0.5)];
		expect(replay(seq)).toEqual({ toggles: 1, dots: 1 });
	});

	it("near old ink once the writing guard has expired", () => {
		const seq = [stroke(0, 700, 100, 100, 150, 118), dot(2400, 152, 110, 50, 0.5), dot(2600, 153, 111, 50, 0.5)];
		expect(replay(seq).toggles).toBe(1);
	});

	it("on an empty page", () => {
		expect(replay([dot(0, 50, 50), dot(200, 51, 50)]).toggles).toBe(1);
	});

	it("but not with slow, moving or spread-out taps", () => {
		expect(replay([dot(0, 50, 50, 210), dot(250, 51, 50)]).toggles).toBe(0); // first tap 210 ms (too slow)
		expect(replay([dot(0, 50, 50, 50, 7.5), dot(200, 51, 50)]).toggles).toBe(0); // first tap moved 7.5 px
		expect(replay([dot(0, 50, 50), dot(200, 70, 50)]).toggles).toBe(0); // 20 px apart
		expect(replay([dot(0, 50, 50), dot(420, 51, 50)]).toggles).toBe(0); // 370 ms gap
	});
});
