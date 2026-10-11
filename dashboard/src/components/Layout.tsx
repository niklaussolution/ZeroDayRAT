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

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-primary-dark text-white px-6 py-4 flex items-center justify-between shadow-md">
        <div className="flex items-center gap-8">
          <Link to={user?.role === "super_admin" ? "/admin" : "/devices"} className="text-lg font-bold tracking-tight hover:text-gray-200 transition">
            Spapp Monitor
          </Link>
          {user?.role === "super_admin" && (
            <nav className="flex items-center gap-2 text-sm">
              <Link
                to="/admin"
                className={`px-3 py-1.5 rounded-md font-medium transition ${
                  location.pathname.startsWith("/admin")
                    ? "bg-white/20 text-white shadow-sm"
                    : "text-gray-300 hover:text-white hover:bg-white/10"
                }`}
              >
                Tenants Admin
              </Link>
              <Link
                to="/devices"
                className={`px-3 py-1.5 rounded-md font-medium transition ${
                  location.pathname.startsWith("/devices")
                    ? "bg-white/20 text-white shadow-sm"
                    : "text-gray-300 hover:text-white hover:bg-white/10"
                }`}
              >
                All Devices
              </Link>
            </nav>
          )}
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
      <main className="max-w-6xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

