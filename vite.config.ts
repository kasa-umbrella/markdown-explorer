import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

// https://vite.dev/config/
export default defineConfig({
  // app:// / file:// どちらでも資産を解決できるよう相対パスで吐く
  base: './',
  plugins: [
    react(),
    electron({
      main: { entry: 'electron/main.ts' },
    }),
  ],
})
