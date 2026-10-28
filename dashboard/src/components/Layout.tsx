import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  const isSuperAdmin = user?.role === "super_admin";

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary-dark text-white px-6 py-4 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-8">
          <Link to={isSuperAdmin ? "/admin" : "/devices"} className="text-lg font-bold tracking-tight hover:text-gray-200 transition">
            Spapp Monitor
          </Link>
          <nav className="flex items-center gap-2 text-sm">
            {isSuperAdmin && (
              <Link
                to="/admin"
                className={`px-3 py-1.5 rounded-md font-medium transition ${
                  location.pathname === "/admin" || (location.pathname.startsWith("/admin") && !location.pathname.startsWith("/admin/database"))
                    ? "bg-white/20 text-white shadow-sm"
                    : "text-gray-300 hover:text-white hover:bg-white/10"
                }`}
              >
                Tenants Admin
              </Link>
            )}
            <Link
              to="/devices"
              className={`px-3 py-1.5 rounded-md font-medium transition ${
                location.pathname.startsWith("/devices") && !location.pathname.includes("/custom-apps")
                  ? "bg-white/20 text-white shadow-sm"
                  : "text-gray-300 hover:text-white hover:bg-white/10"
              }`}
            >
              {isSuperAdmin ? "All Devices" : "Devices"}
            </Link>
            <Link
              to="/custom-apps"
              className={`px-3 py-1.5 rounded-md font-medium transition ${
                location.pathname.startsWith("/custom-apps") || location.pathname.includes("/custom-apps")
                  ? "bg-white/20 text-white shadow-sm"
                  : "text-gray-300 hover:text-white hover:bg-white/10"
              }`}
            >
              Custom Apps
            </Link>
            {isSuperAdmin && (
              <Link
                to="/admin/database"
                className={`px-3 py-1.5 rounded-md font-medium transition ${
                  location.pathname.startsWith("/admin/database")
                    ? "bg-white/20 text-white shadow-sm"
                    : "text-gray-300 hover:text-white hover:bg-white/10"
                }`}
              >
                DB Table
              </Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
            <span className="text-gray-300 font-medium">
              {user?.role === "super_admin" ? "Super admin" : user?.tenantName}
            </span>
            {user?.email && <span className="text-gray-400 text-xs">({user.email})</span>}
          </div>
          <button onClick={handleLogout} className="text-gray-300 hover:text-white transition px-2 py-1 rounded hover:bg-white/10">
            Sign out
          </button>
        </div>
      </header>
      <main className={`mx-auto px-6 py-8 transition-all ${location.pathname.startsWith("/admin/database") ? "max-w-[1700px]" : "max-w-6xl"}`}>
        <Outlet />
      </main>
    </div>
  );
}

