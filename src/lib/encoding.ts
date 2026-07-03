/**
 * Decode raw file bytes to text, auto-detecting UTF-8 vs Shift_JIS.
 *
 * Every reader used to assume UTF-8, so legacy Japanese CSV / Markdown saved as
 * Shift_JIS (the Windows-31J superset Excel emits) rendered as mojibake. We now
 * pick the encoding from the bytes instead:
 *
 *   1. An explicit BOM (UTF-8 / UTF-16 LE / UTF-16 BE) is authoritative.
 *   2. Otherwise try strict UTF-8 — valid UTF-8 (ASCII is a subset) always wins.
 *   3. On the first invalid UTF-8 byte sequence, fall back to Shift_JIS.
 *
 * Multi-byte Shift_JIS text almost never forms valid UTF-8, so step 2's `fatal`
 * decode is a reliable discriminator. `TextDecoder` ships the 'shift_jis' label
 * natively in both Chromium (the Electron renderer) and Electron's full-ICU Node
 * main process, so this needs no external dependency and can run on either side.
 */
export function decodeText(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)

  // An explicit BOM wins outright.
  if (view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(view.subarray(3))
  }
  if (view.length >= 2 && view[0] === 0xff && view[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(view.subarray(2))
  }
  if (view.length >= 2 && view[0] === 0xfe && view[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(view.subarray(2))
  }

  // No BOM: prefer UTF-8, but detect it strictly so we can fall through on failure.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view)
  } catch {
    // Not valid UTF-8 → assume legacy Shift_JIS (decodes leniently, no throw).
    return new TextDecoder('shift_jis').decode(view)
  }
}
