import { useMemo, useState } from 'react'
import { useDirectory } from './hooks/useDirectory'
import { useContentSearch } from './hooks/useContentSearch'
import { filterTree } from './lib/filterTree'
import { TreeView } from './components/TreeView'
import { SearchResults } from './components/SearchResults'
import { Preview } from './components/Preview'
import iconUrl from '../build/icon.png'
import './App.css'

/** Search either by file name or by file contents. */
type SearchMode = 'name' | 'content'

/** Stable empty map so the content-search hook has consistent deps before a scan. */
const NO_FILES = new Map<string, FileSystemFileHandle>()

export default function App() {
  const dir = useDirectory()
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('name')

  const filtered = useMemo(() => {
    if (!dir.scan) return null
    return filterTree(dir.scan.tree, query)
  }, [dir.scan, query])

  const trimmed = query.trim()
  const search = useContentSearch(
    dir.scan?.files ?? NO_FILES,
    query,
    mode === 'content' && dir.status === 'ready',
  )
  // Show the content-search results panel instead of the tree.
  const showResults = mode === 'content' && trimmed.length > 0

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="title-row">
            <strong className="app-name">
              <img className="app-icon" src={iconUrl} alt="" />
              MD探索家
            </strong>
          </div>
          {dir.status === 'ready' && dir.scan && (
            <>
              <div className="root-row" title={dir.rootName ?? ''}>
                <span className="root-name">{dir.rootName}</span>
                <span className="count">{dir.scan.markdownCount} 個にゃん</span>
              </div>
              <div className="toolbar">
                <input
                  className="search"
                  type="search"
                  placeholder={mode === 'content' ? '中身を検索するにゃん' : 'ファイル名で絞り込むにゃん'}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button className="icon-btn" title="読み直すにゃん" onClick={() => dir.rescan()}>
                  ⟳
                </button>
                <button className="icon-btn" title="別のフォルダを開くにゃん" onClick={() => dir.choose()}>
                  📂
                </button>
              </div>
              <div className="mode-toggle" role="group" aria-label="検索モード">
                <button
                  className={`mode-btn${mode === 'name' ? ' active' : ''}`}
                  onClick={() => setMode('name')}
                >
                  名前
                </button>
                <button
                  className={`mode-btn${mode === 'content' ? ' active' : ''}`}
                  onClick={() => setMode('content')}
                >
                  中身
                </button>
              </div>
            </>
          )}
        </header>

        <nav className="tree-scroll">
          {showResults ? (
            search.status === 'indexing' ? (
              <p className="hint">せっせと読んでるにゃん</p>
            ) : (
              <SearchResults
                matches={search.matches}
                query={query}
                selectedPath={selected}
                onSelect={setSelected}
              />
            )
          ) : filtered ? (
            filtered.children && filtered.children.length > 0 ? (
              <TreeView
                node={filtered}
                selectedPath={selected}
                onSelect={setSelected}
                forceExpand={mode === 'name' && trimmed.length > 0}
              />
            ) : (
              <p className="hint">お探しの .md、見つからなかったにゃ</p>
            )
          ) : null}
        </nav>
      </aside>

      <main className="main">
        {dir.status === 'ready' ? (
          <Preview path={selected} files={dir.scan!.files} onNavigate={setSelected} />
        ) : (
          <Gate dir={dir} />
        )}
      </main>
    </div>
  )
}

function Gate({ dir }: { dir: ReturnType<typeof useDirectory> }) {
  if (!dir.supported) {
    return (
      <div className="gate">
        <h1>このブラウザ、ちょっと無理にゃ</h1>
        <p>File System Access API が要るにゃ。Chrome 系のブラウザで開いてにゃ。</p>
      </div>
    )
  }
  if (dir.status === 'restoring') {
    return (
      <div className="gate">
        <p>この前のフォルダ、思い出してるにゃん</p>
      </div>
    )
  }
  if (dir.status === 'need-permission') {
    return (
      <div className="gate">
        <h1>許可がほしいにゃ</h1>
        <p>
          <strong>{dir.rootName}</strong> のこと、まだ覚えてるにゃ。読む許可がほしいにゃ。
        </p>
        <button className="primary" onClick={() => dir.grant()}>
          このフォルダを開くにゃん
        </button>
        <button className="ghost" onClick={() => dir.reset()}>
          忘れて選び直すにゃん
        </button>
      </div>
    )
  }
  if (dir.status === 'scanning') {
    return (
      <div className="gate">
        <p>「{dir.rootName}」を覗いてるにゃん</p>
      </div>
    )
  }
  if (dir.status === 'error') {
    return (
      <div className="gate">
        <h1>なにかおかしいにゃ</h1>
        <pre className="err">{dir.error}</pre>
        <button className="primary" onClick={() => dir.choose()}>
          フォルダを選ぶにゃん
        </button>
      </div>
    )
  }
  // idle
  return (
    <div className="gate">
      <h1>
        <img className="gate-icon" src={iconUrl} alt="" />
        MD探索家
      </h1>
      <p>フォルダをひとつ選んでにゃん。中の .md をぜんぶ並べて読ませてあげるにゃん。</p>
      <button className="primary" onClick={() => dir.choose()}>
        フォルダを選ぶにゃん
      </button>
      <p className="fine">選んだフォルダは覚えてるから、次はワンタッチで開くにゃん。</p>
    </div>
  )
}
