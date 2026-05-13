import { useState, useEffect, useCallback } from "react";
import { getZohoStatus } from "../services/api";

const STATUS_COLORS = {
  active:    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  submitted: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  draft:     "bg-slate-100 text-slate-600 dark:bg-gray-700 dark:text-gray-300",
  unknown:   "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  open:      "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  paid:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  void:      "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300",
};

function StatusBadge({ status }) {
  const cls = STATUS_COLORS[status?.toLowerCase()] || STATUS_COLORS.unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {status || "—"}
    </span>
  );
}

function MetricCard({ label, value, sub, color = "blue" }) {
  const colors = {
    blue:  "from-blue-50 to-blue-100/60 border-blue-100 dark:from-blue-950/30 dark:to-blue-900/20 dark:border-blue-900/40",
    green: "from-emerald-50 to-emerald-100/60 border-emerald-100 dark:from-emerald-950/30 dark:to-emerald-900/20 dark:border-emerald-900/40",
    amber: "from-amber-50 to-amber-100/60 border-amber-100 dark:from-amber-950/30 dark:to-amber-900/20 dark:border-amber-900/40",
    violet:"from-violet-50 to-violet-100/60 border-violet-100 dark:from-violet-950/30 dark:to-violet-900/20 dark:border-violet-900/40",
  };
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-4 ${colors[color]}`}>
      <p className="text-xs font-medium text-slate-500 dark:text-gray-400">{label}</p>
      <p className="text-2xl font-bold text-slate-800 dark:text-slate-100 mt-1">{value}</p>
      {sub && <p className="text-xs text-slate-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function ZohoStatusTab({ sessionId }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    getZohoStatus(sessionId)
      .then(setData)
      .catch((e) => setError(e.response?.data?.detail || e.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div className="flex items-center justify-center py-20 gap-3 text-slate-400">
      <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
      </svg>
      <span className="text-sm">Loading Zoho status…</span>
    </div>
  );

  if (error) return (
    <div className="card p-6 text-center text-sm text-red-500">{error}</div>
  );

  if (!data) return null;

  const { metrics, vendors, bills, last_push } = data;
  const activeVendors    = vendors.filter(v => v.status === "active").length;
  const submittedVendors = vendors.filter(v => v.status === "submitted").length;
  const draftVendors     = vendors.filter(v => v.status === "draft").length;

  return (
    <div className="space-y-6">

      {/* Push summary banner */}
      {last_push && (
        <div className="card px-4 py-3 flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-gray-400">
          <span>
            Last push: <strong className="text-slate-700 dark:text-slate-200">
              {last_push.pushed_at ? new Date(last_push.pushed_at).toLocaleString("en-IN") : "—"}
            </strong>
          </span>
          <span className="text-emerald-600 dark:text-emerald-400 font-medium">
            {last_push.pushed_count} bill{last_push.pushed_count !== 1 ? "s" : ""} pushed
          </span>
          {last_push.error_count > 0 && (
            <span className="text-red-500 font-medium">{last_push.error_count} error{last_push.error_count !== 1 ? "s" : ""}</span>
          )}
          <button onClick={load} className="ml-auto btn-secondary text-xs py-1 px-2.5">Refresh</button>
        </div>
      )}

      {!last_push && (
        <div className="card p-4 text-center text-sm text-slate-400 dark:text-gray-500">
          No Zoho push done yet for this session. Push to Zoho Books from the Export panel.
          <button onClick={load} className="ml-3 btn-secondary text-xs py-1 px-2.5">Refresh</button>
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard
          color="green"
          label="Total Approved Amount"
          value={`₹${Number(metrics.total_approved_amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`}
          sub={`${metrics.by_employee?.filter(e => e.approved > 0).length || 0} employee(s)`}
        />
        <MetricCard
          color="blue"
          label="Bills Pushed"
          value={bills.length || last_push?.pushed_count || 0}
          sub={bills.filter(b => b.status === "draft").length + " drafts"}
        />
        <MetricCard
          color="green"
          label="Vendors Active"
          value={activeVendors}
          sub={`${submittedVendors} awaiting approval`}
        />
        <MetricCard
          color="amber"
          label="Vendors Submitted"
          value={submittedVendors}
          sub={draftVendors > 0 ? `${draftVendors} still draft` : "No drafts"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Employee breakdown */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
            Employee-wise Claims
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-gray-700">
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Employee</th>
                  <th className="pb-2 text-right text-slate-500 dark:text-gray-400 font-medium">Claims</th>
                  <th className="pb-2 text-right text-slate-500 dark:text-gray-400 font-medium">Claimed (₹)</th>
                  <th className="pb-2 text-right text-slate-500 dark:text-gray-400 font-medium">Approved</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
                {metrics.by_employee?.map((emp) => (
                  <tr key={emp.employee_id} className="hover:bg-slate-50 dark:hover:bg-gray-800/50">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-800 dark:text-slate-200">{emp.employee_name}</div>
                      <div className="text-slate-400 dark:text-gray-500">{emp.employee_id}</div>
                    </td>
                    <td className="py-2 pr-3 text-right text-slate-600 dark:text-slate-300">{emp.count}</td>
                    <td className="py-2 pr-3 text-right text-slate-700 dark:text-slate-200 font-medium">
                      {Number(emp.claimed).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2 text-right">
                      <span className={`font-semibold ${emp.approved > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-slate-400"}`}>
                        {emp.approved}
                      </span>
                      {emp.rejected > 0 && (
                        <span className="ml-1 text-red-400">/ {emp.rejected} rej</span>
                      )}
                      {emp.flagged > 0 && (
                        <span className="ml-1 text-amber-400">/ {emp.flagged} flag</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Category breakdown */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">
            Category-wise Breakdown
          </h3>
          <div className="space-y-2">
            {metrics.by_category?.map((cat) => {
              const pct = metrics.total_approved_amount > 0
                ? Math.min(100, (cat.total_claimed / metrics.by_category.reduce((s, c) => s + c.total_claimed, 0)) * 100)
                : 0;
              return (
                <div key={cat.category}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="text-slate-700 dark:text-slate-300 font-medium truncate max-w-[160px]">{cat.category}</span>
                    <span className="text-slate-500 dark:text-gray-400 tabular-nums">
                      ₹{Number(cat.total_claimed).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      <span className="text-slate-400 dark:text-gray-500 ml-1">({cat.count})</span>
                    </span>
                  </div>
                  <div className="h-1.5 bg-slate-100 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-400 dark:bg-blue-500 rounded-full transition-all"
                         style={{ width: `${pct.toFixed(1)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Vendor status table */}
      {vendors.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Vendor Approval Status</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-gray-700">
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Employee</th>
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">ID</th>
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Status</th>
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Zoho</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
                {vendors.map((v) => (
                  <tr key={v.vendor_id} className="hover:bg-slate-50 dark:hover:bg-gray-800/50">
                    <td className="py-2 pr-4 font-medium text-slate-800 dark:text-slate-200">{v.employee_name}</td>
                    <td className="py-2 pr-4 text-slate-400 dark:text-gray-500 font-mono">{v.employee_id}</td>
                    <td className="py-2 pr-4"><StatusBadge status={v.status} /></td>
                    <td className="py-2">
                      {v.zoho_url ? (
                        <a href={v.zoho_url} target="_blank" rel="noopener noreferrer"
                           className="text-blue-500 hover:underline dark:text-blue-400">view</a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {submittedVendors > 0 && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
                {submittedVendors} vendor(s) are submitted and awaiting your approval in Zoho Books before bills can be posted.
              </p>
            )}
            {draftVendors > 0 && (
              <p className="mt-2 text-xs text-slate-500 dark:text-gray-400 bg-slate-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                {draftVendors} vendor(s) are still in draft — they were submitted for approval automatically. Check Zoho Books to approve.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Bills status table */}
      {bills.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">Bill Status</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-gray-700">
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Bill No.</th>
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Employee</th>
                  <th className="pb-2 text-right text-slate-500 dark:text-gray-400 font-medium">Amount (₹)</th>
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Status</th>
                  <th className="pb-2 text-left text-slate-500 dark:text-gray-400 font-medium">Zoho</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-gray-800">
                {bills.map((b) => (
                  <tr key={b.bill_id} className="hover:bg-slate-50 dark:hover:bg-gray-800/50">
                    <td className="py-2 pr-4 font-mono font-medium text-slate-700 dark:text-slate-200">
                      {b.bill_number || b.bill_id.slice(0, 10)}
                    </td>
                    <td className="py-2 pr-4 text-slate-600 dark:text-slate-300">{b.employee}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-slate-700 dark:text-slate-200">
                      {Number(b.amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2 pr-4"><StatusBadge status={b.status} /></td>
                    <td className="py-2">
                      {b.zoho_url ? (
                        <a href={b.zoho_url} target="_blank" rel="noopener noreferrer"
                           className="text-blue-500 hover:underline dark:text-blue-400">view draft</a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* AI Verification results */}
      {last_push?.verification?.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">AI Bill Verification</h3>
          <div className="space-y-2">
            {last_push.verification.map((v) => (
              <div key={v.row_index}
                   className={`rounded-lg px-3 py-2 text-xs border ${v.ok
                     ? "bg-emerald-50 border-emerald-100 dark:bg-emerald-950/20 dark:border-emerald-900/40"
                     : "bg-amber-50 border-amber-100 dark:bg-amber-950/20 dark:border-amber-900/40"}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={v.ok ? "text-emerald-500" : "text-amber-500"}>
                    {v.ok ? "✓" : "⚠"}
                  </span>
                  <span className="font-medium text-slate-700 dark:text-slate-200">{v.employee}</span>
                  {v.bill_id && <span className="font-mono text-slate-400 dark:text-gray-500">{v.bill_id.slice(-8)}</span>}
                  <span className={`ml-auto text-xs ${v.ok ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                    {v.summary}
                  </span>
                </div>
                {v.issues?.length > 0 && (
                  <ul className="mt-1 ml-5 text-red-500 dark:text-red-400 space-y-0.5">
                    {v.issues.map((iss, i) => <li key={i}>• {iss}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
