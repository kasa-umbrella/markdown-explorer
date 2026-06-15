// Parse mermaid `flowchart` / `graph` blocks via mermaid's own parser, then
// hand the resulting nodes & edges to dagre for layout so React-Flow can paint
// an interactive, draggable version of the diagram.

import type { CSSProperties } from 'react'
import dagre from 'dagre'
import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react'
import { MarkerType, Position } from '@xyflow/react'

export type FlowDirection = 'TB' | 'BT' | 'LR' | 'RL'

export interface ParsedFlowchart {
  nodes: RFNode[]
  edges: RFEdge[]
  direction: FlowDirection
  /** Outer bounding box of the laid-out graph (dagre's reported width/height). */
  width: number
  height: number
}

/** Cheap front-matter check so we can skip the heavy mermaid import for non-flowcharts. */
export function isFlowchart(definition: string): boolean {
  // Skip blank lines and YAML front-matter (`--- ... ---`) before sniffing the directive.
  const lines = definition.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (lines[i]?.trim() === '---') {
    i++
    while (i < lines.length && lines[i].trim() !== '---') i++
    i++
  }
  while (i < lines.length && lines[i].trim() === '') i++
  const head = lines[i]?.trim() ?? ''
  return /^(graph|flowchart)\b/i.test(head)
}

const DEFAULT_NODE_WIDTH = 172
const DEFAULT_NODE_HEIGHT = 44

/** Strip a label-type wrapper added by the parser when the source used backticks/markdown. */
function cleanLabel(text: string | undefined, fallback: string): string {
  if (!text) return fallback
  // The parser sometimes leaves HTML entities (`&gt;` etc) in `text`. markdown-it style
  // escaping is enough — react-flow renders labels as plain strings.
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function normalizeDirection(raw: string | undefined): FlowDirection {
  const v = (raw ?? 'TB').toUpperCase()
  if (v === 'TD') return 'TB'
  if (v === 'TB' || v === 'BT' || v === 'LR' || v === 'RL') return v
  return 'TB'
}

interface MermaidLike {
  initialize: (cfg: Record<string, unknown>) => void
  mermaidAPI: {
    getDiagramFromText: (text: string) => Promise<{ db: unknown }>
  }
}

let mermaidPromise: Promise<MermaidLike> | null = null
async function getMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const m = mod.default as unknown as MermaidLike
      // `getDiagramFromText` needs the global config wired up at least once.
      m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
      return m
    })
  }
  return mermaidPromise
}

/**
 * Parse a mermaid flowchart source and produce React-Flow-ready nodes/edges
 * with positions already assigned by dagre. Returns null if the source isn't
 * a flowchart or if mermaid's parser bails — callers should then fall back to
 * the static SVG renderer.
 */
