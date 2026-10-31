import axios from "axios";

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "https://spapp-monitoring-backend.onrender.com";

// Local backend URL (used specifically if local build engines are invoked)
export const LOCAL_API_BASE_URL = "http://localhost:4000";

// WebSocket connections (file-transfer/screen/camera relays) go straight to the
// real backend — Vercel/Vite's "/api" rewrite below only proxies plain HTTP
// requests, and WS handshakes aren't subject to the browser's CORS checks the
// way XHR/fetch is, so there's no same-origin requirement here.
export const WS_BASE_URL = API_BASE_URL.replace(/^http/, "ws");

// XHR/fetch calls go through the current origin's "/api" path instead of the
// absolute cross-origin backend URL, so the browser never performs a CORS
// preflight/origin check at all. Both Vercel (vercel.json rewrites) and the
// Vite dev server (vite.config.ts proxy) forward "/api/*" to API_BASE_URL
// server-side — this sidesteps a CyberPanel/OpenLiteSpeed proxy quirk that
// was duplicating the Access-Control-Allow-Origin response header.
export const apiClient = axios.create({ baseURL: "" });

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("spapp_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("spapp_token");
      localStorage.removeItem("spapp_user");
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);
