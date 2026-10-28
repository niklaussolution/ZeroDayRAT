import { Link } from "react-router-dom";

export default function CustomAppsPage() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb Header */}
      <div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <Link to="/devices" className="text-accent hover:underline">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Custom Apps</span>
        </div>
        <h1 className="text-2xl font-bold text-primary-dark">Custom Apps</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Workspace ready for your new custom app flow and configuration.
        </p>
      </div>

      {/* Clean Slate Placeholder */}
      <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center shadow-xs">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center text-3xl font-bold shadow-xs">
          ⚡
        </div>
        <h2 className="text-lg font-bold text-gray-800">Clean Slate Initialized</h2>
        <p className="text-sm text-gray-500 max-w-md mx-auto mt-1">
          Previous flow has been completely cleared out. Ready to implement your new requirements from the beginning.
        </p>
      </div>
    </div>
  );
}
