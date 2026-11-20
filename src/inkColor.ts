/**
 * Stage L — theme-adaptive ink colors (pure, tested; no DOM / Obsidian imports).
 *
 * The stored stroke color never changes; only what is painted does:
 *  - "ink" (the default pen) and near-black colors are the theme's foreground: dark on a light
 *    theme, light on a dark one;
 *  - near-white colors are the foreground on a light theme (white ink stays white on dark);
 *  - every other color keeps its value (hue and lightness), highlighters always keep theirs.
 *
 * On screen the result is a CSS expression of custom properties set by the body's theme class
 * (styles.css: `.theme-dark { --pl-dark-ink: var(--text-normal) }`, `.theme-light
 * { --pl-light-ink: var(--text-normal) }`), so switching Obsidian's theme recolors every open
 * view live, with no re-render. On paper (PDF export, print) colors are literal: the light-paper
 * mapping, black-ish ink as PAPER_INK on white, whatever the current theme.
 */

/** Ink on white paper (PDF export / print) for "ink", near-black and near-white strokes. */
export const PAPER_INK = "#1a1a1a";

export type ColorClass = "ink" | "dark" | "light" | "other";

/** How a render target sees colors: the live theme (CSS variables), or white paper (literal). */
export type InkTarget = "screen" | "paper";

const NAMED: Record<string, [number, number, number]> = {
	black: [0, 0, 0],
	white: [255, 255, 255],
};

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(), black/white → [r, g, b] (0–255), else null. */
export function parseRgb(color: string): [number, number, number] | null {
	const c = color.trim().toLowerCase();
	if (NAMED[c]) return NAMED[c];
	let m = /^#([0-9a-f]{3,4})$/.exec(c);
	if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [number, number, number];
	m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(c);
	if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
	m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
	if (m) return [1, 2, 3].map((i) => Math.max(0, Math.min(255, Number(m[i])))) as [number, number, number];
	return null;
}

/** Chroma (max − min channel) at most this (0–255) counts as gray. */
const GRAY_CHROMA = 40;
/** Gray with lightness (max channel) at most this is "black-ish". */
const DARK_MAX = 72;
/** Gray with lightness (min channel) at least this is "white-ish". */
const LIGHT_MIN = 215;

/** Which adaptation a stored stroke color gets. */
export function classifyColor(color: string): ColorClass {
	if (color === "ink") return "ink";
	const rgb = parseRgb(color);
	if (!rgb) return "other";
	const hi = Math.max(...rgb);
	const lo = Math.min(...rgb);
	if (hi - lo > GRAY_CHROMA) return "other";
	if (hi <= DARK_MAX) return "dark";
	if (lo >= LIGHT_MIN) return "light";
	return "other";
}

/**
 * The paint value for a stored stroke color. `tool` "highlighter" keeps its color (except the
 * "ink" token, which has no literal value).
 */
export function inkColor(color: string, target: InkTarget, tool?: string): string {
	const k = tool === "highlighter" && color !== "ink" ? "other" : classifyColor(color);
	if (target === "paper") return k === "other" ? color : PAPER_INK;
	switch (k) {
		case "ink":
			return "var(--pl-ink, var(--text-normal))";
		case "dark":
			return `var(--pl-dark-ink, ${color})`;
		case "light":
			return `var(--pl-light-ink, ${color})`;
		default:
			return color;
	}
}

/**
 * A literal color for canvases (screenshot, clipboard PNG), which can't resolve CSS variables:
 * `dark` = the current theme is dark, `fg` = the resolved theme text color.
 */
export function resolvedInkColor(color: string, dark: boolean, fg: string, tool?: string): string {
	const k = tool === "highlighter" && color !== "ink" ? "other" : classifyColor(color);
	if (k === "ink") return fg;
	if (k === "dark") return dark ? fg : color;
	if (k === "light") return dark ? color : fg;
	return color;
}
