import axios from "axios";

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "https://spapp-monitoring-backend.onrender.com";

// Local backend URL (used specifically if local build engines are invoked)
export const LOCAL_API_BASE_URL = "http://localhost:4000";

// Same-origin WebSocket base for the file-transfer relay (backend/src/ws/fileRelay.js).
export const WS_BASE_URL = API_BASE_URL.replace(/^http/, "ws");

export const apiClient = axios.create({ baseURL: API_BASE_URL });

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
