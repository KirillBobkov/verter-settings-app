import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base = имя репозитория на GitHub Pages.
// При переезде на кастомный домен: base: '/' + public/CNAME.
export default defineConfig({
  base: '/verter-settings-app/',
  plugins: [react()],
})
