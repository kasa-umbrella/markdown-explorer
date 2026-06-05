import { useEffect, useRef, useState } from 'react'
import { buildLinkGraph, type LinkGraph } from '../lib/linkGraph'
import type { ScanResult } from '../types'

/**
 * Pastel-pop palette. Each entry pairs a soft fill with a slightly deeper stroke
 * of the same hue, so node + border read as a single colour without going muddy.
 * Nodes are deterministically assigned a slot via a hash of the file path, so the
 * same file is always painted the same colour across rebuilds.
 */
const PALETTE: ReadonlyArray<{ fill: string; stroke: string }> = [
  { fill: '#FFB3BA', stroke: '#E58A93' }, // coral
  { fill: '#FFD8A8', stroke: '#E5B07A' }, // peach
  { fill: '#FFF1A8', stroke: '#E5D177' }, // butter
  { fill: '#C9F0A8', stroke: '#9DCC79' }, // pistachio
  { fill: '#A8F0D1', stroke: '#79CCA8' }, // mint
  { fill: '#A8E1FF', stroke: '#79B9E5' }, // sky
  { fill: '#B9BCFF', stroke: '#8A8FE5' }, // periwinkle
  { fill: '#D9B3FF', stroke: '#B089E5' }, // lilac
  { fill: '#FFB3E6', stroke: '#E58ABE' }, // bubblegum
  { fill: '#B5F0EB', stroke: '#84CCC6' }, // aqua
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h < 0 ? -h : h
}

function colorFor(path: string): { fill: string; stroke: string } {
  return PALETTE[hashString(path) % PALETTE.length]
}

// Minimal local shape for cytoscape — declaring just what we touch keeps the
// dynamic import free of the `export = ` interop headaches in the library's d.ts.
interface CyCollection {
  length: number
  addClass(c: string): void
  removeClass(c: string): void
}
interface CyTapEvent {
  target: { id(): string }
}
interface CyInstance {
  on(event: 'tap', selector: string, handler: (evt: CyTapEvent) => void): void
  getElementById(id: string): CyCollection
  nodes(selector?: string): CyCollection
  destroy(): void
}
type CytoscapeFactory = (options: Record<string, unknown>) => CyInstance

interface Props {
  scan: ScanResult
  /** Path of the file currently focused in the preview, highlighted in the graph. */
  activePath: string | null
  /** Tap on a node ⇒ open that file. The parent typically switches out of graph mode. */
  onSelectFile: (path: string) => void
}

/**
 * Force-directed map of `.md`-to-`.md` links inside the active root folder.
 * Cytoscape is loaded lazily (only when the user first opens this view) so the
 * library doesn't bloat the initial bundle.
 */