export async function parseFlowchart(definition: string): Promise<ParsedFlowchart | null> {
  if (!isFlowchart(definition)) return null
  let diagram: { db: unknown }
  try {
    const mermaid = await getMermaid()
    diagram = await mermaid.mermaidAPI.getDiagramFromText(definition)
  } catch {
    return null
  }

  // FlowDB exposes getVertices/getEdges/getDirection; we type it loosely because
  // mermaid's d.ts surface for the db is not part of its public API.
  const db = diagram.db as {
    getVertices: () => Map<string, { id: string; text?: string; type?: string }>
    getEdges: () => Array<{
      start: string
      end: string
      text?: string
      stroke?: string
      type?: string
    }>
    getDirection: () => string | undefined
  }

  let vertices: Map<string, { id: string; text?: string; type?: string }>
  let edges: Array<{ start: string; end: string; text?: string; stroke?: string; type?: string }>
  let direction: FlowDirection
  try {
    vertices = db.getVertices()
    edges = db.getEdges()
    direction = normalizeDirection(db.getDirection())
  } catch {
    return null
  }

  const g = new dagre.graphlib.Graph()
  g.setGraph({
    rankdir: direction,
    nodesep: 40,
    ranksep: 60,
    marginx: 16,
    marginy: 16,
  })
  g.setDefaultEdgeLabel(() => ({}))

  // dagre's `Node` type rejects arbitrary keys, so keep label/shape lookups
  // in side tables instead of stuffing them into the graphlib node.
  const labels = new Map<string, string>()
  const shapes = new Map<string, string | undefined>()
  for (const [id, v] of vertices) {
    const label = cleanLabel(v.text, id)
    const width = Math.min(360, Math.max(DEFAULT_NODE_WIDTH, label.length * 9 + 32))
    labels.set(id, label)
    shapes.set(id, v.type)
    g.setNode(id, { width, height: DEFAULT_NODE_HEIGHT })
  }
  for (const e of edges) {
    if (!vertices.has(e.start) || !vertices.has(e.end)) continue
    g.setEdge(e.start, e.end)
  }

  dagre.layout(g)

  const isHorizontal = direction === 'LR' || direction === 'RL'
  const sourcePos = isHorizontal ? Position.Right : Position.Bottom
  const targetPos = isHorizontal ? Position.Left : Position.Top

  const rfNodes: RFNode[] = []
  for (const id of g.nodes()) {
    const n = g.node(id)
    if (!n) continue
    rfNodes.push({
      id,
      data: { label: labels.get(id) ?? id },
      position: { x: n.x - n.width / 2, y: n.y - n.height / 2 },
      width: n.width,
      height: n.height,
      sourcePosition: sourcePos,
      targetPosition: targetPos,
      style: nodeStyleFor(shapes.get(id)),
    })
  }

  const rfEdges: RFEdge[] = edges
    .filter((e) => vertices.has(e.start) && vertices.has(e.end))
    .map((e, i) => {
      const label = cleanLabel(e.text, '')
      const dotted = e.stroke === 'dotted'
      const thick = e.stroke === 'thick'
      const invisible = e.stroke === 'invisible'
      return {
        id: `e${i}-${e.start}-${e.end}`,
        source: e.start,
        target: e.end,
        label: label || undefined,
        animated: false,
        type: 'default',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: {
          stroke: invisible ? 'transparent' : 'var(--rf-edge, #94a3b8)',
          strokeWidth: thick ? 2.5 : 1.5,
          strokeDasharray: dotted ? '4 3' : undefined,
        },
        labelStyle: {
          fill: 'var(--rf-edge-label, #475569)',
          fontSize: 12,
        },
        labelBgStyle: {
          fill: 'var(--rf-edge-label-bg, #ffffff)',
          fillOpacity: 0.9,
        },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 3,
      }
    })

  const graph = g.graph()
  return {
    nodes: rfNodes,
    edges: rfEdges,
    direction,
    width: graph.width ?? 600,
    height: graph.height ?? 400,
  }
}

/** Map a mermaid vertex shape onto a minimal CSS treatment for the React-Flow node. */
function nodeStyleFor(shape: string | undefined): CSSProperties {
  const base: CSSProperties = {
    padding: '8px 12px',
    borderRadius: 6,
    border: '1px solid var(--rf-node-border, #94a3b8)',
    background: 'var(--rf-node-bg, #ffffff)',
    color: 'var(--rf-node-fg, #1e293b)',
    fontSize: 13,
    textAlign: 'center',
  }
  switch (shape) {
    case 'round':
    case 'stadium':
      return { ...base, borderRadius: 999 }
    case 'circle':
    case 'doublecircle':
      return { ...base, borderRadius: '50%' }
    case 'diamond':
      // We can't easily clip-path the underlying React-Flow node, but a tinted
      // background with a dashed border is enough of a visual cue.
      return { ...base, borderStyle: 'dashed' }
    case 'cylinder':
      return { ...base, borderRadius: 12, borderStyle: 'double', borderWidth: 3 }
    case 'subroutine':
      return { ...base, boxShadow: 'inset 4px 0 0 var(--rf-node-border, #94a3b8), inset -4px 0 0 var(--rf-node-border, #94a3b8)' }
    case 'hexagon':
      return { ...base, transform: 'skewX(-8deg)' }
    default:
      return base
  }
}
