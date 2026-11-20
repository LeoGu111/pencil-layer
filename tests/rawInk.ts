/** Untyped view of a serialized sidecar, for tests that inspect the JSON written to disk. */
export interface RawInk {
	version: number;
	contentWidth: number;
	strokes: Record<string, unknown>[];
	spaces?: unknown;
	[key: string]: unknown;
}

export function parseRaw(text: string): RawInk {
	return JSON.parse(text) as RawInk;
}