export function GraphView({ scan, activePath, onSelectFile }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [stats, setStats] = useState<{ nodes: number; edges: number } | null>(null)

  // Keep the latest callback in a ref so the cytoscape effect can stay scoped to `scan`.
  const onSelectFileRef = useRef(onSelectFile)
  useEffect(() => {
    onSelectFileRef.current = onSelectFile
  }, [onSelectFile])

  // Build the cytoscape instance once per scan.
  const cyRef = useRef<CyInstance | null>(null)
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrorMsg(null)
    ;(async () => {
      let graph: LinkGraph
      let cytoscape: CytoscapeFactory
      try {
        const [cyMod, builtGraph] = await Promise.all([
          import('cytoscape') as unknown as Promise<{ default: CytoscapeFactory }>,
          buildLinkGraph(scan),
        ])
        cytoscape = cyMod.default
        graph = builtGraph
      } catch (e) {
        if (cancelled) return
        setErrorMsg(e instanceof Error ? e.message : String(e))
        setStatus('error')
        return
      }
      if (cancelled || !containerRef.current) return

      setStats({ nodes: graph.nodes.length, edges: graph.edges.length })
      if (graph.nodes.length === 0) {
        setStatus('empty')
        return
      }

      const colorByPath = new Map<string, { fill: string; stroke: string }>()
      for (const id of graph.nodes) colorByPath.set(id, colorFor(id))
      const grey = { fill: '#cfd6e4', stroke: '#9aa4b8' }

      const elements = [
        ...graph.nodes.map((id) => {
          const c = colorByPath.get(id) ?? grey
          return {
            data: {
              id,
              label: id.split('/').pop() ?? id,
              path: id,
              fill: c.fill,
              stroke: c.stroke,
            },
          }
        }),
        ...graph.edges.map((e) => {
          const c = colorByPath.get(e.source) ?? grey
          return {
            data: {
              id: `${e.source}→${e.target}`,
              source: e.source,
              target: e.target,
              color: c.stroke,
            },
          }
        }),
      ]

      const cy = cytoscape({
        container: containerRef.current,
        elements,
        wheelSensitivity: 0.2,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': 'data(fill)',
              'border-color': 'data(stroke)',
              'border-width': 2,
              label: 'data(label)',
              'font-size': 11,
              'font-family': "'Noto Sans JP', sans-serif",
              color: '#1f2328',
              'text-valign': 'bottom',
              'text-margin-y': 5,
              'text-background-color': '#ffffff',
              'text-background-opacity': 0.88,
              'text-background-padding': '3px',
              'text-background-shape': 'roundrectangle',
              width: 22,
              height: 22,
            },
          },
          {
            // Keeps each file's pastel identity, but stamps a saturated ring on the
            // active one so the eye finds it at a glance against the busy field.
            selector: 'node:selected, node.active',
            style: {
              'border-color': '#2f6feb',
              'border-width': 4,
              width: 30,
              height: 30,
              'font-size': 12,
              'z-index': 10,
            },
          },
          {
            selector: 'edge',
            style: {
              width: 1.6,
              'line-color': 'data(color)',
              'curve-style': 'bezier',
              'target-arrow-color': 'data(color)',
              'target-arrow-shape': 'triangle',
              'arrow-scale': 0.9,
              'target-distance-from-node': 2,
              opacity: 0.85,
            },
          },
        ],
        layout: {
          name: 'cose',
          animate: false,
          fit: true,
          padding: 32,
          // The defaults look fine for small/medium graphs; we leave knobs alone.
        },
      })

      cy.on('tap', 'node', (evt: CyTapEvent) => {
        const id = evt.target.id()
        onSelectFileRef.current(id)
      })

      if (activePath) {
        const target = cy.getElementById(activePath)
        if (target.length > 0) target.addClass('active')
      }

      cyRef.current = cy
      setStatus('ready')
    })()
    return () => {
      cancelled = true
      cyRef.current?.destroy()
      cyRef.current = null
    }
    // Intentionally exclude activePath: we only want to rebuild on scan change,
    // not when the user clicks around. Active-node highlighting is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan])

  // Keep the active highlight in sync without rebuilding the whole graph.
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || status !== 'ready') return
    cy.nodes().removeClass('active')
    if (activePath) {
      const t = cy.getElementById(activePath)
      if (t.length > 0) t.addClass('active')
    }
  }, [activePath, status])

  return (
    <div className="graph-view">
      <div className="graph-canvas" ref={containerRef} />
      {status === 'loading' && (
        <div className="graph-overlay">
          <p>リンクを、 たどっています…</p>
        </div>
      )}
      {status === 'empty' && (
        <div className="graph-overlay">
          <p>このフォルダには .md が見つかりません。</p>
        </div>
      )}
      {status === 'error' && (
        <div className="graph-overlay graph-overlay-error">
          <p>グラフを構築できませんでした</p>
          {errorMsg && <pre>{errorMsg}</pre>}
        </div>
      )}
      {status === 'ready' && stats && (
        <div className="graph-legend" aria-hidden>
          {stats.nodes} ファイル · {stats.edges} リンク
        </div>
      )}
    </div>
  )
}
