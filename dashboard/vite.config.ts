import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import https from 'node:https'

// Controlled connection pool prevents TCP handshake storms that trigger Nginx SYN rate-limiting
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  maxFreeSockets: 4,
  timeout: 60000,
  rejectUnauthorized: false,
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
        secure: false,
        agent,
      },
    },
  },
})
