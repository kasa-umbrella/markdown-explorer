# build/ — electron-builder リソース置き場

electron-builder が既定で参照するディレクトリ。配布アプリのアイコンはここに置く。

## アプリアイコン

このフォルダに以下を置くと `npm run dist` で .app / .dmg のアイコンになる
（package.json の `build.mac.icon` でも明示済み）。

- `icon.png` … **1024×1024 の正方形 PNG**（推奨。builder が自動で .icns 化）
- もしくは `icon.icns` を直接置く

favicon（public/favicon.svg）はWeb用で、アプリアイコンにはならない。
