// Copied from Knossos-MCP hooks/lib/palette.ts at a4412478, trimmed to what Kanon's pane uses.
/**
 * The pane's colours, as Claude Code theme keys. A theme key follows the
 * person's theme (dark, light, daltonized, ANSI), so the pane matches the
 * rest of the screen instead of carrying a palette of its own. Never a hex
 * value.
 *
 * Colour only reinforces a glyph: every state the pane reports has its own
 * mark (`marks.ts`), so a colour-blind reader or a monochrome terminal loses
 * nothing. Secondary text stays `inactive`, rules and empty cells `subtle`;
 * `suggestion` marks the selection.
 */

/** Headings and numbers. */
export const HEADING = 'text'
/** Secondary text: notes, column titles, labels before a value. */
export const SECONDARY = 'inactive'
/** The faintest ink: rules and frames. */
export const FAINT = 'subtle'
/** The selection marker. */
export const ACCENT = 'suggestion'
/** The marked row's faint tint (the grey Claude Code lays under the person's own prompts). */
export const SELECTED_BG = 'userMessageBackground'

/** The theme keys the pane draws in. */
export type Tone = 'success' | 'warning' | 'error' | 'inactive' | 'subtle' | 'suggestion' | 'text' | 'claude'

/** How something stands, as a theme key. */
export const STATUS_COLOURS = { ok: 'success', warn: 'warning', alert: 'error' } as const satisfies Record<string, Tone>

/** A card's title glyph: the orange Claude Code marks itself with, so the cards read as part of the screen around them. */
export const TITLE = 'claude' satisfies Tone
