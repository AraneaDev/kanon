// Copied from src/colour.ts (stripControl); the mod cannot import src/ at runtime.
/**
 * Strip control characters from text Kanon did not write: C0 controls, DEL
 * and C1. A path, a reason, a verdict's evidence or an error message can
 * come from a file a dependency shipped, and an escape sequence or a lone
 * carriage return drawn into the pane could repaint what the pane appears
 * to say about it, exactly as it could in the report. Ordinary text is
 * untouched, accents and emoji included.
 *
 * Never applied to an item's realpath: that is the key `kanon ack` looks the
 * item up by, and it must reach the CLI exactly as the model gave it.
 */
export function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
}
