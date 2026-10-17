import { useEffect, useState, useMemo } from "react";
import { adminApi, type DbTableSummary, type DbTableData } from "../api/admin";

export default function DatabaseViewerPage() {
  const [tables, setTables] = useState<DbTableSummary[]>([]);
  const [loadingTables, setLoadingTables] = useState(true);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"data" | "schema" | "json">("data");

  const [tableData, setTableData] = useState<DbTableData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [tableSearch, setTableSearch] = useState("");
  const [jsonModalValue, setJsonModalValue] = useState<{ title: string; data: any } | null>(null);

  // Load all tables on mount
  function loadTables(preferredTable?: string) {
    setLoadingTables(true);
    adminApi
      .getDatabaseTables()
      .then((res) => {
        setTables(res);
        if (res.length > 0) {
          // Keep current selection if valid, or prefer one with data, or first table
          const target = preferredTable || selectedTable || (res.find((t) => t.count > 0)?.name ?? res[0].name);
          setSelectedTable(target);
        }
      })
      .catch((err) => {
        console.error("Failed to load DB tables:", err);
      })
      .finally(() => setLoadingTables(false));
  }

  useEffect(() => {
    loadTables();
  }, []);

  // Load table rows whenever selectedTable changes
  useEffect(() => {
    if (!selectedTable) return;
    setLoadingData(true);
    setSearchTerm("");
    adminApi
      .getTableData(selectedTable, 200, 0)
      .then((data) => {
        setTableData(data);
      })
      .catch((err) => {
        console.error(`Failed to load data for ${selectedTable}:`, err);
        setTableData(null);
      })
      .finally(() => setLoadingData(false));
  }, [selectedTable]);

  const selectedTableSummary = useMemo(() => {
    return tables.find((t) => t.name === selectedTable);
  }, [tables, selectedTable]);

  // Filtered rows for client search
  const filteredRows = useMemo(() => {
    if (!tableData?.rows) return [];
    if (!searchTerm.trim()) return tableData.rows;
    const term = searchTerm.toLowerCase();
    return tableData.rows.filter((row) =>
      Object.entries(row).some(([_, val]) => {
        if (val === null || val === undefined) return false;
        if (typeof val === "object") return JSON.stringify(val).toLowerCase().includes(term);
        return String(val).toLowerCase().includes(term);
      })
    );
  }, [tableData, searchTerm]);

  // Filtered tables list in sidebar
  const filteredTables = useMemo(() => {
    if (!tableSearch.trim()) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(tableSearch.toLowerCase()));
  }, [tables, tableSearch]);

  function exportTableJson() {
    if (!tableData) return;
    const blob = new Blob([JSON.stringify(tableData.rows, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedTable || "table"}_export.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-gray-900">Database Tables & Schema</h1>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">
              PostgreSQL Live
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            Complete inspect view of all database tables, exact schema definitions, columns, and raw stored records.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (selectedTable) {
                setLoadingData(true);
                adminApi.getTableData(selectedTable, 200, 0).then(setTableData).finally(() => setLoadingData(false));
              }
              loadTables(selectedTable || undefined);
            }}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 shadow-sm transition"
            title="Refresh database records"
          >
            <svg className={`w-4 h-4 ${loadingData || loadingTables ? "animate-spin text-blue-600" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
          {tableData && tableData.rows.length > 0 && (
            <button
              onClick={exportTableJson}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export JSON
            </button>
          )}
        </div>
      </div>

      {/* Main Grid: Sidebar Tables + Content Area */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
        {/* Left Sidebar: Tables List */}
        <div className="lg:col-span-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-100 bg-gray-50/70">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-500">
                Tables ({tables.length})
              </span>
              <span className="text-xs text-gray-400">public schema</span>
            </div>
            <input
              type="text"
              placeholder="Search table name..."
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              className="w-full text-xs px-2.5 py-1.5 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          <div className="max-h-[calc(100vh-280px)] overflow-y-auto divide-y divide-gray-100">
            {loadingTables && tables.length === 0 ? (
              <div className="p-4 text-center text-xs text-gray-400">Loading tables...</div>
            ) : filteredTables.length === 0 ? (
              <div className="p-4 text-center text-xs text-gray-400">No tables match search</div>
            ) : (
              filteredTables.map((tbl) => {
                const isSelected = selectedTable === tbl.name;
                const hasData = tbl.count > 0;
                return (
                  <button
                    key={tbl.name}
                    onClick={() => setSelectedTable(tbl.name)}
                    className={`w-full text-left px-3.5 py-2.5 text-xs flex items-center justify-between transition ${
                      isSelected
                        ? "bg-blue-50 text-blue-900 font-semibold border-l-4 border-blue-600 pl-2.5"
                        : "hover:bg-gray-50 text-gray-700"
                    }`}
                  >
                    <span className="truncate pr-2 font-mono">{tbl.name}</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        hasData
                          ? "bg-emerald-100 text-emerald-800 font-bold border border-emerald-200"
                          : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {tbl.count}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Area: Selected Table Viewer */}
        <div className="lg:col-span-3 space-y-4">
          {selectedTable ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              {/* Table Top Bar */}
              <div className="p-4 border-b border-gray-200 flex flex-col md:flex-row md:items-center justify-between gap-3 bg-gray-50/50">
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-blue-100 text-blue-700 rounded-lg">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7zM4 11h16M9 4v16" />
                    </svg>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold font-mono text-gray-900">{selectedTable}</span>
                      <span className="px-2 py-0.5 rounded text-xs font-semibold bg-gray-100 text-gray-600 border border-gray-200">
                        {tableData?.total ?? selectedTableSummary?.count ?? 0} rows
                      </span>
                      <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">
                        {tableData?.columns.length ?? selectedTableSummary?.columns.length ?? 0} columns
                      </span>
                    </div>
                  </div>
                </div>

                {/* View Tabs */}
                <div className="flex items-center gap-1 bg-gray-200/70 p-1 rounded-lg text-xs font-medium">
                  <button
                    onClick={() => setActiveTab("data")}
                    className={`px-3 py-1.5 rounded-md transition ${
                      activeTab === "data" ? "bg-white text-gray-900 shadow-sm font-semibold" : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Table Rows ({filteredRows.length})
                  </button>
                  <button
                    onClick={() => setActiveTab("schema")}
                    className={`px-3 py-1.5 rounded-md transition ${
                      activeTab === "schema" ? "bg-white text-gray-900 shadow-sm font-semibold" : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Schema & Fields ({tableData?.columns.length || 0})
                  </button>
                  <button
                    onClick={() => setActiveTab("json")}
                    className={`px-3 py-1.5 rounded-md transition ${
                      activeTab === "json" ? "bg-white text-gray-900 shadow-sm font-semibold" : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    Raw JSON
                  </button>
                </div>
              </div>

              {/* Sub-bar for Row search */}
              {activeTab === "data" && tableData && tableData.rows.length > 0 && (
                <div className="px-4 py-2.5 border-b border-gray-100 bg-white flex items-center justify-between gap-4">
                  <div className="relative flex-1 max-w-sm">
                    <input
                      type="text"
                      placeholder={`Search in ${selectedTable} rows...`}
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full text-xs pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <svg className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <div className="text-xs text-gray-500">
                    Showing {filteredRows.length} of {tableData.total} records
                  </div>
                </div>
              )}

              {/* Tab 1: Live Data Grid */}
              {activeTab === "data" && (
                <div>
                  {loadingData ? (
                    <div className="py-20 text-center text-sm text-gray-500 flex flex-col items-center justify-center gap-3">
                      <svg className="w-6 h-6 animate-spin text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Loading table records from database...
                    </div>
                  ) : !tableData || tableData.rows.length === 0 ? (
                    <div className="py-16 text-center text-sm text-gray-400 space-y-2">
                      <div className="text-gray-300 text-3xl font-mono">0</div>
                      <p className="font-medium text-gray-600">Table is currently empty</p>
                      <p className="text-xs text-gray-400">No records have been inserted into '{selectedTable}' yet.</p>
                    </div>
                  ) : filteredRows.length === 0 ? (
                    <div className="py-12 text-center text-sm text-gray-500">
                      No records matched "{searchTerm}"
                    </div>
                  ) : (
                    <div className="overflow-x-auto max-h-[600px] border-t border-gray-100">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-gray-100/90 sticky top-0 z-10 shadow-sm backdrop-blur-sm">
                          <tr>
                            <th className="px-3 py-2.5 font-bold text-gray-600 border-b border-gray-200 w-12 text-center">#</th>
                            {tableData.columns.map((col) => (
                              <th
                                key={col.name}
                                className="px-3.5 py-2.5 font-bold text-gray-700 border-b border-gray-200 whitespace-nowrap"
                              >
                                <div className="flex flex-col">
                                  <span className="font-mono text-gray-900">{col.name}</span>
                                  <span className="text-[10px] text-gray-400 font-normal">{col.udt}</span>
                                </div>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 font-mono">
                          {filteredRows.map((row, idx) => (
                            <tr key={idx} className="hover:bg-blue-50/30 transition">
                              <td className="px-3 py-2 text-center text-gray-400 font-sans text-[11px] select-none bg-gray-50/50">
                                {idx + 1}
                              </td>
                              {tableData.columns.map((col) => {
                                const val = row[col.name];
                                return (
                                  <td
                                    key={col.name}
                                    className="px-3.5 py-2 text-gray-800 max-w-xs truncate whitespace-nowrap align-middle"
                                  >
                                    {renderCell(col.name, val, setJsonModalValue)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Table Schema Definition */}
              {activeTab === "schema" && (
                <div className="p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs text-gray-500">
                      Complete column schema definitions as defined in PostgreSQL <code className="font-mono text-blue-700">information_schema.columns</code>.
                    </span>
                  </div>
                  <div className="overflow-x-auto border border-gray-200 rounded-lg">
                    <table className="w-full text-left text-xs divide-y divide-gray-200">
                      <thead className="bg-gray-50 font-semibold text-gray-700">
                        <tr>
                          <th className="px-3.5 py-2.5 w-12 text-center">#</th>
                          <th className="px-3.5 py-2.5">Field / Column Name</th>
                          <th className="px-3.5 py-2.5">Data Type</th>
                          <th className="px-3.5 py-2.5">UDT Name</th>
                          <th className="px-3.5 py-2.5">Nullable</th>
                          <th className="px-3.5 py-2.5">Default Value</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 font-mono">
                        {tableData?.columns.map((col, idx) => (
                          <tr key={col.name} className="hover:bg-gray-50">
                            <td className="px-3.5 py-2 text-center text-gray-400 font-sans">{idx + 1}</td>
                            <td className="px-3.5 py-2 font-bold text-gray-900">{col.name}</td>
                            <td className="px-3.5 py-2 text-blue-700">{col.type}</td>
                            <td className="px-3.5 py-2 text-purple-700">{col.udt}</td>
                            <td className="px-3.5 py-2">
                              {col.nullable ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-100 text-yellow-800">YES</span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800 font-bold">NO (NOT NULL)</span>
                              )}
                            </td>
                            <td className="px-3.5 py-2 text-gray-500 text-[11px] truncate max-w-sm">
                              {col.default || <span className="text-gray-300 italic">none</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Tab 3: Raw JSON */}
              {activeTab === "json" && (
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-500 font-medium">Raw JSON output ({tableData?.rows.length || 0} items)</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(tableData?.rows, null, 2));
                        alert("Copied table JSON to clipboard!");
                      }}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      Copy to Clipboard
                    </button>
                  </div>
                  <pre className="p-4 bg-gray-900 text-emerald-400 rounded-lg text-xs font-mono overflow-auto max-h-[500px]">
                    {JSON.stringify(tableData?.rows, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="p-12 text-center text-gray-400 bg-white rounded-xl border border-gray-200">
              Select a table from the list to view its stored data and schema.
            </div>
          )}
        </div>
      </div>

      {/* JSON Viewer Modal */}
      {jsonModalValue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl max-w-2xl w-full p-6 space-y-4 shadow-xl border border-gray-200 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-2 border-b border-gray-100">
              <h3 className="font-bold text-gray-900 font-mono text-sm">{jsonModalValue.title}</h3>
              <button
                onClick={() => setJsonModalValue(null)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded-lg"
              >
                ✕
              </button>
            </div>
            <pre className="p-4 bg-gray-900 text-emerald-400 rounded-lg text-xs font-mono overflow-auto max-h-[400px]">
              {JSON.stringify(jsonModalValue.data, null, 2)}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(jsonModalValue.data, null, 2));
                  alert("Copied JSON to clipboard!");
                }}
                className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                Copy JSON
              </button>
              <button
                onClick={() => setJsonModalValue(null)}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function renderCell(
  colName: string,
  val: any,
  onOpenJson: (modal: { title: string; data: any }) => void
) {
  if (val === null || val === undefined) {
    return <span className="text-gray-300 italic font-sans text-[11px]">null</span>;
  }
  if (typeof val === "boolean") {
    return val ? (
      <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-100 text-emerald-800 font-bold">true</span>
    ) : (
      <span className="px-1.5 py-0.5 rounded text-[10px] bg-rose-100 text-rose-800 font-bold">false</span>
    );
  }
  if (typeof val === "object") {
    return (
      <button
        onClick={() => onOpenJson({ title: colName, data: val })}
        className="px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-blue-700 text-[11px] font-mono transition inline-flex items-center gap-1 border border-gray-200"
      >
        <span>{Array.isArray(val) ? `[${val.length} items]` : "{object}"}</span>
        <span className="text-gray-400 text-[9px]">view</span>
      </button>
    );
  }
  const str = String(val);
  // Detect date strings
  if (colName.includes("_at") || colName.includes("time") || colName.includes("date")) {
    const d = new Date(str);
    if (!isNaN(d.getTime()) && str.length >= 10) {
      return (
        <span title={str} className="text-gray-700 text-[11px]">
          {d.toLocaleString()}
        </span>
      );
    }
  }
  return <span title={str}>{str}</span>;
}
