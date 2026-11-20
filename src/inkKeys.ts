/**
 * Stage F: keyboard shortcuts for an ink selection (Esc, Delete/Backspace, Mod+C/X/V/D).
 *
 * The decision is pure (`routeInkKey`, select.ts): plain typing is never taken, keys aimed at
 * anything but the ACTIVE leaf's editor (inputs, modals, other panes) are left alone, and without
 * an ink selection Obsidian behaves normally — except Mod+V while the Select tool is active and the
 * ink clipboard is non-empty, and a second Escape that leaves Select (and still reaches Obsidian).
 *
 * Two entry points, same decision:
 *  1. An Obsidian keymap `Scope`, pushed only while an ink selection exists or the Select tool is
 *     active. Obsidian's keymap runs first in the window's capture phase and would otherwise run a
 *     hotkey bound to the same keys (Mod+D is "Delete paragraph" by default) before us. Its single
 *     catch-all handler returns `false` (handled, preventDefault) for our keys and `undefined` for
 *     everything else, which Obsidian passes on to the parent scope (normal hotkeys).
 *  2. A window capture-phase keydown listener, for keys Obsidian's keymap doesn't look at; it skips
 *     events the scope already handled (defaultPrevented).
 */
import { App, Platform, Scope } from "obsidian";
import type { InkView } from "./inkView";
import { InkKeyAction, KeyContext, consumesKey, routeInkKey } from "./select";

export interface InkKeysHost {
	/** The ink view of the active Markdown leaf (null: none / not an editor). */
	activeInkView(): InkView | null;
	/** The desktop Select tool is active. */
	isDeskSelecting(): boolean;
	clipboardFull(): boolean;
	/** Escape with nothing selected: leave the Select tool. */
	exitDeskSelect(): void;
}

/** Is focus in `view`'s editor (or nowhere at all)? Inputs, modals and other panes are "other". */
function focusOf(e: KeyboardEvent, view: InkView): KeyContext["focus"] {
	const doc = view.view.dom.ownerDocument;
	if (doc.querySelector(".modal-container")) return "other";
	const t = e.target;
	if (!(t instanceof Node)) return "editor";
	if (t === doc.body || t === doc.documentElement || t === doc) return "editor";
	return view.view.dom.contains(t) ? "editor" : "other";
}

export class InkKeys {
	private readonly scope: Scope;
	private pushed = false;

	constructor(
		private readonly app: App,
		private readonly host: InkKeysHost,
	) {
		this.scope = new Scope(app.scope);
		// null/null: every key; returning undefined passes the key on to the parent scope.
		this.scope.register(null, null, (e) => (this.handle(e) ? false : undefined));
	}

	/** Window capture-phase listener (see header, entry point 2). */
	readonly onKeyDown = (e: KeyboardEvent): void => {
		if (e.defaultPrevented) return;
		if (this.handle(e)) {
			e.preventDefault();
			e.stopImmediatePropagation();
		}
	};

	/** Push the scope while it can matter (a selection exists, or Select is active); pop otherwise. */
	sync(anySelection: boolean): void {
		const want = anySelection || this.host.isDeskSelecting();
		if (want === this.pushed) return;
		this.pushed = want;
		if (want) this.app.keymap.pushScope(this.scope);
		else this.app.keymap.popScope(this.scope);
	}

	destroy(): void {
		if (this.pushed) this.app.keymap.popScope(this.scope);
		this.pushed = false;
	}

	/** Route and run a key; true ⇒ consumed (the caller prevents the default). */
	private handle(e: KeyboardEvent): boolean {
		if (e.type !== "keydown") return false;
		const view = this.host.activeInkView();
		if (!view) return false;
		const mac = Platform.isMacOS;
		const action: InkKeyAction | null = routeInkKey(
			{
				key: e.key,
				mod: mac ? e.metaKey : e.ctrlKey,
				otherMod: mac ? e.ctrlKey : e.metaKey,
				shift: e.shiftKey,
				alt: e.altKey,
				composing: e.isComposing,
				repeat: e.repeat,
			},
			{
				hasSelection: view.hasSelection,
				selectActive: this.host.isDeskSelecting(),
				clipboardFull: this.host.clipboardFull(),
				focus: focusOf(e, view),
			},
		);
		if (!action) return false;
		if (action === "exit-select") this.host.exitDeskSelect();
		else view.runKeyAction(action);
		return consumesKey(action);
	}
}
