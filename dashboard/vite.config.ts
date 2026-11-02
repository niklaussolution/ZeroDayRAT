import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import https from 'node:https'

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 30,
  maxFreeSockets: 10,
  timeout: 30000,
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same reasoning as vercel.json's /api rewrite — proxy server-side so
      // the browser sees a same-origin request and never runs a CORS check.
      "/api": {
        target: "https://api2.nikaipro.com",
        changeOrigin: true,
        secure: true,
        agent,
      },
    },
  },
})
