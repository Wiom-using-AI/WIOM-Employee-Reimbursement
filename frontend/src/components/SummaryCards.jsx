export default function SummaryCards({ total, approved, rejected, flagged, unmapped }) {
  const approvalRate = total > 0 ? Math.round((approved / total) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MetricCard
          label="Total Claims"
          value={total}
          sub={`${approvalRate}% approval rate`}
          color="#e5007d"
          gradient="linear-gradient(135deg,#ff5fba22,#e5007d18)"
          icon={<ClaimsIcon />}
          bar={approvalRate}
        />
        <MetricCard
          label="Approved"
          value={approved}
          sub="Fully validated"
          color="#10b981"
          gradient="linear-gradient(135deg,#10b98122,#059a6d22)"
          icon={<CheckIcon />}
          bar={total > 0 ? Math.round((approved/total)*100) : 0}
        />
        <MetricCard
          label="Rejected"
          value={rejected}
          sub="Failed validation"
          color="#ef4444"
          gradient="linear-gradient(135deg,#ef444422,#dc262622)"
          icon={<XIcon />}
          bar={total > 0 ? Math.round((rejected/total)*100) : 0}
        />
        <MetricCard
          label="Flagged"
          value={flagged}
          sub="Needs review"
          color="#f59e0b"
          gradient="linear-gradient(135deg,#f59e0b22,#d9770622)"
          icon={<FlagIcon />}
          bar={total > 0 ? Math.round((flagged/total)*100) : 0}
        />
      </div>

      {unmapped > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm"
             style={{
               background: "rgba(124,58,237,0.06)",
               border: "1px solid rgba(124,58,237,0.18)",
               color: "#7c3aed",
             }}>
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>
            <strong>{unmapped}</strong> bill{unmapped !== 1 ? "s" : ""} found in ZIP but not referenced in Excel&nbsp;
            <span style={{ color: "var(--text-muted)" }}>(Unmapped)</span>
          </span>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, color, gradient, icon, bar }) {
  return (
    <div className="card card-shine p-5 relative overflow-hidden">
      {/* Background tint */}
      <div className="absolute inset-0 opacity-70" style={{ background: gradient }} />

      <div className="relative z-10">
        <div className="flex items-start justify-between mb-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center"
               style={{ background: gradient, border: `1px solid ${color}22` }}>
            <span style={{ color }}>{icon}</span>
          </div>
          {bar > 0 && (
            <span className="text-xs font-bold tabular-nums" style={{ color }}>
              {bar}%
            </span>
          )}
        </div>

        <p className="text-3xl font-black tracking-tight mb-0.5" style={{ color: "var(--text-main)" }}>
          {value}
        </p>
        <p className="text-xs font-semibold mb-0.5" style={{ color: "var(--text-main)" }}>{label}</p>
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>{sub}</p>

        {/* Progress bar */}
        <div className="mt-3 h-1 rounded-full" style={{ background: `${color}20` }}>
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.max(bar, value > 0 ? 8 : 0)}%`, background: color }}
          />
        </div>
      </div>
    </div>
  );
}

function CheckIcon() {
  return <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
  </svg>;
}
function XIcon() {
  return <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/>
  </svg>;
}
function FlagIcon() {
  return <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round"
      d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6H11l-1-1H5a2 2 0 00-2 2zm0 0h18"/>
  </svg>;
}
function ClaimsIcon() {
  return <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round"
      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
  </svg>;
}
