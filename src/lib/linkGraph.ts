import type Token from 'markdown-it/lib/token.mjs'
import { md } from './markdown'
import { readTextFile } from './fsAccess'
import { isMarkdownLink, resolveRelative } from './paths'
import type { ScanResult } from '../types'

export interface LinkEdge {
  source: string
  target: string
}

export interface LinkGraph {
  nodes: string[]
  edges: LinkEdge[]
}

const MD_EXT = /\.(md|markdown|mdown|mkd)$/i

function collectLinkTargets(source: string, fromPath: string): string[] {
  const targets = new Set<string>()
  const tokens = md.parse(source, {})

  const walk = (toks: Token[]): void => {
    for (const tok of toks) {
      if (tok.type === 'link_open') {
        const href = tok.attrGet('href') ?? ''
        if (href && isMarkdownLink(href)) {
          const clean = href.split('#')[0].split('?')[0]
          if (clean) {
            const resolved = resolveRelative(fromPath, clean)
            if (resolved) targets.add(resolved)
          }
        }
      }
      if (tok.children && tok.children.length > 0) walk(tok.children)
    }
  }
  walk(tokens)
  return Array.from(targets)
}

/**
 * Build a directed graph of .md → .md references inside a scanned folder.
 * Nodes are the relative paths of every Markdown file. Edges are emitted only
 * when both endpoints exist in the scan (broken links are silently dropped).
 */
export async function buildLinkGraph(scan: ScanResult): Promise<LinkGraph> {
  const nodes: string[] = []
  for (const path of scan.files.keys()) {
    if (MD_EXT.test(path)) nodes.push(path)
  }
  nodes.sort()

  const nodeSet = new Set(nodes)
  const edges: LinkEdge[] = []

  await Promise.all(
    nodes.map(async (path) => {
      try {
        const text = await readTextFile(scan.files, path)
        for (const target of collectLinkTargets(text, path)) {
          if (nodeSet.has(target) && target !== path) {
            edges.push({ source: path, target })
          }
        }
      } catch {
        // A single unreadable file shouldn't break the whole graph build.
      }
    }),
  )

  return { nodes, edges }
}
