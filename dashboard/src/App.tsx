import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import SuperAdminRoute from "./components/SuperAdminRoute";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import DevicesListPage from "./pages/DevicesListPage";
import ConnectPage from "./pages/ConnectPage";
import DeviceDetailPage from "./pages/DeviceDetailPage";
import DeviceArchivePage from "./pages/DeviceArchivePage";
import AdminPage from "./pages/AdminPage";
import DatabaseViewerPage from "./pages/DatabaseViewerPage";
import ScreenStreamPage from "./pages/ScreenStreamPage";
import CameraStreamPage from "./pages/CameraStreamPage";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/connect" element={<ConnectPage />} />

          <Route element={<ProtectedRoute />}>
            <Route path="/devices/:id/screen-stream" element={<ScreenStreamPage />} />
            <Route path="/devices/:id/camera-stream" element={<CameraStreamPage />} />
            <Route element={<Layout />}>
              <Route path="/devices" element={<DevicesListPage />} />
              <Route path="/devices/:id" element={<DeviceDetailPage />} />
              <Route path="/devices/:id/archive" element={<DeviceArchivePage />} />
            </Route>
          </Route>

          <Route element={<SuperAdminRoute />}>
            <Route element={<Layout />}>
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/admin/database" element={<DatabaseViewerPage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/devices" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
