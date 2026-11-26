import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// jsxImportSource: স্ক্রিনের বাংলা লেখা ভাষা অনুযায়ী অনুবাদ করার নিজস্ব JSX রানটাইম (src/i18n-jsx)
export default defineConfig({
  plugins: [react({ jsxImportSource: 'i18n-jsx' }), tailwindcss()],
  resolve: { alias: { 'i18n-jsx': fileURLToPath(new URL('./src/i18n-jsx', import.meta.url)) } },
})
