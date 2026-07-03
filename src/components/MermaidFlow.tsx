// Interactive renderer for mermaid `flowchart` / `graph` blocks.
// Parses via mermaid's own parser, lays out with dagre, then hands the result
// to React-Flow so users can drag nodes, pan, and zoom when a static SVG is
// too cramped to read.

import { useEffect, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { parseFlowchart, type ParsedFlowchart } from '../lib/mermaidFlow'
import { renderMermaid } from '../lib/mermaid'
import { useRawHtml } from '../lib/rawHtml'

interface Props {
  source: string
}

const MIN_HEIGHT = 240
const MAX_HEIGHT = 720

export function MermaidFlow({ source }: Props) {
  // Track which source the current state corresponds to. When the prop changes
  // we reset display state during render (not in an effect) so the user never
  // sees the previous graph flash while the new one parses.
  const [sourceKey, setSourceKey] = useState(source)
  const [parsed, setParsed] = useState<ParsedFlowchart | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [fallbackSvg, setFallbackSvg] = useState<string | null>(null)

  if (sourceKey !== source) {
    setSourceKey(source)
    setParsed(null)
    setStatus('loading')
    setFallbackSvg(null)
  }

  // Stable {__html} so React 19's identity-diff doesn't re-set the fallback SVG's
  // innerHTML on unrelated re-renders (see useRawHtml).
  const fallbackHtml = useRawHtml(fallbackSvg ?? '')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await parseFlowchart(source)
      if (cancelled) return
      if (result && result.nodes.length > 0) {
        setParsed(result)
        setStatus('ready')
        return
      }
      // Parser bailed (subgraphs, unsupported shapes, or a non-flowchart that
      // slipped past isFlowchart()). Render the static SVG as a fallback so
      // the user still sees their diagram.
      try {
        const svg = await renderMermaid(source)
        if (cancelled) return
        setFallbackSvg(svg)
      } catch {
        /* swallow — error UI below */
      }
      if (!cancelled) setStatus('failed')
    })()
    return () => {
      cancelled = true
    }
  }, [source])

  if (status === 'loading') {
    return (
      <div className="mermaid-flow loading" aria-busy="true">
        グラフを、組み立てて、いる……。
      </div>
    )
  }

  if (status === 'failed' || !parsed) {
    if (fallbackSvg) {
      return (
        <div
          className="mermaid mermaid-flow-fallback"
          dangerouslySetInnerHTML={fallbackHtml}
        />
      )
    }
    return <div className="mermaid-error">この flowchart は描画できませんでした。</div>
  }

  // Reserve enough height for dagre's reported layout, but clamp so the
  // canvas never grows beyond a comfortable in-page viewport.
  const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, parsed.height + 80))

  return (
    <div className="mermaid-flow" style={{ height }}>
      <ReactFlowProvider>
        <ReactFlow
          defaultNodes={parsed.nodes}
          defaultEdges={parsed.edges}
          // `fitView` on first paint so the user sees the whole graph regardless
          // of pane size. Subsequent drags don't re-fit.
          onInit={(inst) => {
            requestAnimationFrame(() => inst.fitView({ padding: 0.15 }))
          }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          panOnDrag
          zoomOnScroll
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
