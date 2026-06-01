import { useMemo, useState } from 'react'
import { useDirectory } from './hooks/useDirectory'
import { filterTree } from './lib/filterTree'
import { TreeView } from './components/TreeView'
import { Preview } from './components/Preview'
import './App.css'

export default function App() {
  const dir = useDirectory()
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!dir.scan) return null
    return filterTree(dir.scan.tree, query)
  }, [dir.scan, query])

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="title-row">
            <strong className="app-name">📚 Markdown Explorer</strong>
          </div>
          {dir.status === 'ready' && dir.scan && (
            <>
              <div className="root-row" title={dir.rootName ?? ''}>
                <span className="root-name">{dir.rootName}</span>
                <span className="count">{dir.scan.markdownCount} md</span>
              </div>
              <div className="toolbar">
                <input
                  className="search"
                  type="search"
                  placeholder="ファイル名で絞り込み…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button className="icon-btn" title="再走査" onClick={() => dir.rescan()}>
                  ⟳
                </button>
                <button className="icon-btn" title="別のフォルダ" onClick={() => dir.choose()}>
                  📂
                </button>
              </div>
            </>
          )}
        </header>

        <nav className="tree-scroll">
          {filtered ? (
            filtered.children && filtered.children.length > 0 ? (
              <TreeView
                node={filtered}
                selectedPath={selected}
                onSelect={setSelected}
                forceExpand={query.trim().length > 0}
              />
            ) : (
              <p className="hint">該当する .md は無い、ね。</p>
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
        <h1>未対応のブラウザ</h1>
        <p>File System Access API が要る、の。Chrome 系で開いて。</p>
      </div>
    )
  }
  if (dir.status === 'restoring') {
    return (
      <div className="gate">
        <p>前回のフォルダを、思い出してる……。</p>
      </div>
    )
  }
  if (dir.status === 'need-permission') {
    return (
      <div className="gate">
        <h1>許可が、要る</h1>
        <p>
          前回の <strong>{dir.rootName}</strong> を覚えてる、よ。読み取りを、許可して。
        </p>
        <button className="primary" onClick={() => dir.grant()}>
          このフォルダを開く
        </button>
        <button className="ghost" onClick={() => dir.reset()}>
          忘れて選び直す
        </button>
      </div>
    )
  }
  if (dir.status === 'scanning') {
    return (
      <div className="gate">
        <p>{dir.rootName} を、走査してる……。</p>
      </div>
    )
  }
  if (dir.status === 'error') {
    return (
      <div className="gate">
        <h1>つまずいた</h1>
        <pre className="err">{dir.error}</pre>
        <button className="primary" onClick={() => dir.choose()}>
          フォルダを選ぶ
        </button>
      </div>
    )
  }
  // idle
  return (
    <div className="gate">
      <h1>📚 Markdown Explorer</h1>
      <p>ローカルのフォルダを選ぶ、と。中の .md を一覧して、ここで読める、よ。</p>
      <button className="primary" onClick={() => dir.choose()}>
        フォルダを選ぶ
      </button>
      <p className="fine">選んだフォルダは記憶する。次からは一発で開く、よ。</p>
    </div>
  )
}
