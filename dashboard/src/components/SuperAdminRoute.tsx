import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/** Guards /admin — accessible by super_admin and tenant owner accounts. */
export default function SuperAdminRoute() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  const isAdmin = user.role === "super_admin" || user.role === "owner";
  if (!isAdmin) return <Navigate to="/devices" replace />;
  return <Outlet />;
}
