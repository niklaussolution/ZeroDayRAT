import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same reasoning as vercel.json's /api rewrite — proxy server-side so
      // the browser sees a same-origin request and never runs a CORS check.
      "/api": {
        target: "https://api.nikaipro.com",
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
