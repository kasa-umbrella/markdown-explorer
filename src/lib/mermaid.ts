// Mermaid is ~2 MB; only pull it in (and pay the parse cost) on demand,
// the first time a `mermaid` fenced code block is encountered.

type MermaidApi = {
  render: (id: string, def: string) => Promise<{ svg: string }>
}

let mermaidPromise: Promise<MermaidApi> | null = null

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default
      mermaid.initialize({
        startOnLoad: false,
        // Default theme matches the app's light surfaces; strict securityLevel
        // forbids inline HTML/click handlers inside diagrams, which is what we want.
        theme: 'default',
        securityLevel: 'strict',
        fontFamily: 'inherit',
      })
      return mermaid as unknown as MermaidApi
    })
  }
  return mermaidPromise
}

let counter = 0

/** Render a mermaid source string to standalone SVG markup. */
export async function renderMermaid(definition: string): Promise<string> {
  const mermaid = await getMermaid()
  // Mermaid requires a DOM id that's a valid CSS selector; bump a counter to keep them unique.
  const id = `mmd-${++counter}`
  const { svg } = await mermaid.render(id, definition)
  return svg
}
