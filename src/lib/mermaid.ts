// Mermaid is ~2 MB; only pull it in (and pay the parse cost) on demand,
// the first time a `mermaid` fenced code block is encountered.

type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void
  render: (id: string, def: string) => Promise<{ svg: string }>
}

let mermaidPromise: Promise<MermaidApi> | null = null
/** Last applied theme key so we only re-init when the user actually flips schemes. */
let lastAppliedTheme: 'dark' | 'default' | null = null

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(
      (mod) => mod.default as unknown as MermaidApi,
    )
  }
  return mermaidPromise
}

/** Mirror the app's `data-theme` onto mermaid so newly-rendered diagrams match the UI. */
function currentMermaidTheme(): 'dark' | 'default' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'
}

let counter = 0

/**
 * Render a mermaid source string to standalone SVG markup.
 *
 * Re-initialises the singleton whenever the active theme changes so that diagrams
 * opened after a Light↔Dark switch take on the new palette. Already-rendered SVGs
 * stay frozen with the colors they were drawn with — re-rendering them on theme
 * change would force the whole markdown body to remount, which isn't worth it
 * for a feature most users won't toggle often.
 */
export async function renderMermaid(definition: string): Promise<string> {
  const mermaid = await getMermaid()
  const theme = currentMermaidTheme()
  if (theme !== lastAppliedTheme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      // Forbid inline HTML / click handlers inside diagrams.
      securityLevel: 'strict',
      fontFamily: 'inherit',
    })
    lastAppliedTheme = theme
  }
  // Mermaid requires a DOM id that's a valid CSS selector; bump a counter to keep them unique.
  const id = `mmd-${++counter}`
  const { svg } = await mermaid.render(id, definition)
  return svg
}
