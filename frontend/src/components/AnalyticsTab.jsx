import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from "recharts";

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtShort = (n) => {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000)   return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
};
const fmtFull = (n) =>
  Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2 });

// ── Status normaliser (case-insensitive, trim) ─────────────────────────────────
function getStatus(r) {
  return (r.status || "").toLowerCase().trim();
}
function isApproved(r)  { return getStatus(r) === "approved"; }
function isRejected(r)  { return getStatus(r) === "rejected"; }
function isFlagged(r)   { const s = getStatus(r); return s === "flagged" || s === "flag"; }

// ── Keka action normaliser ────────────────────────────────────────────────────
function kekaAction(r) {
  return (r.keka_actioned || "").toLowerCase().trim();
}
function isKekaApproved(r) { return kekaAction(r) === "approve" || kekaAction(r) === "approved"; }
function isKekaRejected(r) { return kekaAction(r) === "reject"  || kekaAction(r) === "rejected"; }

// ── Category normaliser ───────────────────────────────────────────────────────
function normalizeCategory(row) {
  const raw = ((row.expense_category || "") + " " + (row.expense_nature || "") + " " + (row.description || "")).toLowerCase();
  if (/claude|anthropic|openai|chatgpt|copilot|subscription|saas|software|license|github|notion|figma|zoom|slack|aws|azure|cloud|digital/.test(raw))
    return "Software & Cloud";
  if (/food|meal|welfare|tiffin|canteen|restaurant|cafe|swiggy|zomato|lunch|dinner|breakfast|snack|tea|coffee/.test(raw))
    return "Staff Welfare";
  if (/travel|conveyance|transport|cab|auto|taxi|uber|ola|rapido|bus|train|flight|metro|petrol|fuel|diesel|toll|parking|fare/.test(raw))
    return "Travel & Conveyance";
  if (/hotel|accommodation|stay|lodge|oyo|airbnb|hostel/.test(raw))
    return "Accommodation";
  if (/mobile|internet|airtel|jio|vi |vodafone|broadband|recharge|communication/.test(raw))
    return "Communication";
  if (/stationery|office|printer|supply|supplies/.test(raw))
    return "Office Supplies";
  const cat = row.expense_category || row.expense_nature || "Other";
  return cat.length > 24 ? cat.slice(0, 24) + "…" : cat;
}

// ── Date parser ────────────────────────────────────────────────────────────────
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return null;
}
function monthLabel(iso) {
  if (!iso) return "";
  const [, m] = iso.split("-");
  return ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m] || m;
}

// ── Tooltip component ─────────────────────────────────────────────────────────
function Tip({ active, payload, label, render }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: "12px", padding: "8px 12px", fontSize: "12px",
      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    }}>
      {render ? render(payload, label) : (
        <>
          {label && <p style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{label}</p>}
          {payload.map((p, i) => (
            <p key={i} style={{ color: p.color || p.fill }}>
              {p.name}: {p.value}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

const TICK = { fontSize: 11, fill: "var(--text-muted)" };

// ── Stat Tile ─────────────────────────────────────────────────────────────────
function StatTile({ label, value, sub, accent = "#e5007d" }) {
  return (
    <div className="card p-4 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-16 h-16 rounded-full opacity-10 blur-xl"
           style={{ background: accent, transform: "translate(30%,-30%)" }} />
      <p className="text-xs font-semibold mb-1" style={{ color: "var(--text-muted)" }}>{label}</p>
      <p className="text-xl font-black truncate mb-0.5" style={{ color: "var(--text-main)" }}>{value}</p>
      {sub && <p className="text-[11px]" style={{ color: accent }}>{sub}</p>}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AnalyticsTab({ rows = [] }) {
  if (!rows.length) {
    return (
      <div className="card p-10 text-center">
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No data to analyse.</p>
      </div>
    );
  }

  // ── Status counts ───────────────────────────────────────────────────────────
  const approved  = rows.filter(isApproved).length;
  const rejected  = rows.filter(isRejected).length;
  const flagged   = rows.filter(isFlagged).length;
  // anything that isn't strictly approved or rejected goes to flagged bucket for display
  const flaggedDisplay = rows.length - approved - rejected;
  const approvalRate = rows.length > 0 ? Math.round((approved / rows.length) * 100) : 0;

  const donutData = [
    { name: "Approved", value: approved,       color: "#10b981" },
    { name: "Flagged",  value: flaggedDisplay, color: "#f59e0b" },
    { name: "Rejected", value: rejected,        color: "#ef4444" },
  ].filter(d => d.value > 0);

  // ── Keka stats ──────────────────────────────────────────────────────────────
  const kekaApproved = rows.filter(isKekaApproved).length;
  const kekaRejected = rows.filter(isKekaRejected).length;
  const kekaPending  = rows.length - kekaApproved - kekaRejected;
  const zohoBooked   = rows.filter(r => r.zoho_bill_id || r.zoho_bill_status).length;

  // ── Amounts ─────────────────────────────────────────────────────────────────
  const totalAmount    = rows.reduce((s, r) => s + (r.claimed_amount || 0), 0);
  const approvedAmount = rows.filter(isApproved).reduce((s, r) => s + (r.bill_amount ?? r.claimed_amount ?? 0), 0);

  // ── Category breakdown ──────────────────────────────────────────────────────
  const catMap = {};
  for (const r of rows) {
    const key = normalizeCategory(r);
    if (!catMap[key]) catMap[key] = { amount: 0, count: 0, approved: 0, rejected: 0 };
    catMap[key].amount   += r.claimed_amount || 0;
    catMap[key].count    += 1;
    if (isApproved(r)) catMap[key].approved++;
    if (isRejected(r)) catMap[key].rejected++;
  }
  const catSorted = Object.entries(catMap).sort((a, b) => b[1].amount - a[1].amount).slice(0, 7);
  const catBarData = catSorted.map(([name, v]) => ({
    name,
    amount: v.amount,
    count: v.count,
    approved: v.approved,
  }));

  // ── Top employees ───────────────────────────────────────────────────────────
  const empMap = {};
  for (const r of rows) {
    const key = r.employee_name || "Unknown";
    if (!empMap[key]) empMap[key] = { amount: 0, count: 0, full: key };
    empMap[key].amount += r.claimed_amount || 0;
    empMap[key].count  += 1;
  }
  const empData = Object.entries(empMap)
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, 8)
    .map(([, v]) => ({
      name: v.full.split(" ").slice(0, 2).join(" "),
      full: v.full,
      amount: v.amount,
      count: v.count,
    }));

  // ── Monthly breakdown ───────────────────────────────────────────────────────
  const monthMap = {};
  for (const r of rows) {
    const d = parseDate(r.expense_date);
    if (!d) continue;
    const mo = d.slice(0, 7); // YYYY-MM
    if (!monthMap[mo]) monthMap[mo] = { label: monthLabel(d), total: 0, approved: 0, rejected: 0, flagged: 0, count: 0 };
    monthMap[mo].total += r.claimed_amount || 0;
    monthMap[mo].count += 1;
    if (isApproved(r))      monthMap[mo].approved += r.claimed_amount || 0;
    else if (isRejected(r)) monthMap[mo].rejected += 1;
    else                    monthMap[mo].flagged  += 1;
  }
  const monthData = Object.entries(monthMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v);

  // ── Approval rate by category ───────────────────────────────────────────────
  const approvalByCat = catSorted.map(([name, v]) => ({
    name,
    rate: v.count > 0 ? Math.round((v.approved / v.count) * 100) : 0,
    count: v.count,
  }));

  // ── Keka vs Zoho bar data ───────────────────────────────────────────────────
  const kekaZohoData = [
    { label: "Keka Approved", value: kekaApproved, color: "#10b981" },
    { label: "Keka Rejected", value: kekaRejected, color: "#ef4444" },
    { label: "Keka Pending",  value: kekaPending,  color: "#f59e0b" },
    { label: "Zoho Booked",   value: zohoBooked,   color: "#7c3aed" },
  ];

  const topCategory = catSorted[0]?.[0] || "—";
  const topEmployee  = empData[0]?.full  || "—";

  return (
    <div className="space-y-4 animate-fade-in">

      {/* ── KPI Row ──────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile label="Total Claimed"    value={fmtShort(totalAmount)}    sub={`${rows.length} claims total`}      accent="#7c3aed" />
        <StatTile label="Approved Amount"  value={fmtShort(approvedAmount)} sub={`${approved} claims approved`}      accent="#10b981" />
        <StatTile label="Top Category"     value={topCategory}               sub={fmtShort(catMap[topCategory]?.amount || 0)} accent="#e5007d" />
        <StatTile label="Top Claimant"     value={topEmployee.split(" ").slice(0,2).join(" ")}
                                           sub={`${rows.filter(r => r.employee_name === topEmployee).length} claims`} accent="#f59e0b" />
      </div>

      {/* ── Row 1: Donut (approval status) + Category bar ────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

        {/* Donut */}
        <div className="card p-5 lg:col-span-2">
          <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
            Approval Status
          </p>
          <div className="relative">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={donutData} cx="50%" cy="45%" innerRadius={65} outerRadius={98}
                     paddingAngle={3} dataKey="value" startAngle={90} endAngle={-270} labelLine={false}>
                  {donutData.map((d, i) => <Cell key={i} fill={d.color} strokeWidth={0} />)}
                </Pie>
                <Tooltip content={<Tip render={(payload) => (
                  <div>
                    <p style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{payload[0]?.name}</p>
                    <p style={{ color: payload[0]?.payload?.color }}>
                      {payload[0]?.value} claims
                    </p>
                  </div>
                )} />} />
                <Legend iconType="circle" iconSize={7}
                  formatter={v => <span style={{ fontSize: 11, color: "var(--text-sub)" }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
            {/* Center label */}
            <div className="absolute top-0 left-0 right-0 flex flex-col items-center justify-center pointer-events-none"
                 style={{ height: "195px" }}>
              <span className="text-4xl font-black leading-none"
                    style={{ color: approvalRate > 0 ? "#10b981" : "var(--text-muted)" }}>
                {approvalRate}%
              </span>
              <span className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>approval rate</span>
            </div>
          </div>
        </div>

        {/* Category bar */}
        <div className="card p-5 lg:col-span-3">
          <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
            Top Categories by Claimed Amount
          </p>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={catBarData} layout="vertical" margin={{ top: 0, right: 55, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="catG" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#ff4db8" /><stop offset="100%" stopColor="#e5007d" />
                </linearGradient>
              </defs>
              <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis type="number" tickFormatter={fmtShort} tick={TICK} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={130} tick={{ ...TICK, textAnchor: "end" }} axisLine={false} tickLine={false} />
              <Tooltip content={<Tip render={(payload, label) => (
                <div>
                  <p style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{label}</p>
                  <p style={{ color: "#e5007d" }}>Amount: {fmtShort(payload[0]?.value)}</p>
                  <p style={{ color: "var(--text-sub)" }}>Claims: {payload[0]?.payload?.count}</p>
                  <p style={{ color: "#10b981" }}>Approved: {payload[0]?.payload?.approved}</p>
                </div>
              )} />} />
              <Bar dataKey="amount" fill="url(#catG)" radius={[0, 6, 6, 0]} maxBarSize={20} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Row 2: Monthly trend + Top employees ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Monthly approved amount */}
        <div className="card p-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
            Monthly Approved Amount
          </p>
          {monthData.length === 0 ? (
            <div className="flex items-center justify-center h-[200px]">
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>No date data in rows</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={monthData} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
                <defs>
                  <linearGradient id="moG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff4db8" /><stop offset="100%" stopColor="#e5007d" />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={TICK} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={fmtShort} tick={TICK} axisLine={false} tickLine={false} width={55} />
                <Tooltip content={<Tip render={(payload, label) => (
                  <div>
                    <p style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{label}</p>
                    <p style={{ color: "#e5007d" }}>Approved: {fmtShort(payload[0]?.value)}</p>
                    <p style={{ color: "var(--text-sub)" }}>Total: {fmtShort(payload[0]?.payload?.total)}</p>
                    <p style={{ color: "var(--text-sub)" }}>{payload[0]?.payload?.count} claims · {payload[0]?.payload?.rejected} rejected · {payload[0]?.payload?.flagged} flagged</p>
                  </div>
                )} />} />
                <Bar dataKey="approved" name="Approved ₹" fill="url(#moG)" radius={[6, 6, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top employees */}
        <div className="card p-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
            Top Claimants by Amount
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={empData} margin={{ top: 4, right: 16, left: 8, bottom: 30 }}>
              <defs>
                <linearGradient id="empG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#818cf8" /><stop offset="100%" stopColor="#6366f1" />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ ...TICK, angle: -25, textAnchor: "end" }} axisLine={false} tickLine={false} interval={0} />
              <YAxis tickFormatter={fmtShort} tick={TICK} axisLine={false} tickLine={false} width={55} />
              <Tooltip content={<Tip render={(payload, label) => (
                <div>
                  <p style={{ fontWeight: 700, color: "var(--text-main)", marginBottom: 4 }}>{payload[0]?.payload?.full || label}</p>
                  <p style={{ color: "#6366f1" }}>Claimed: {fmtShort(payload[0]?.value)}</p>
                  <p style={{ color: "var(--text-sub)" }}>{payload[0]?.payload?.count} claims</p>
                </div>
              )} />} />
              <Bar dataKey="amount" fill="url(#empG)" radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Row 3: Keka + Zoho status + Approval rate by category ────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Keka & Zoho action breakdown */}
        <div className="card p-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: "var(--text-muted)" }}>
            Keka & Zoho Actions
          </p>
          <p className="text-[11px] mb-4" style={{ color: "var(--text-muted)" }}>
            How many claims actioned in Keka and pushed to Zoho
          </p>

          {/* Mini stat grid */}
          <div className="grid grid-cols-2 gap-2 mb-5">
            {[
              { label: "Keka Approved", val: kekaApproved, color: "#10b981" },
              { label: "Keka Rejected", val: kekaRejected, color: "#ef4444" },
              { label: "Keka Pending",  val: kekaPending,  color: "#f59e0b" },
              { label: "Zoho Booked",   val: zohoBooked,   color: "#7c3aed" },
            ].map(s => (
              <div key={s.label} className="rounded-xl p-3" style={{
                background: `${s.color}10`, border: `1px solid ${s.color}20`
              }}>
                <p className="text-2xl font-black mb-0.5" style={{ color: s.color }}>{s.val}</p>
                <p className="text-[11px] font-semibold" style={{ color: "var(--text-sub)" }}>{s.label}</p>
              </div>
            ))}
          </div>

          {/* Stacked progress bar */}
          <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: "var(--text-muted)" }}>
            Keka Action Progress
          </p>
          <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
            {kekaApproved > 0 && (
              <div title={`Approved: ${kekaApproved}`} className="transition-all duration-700"
                   style={{ width: `${(kekaApproved/rows.length)*100}%`, background: "#10b981" }} />
            )}
            {kekaRejected > 0 && (
              <div title={`Rejected: ${kekaRejected}`} className="transition-all duration-700"
                   style={{ width: `${(kekaRejected/rows.length)*100}%`, background: "#ef4444" }} />
            )}
            {kekaPending > 0 && (
              <div title={`Pending: ${kekaPending}`} className="transition-all duration-700"
                   style={{ width: `${(kekaPending/rows.length)*100}%`, background: "var(--border)" }} />
            )}
          </div>
          <div className="flex gap-4 mt-2 text-[10px]" style={{ color: "var(--text-muted)" }}>
            <span style={{ color: "#10b981" }}>● Approved</span>
            <span style={{ color: "#ef4444" }}>● Rejected</span>
            <span>● Pending</span>
          </div>
        </div>

        {/* Approval rate by category */}
        <div className="card p-5">
          <p className="text-xs font-bold uppercase tracking-widest mb-4" style={{ color: "var(--text-muted)" }}>
            Approval Rate by Category
          </p>
          {approvalByCat.length === 0 ? (
            <p className="text-sm text-center" style={{ color: "var(--text-muted)" }}>No data</p>
          ) : (
            <div className="space-y-3">
              {approvalByCat.map(d => (
                <div key={d.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium truncate max-w-[55%]" style={{ color: "var(--text-main)" }}>{d.name}</span>
                    <span className="font-bold tabular-nums" style={{ color: d.rate >= 70 ? "#10b981" : d.rate >= 40 ? "#f59e0b" : "#ef4444" }}>
                      {d.rate}%
                      <span className="ml-1 font-normal" style={{ color: "var(--text-muted)" }}>({d.count})</span>
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
                    <div className="h-full rounded-full transition-all duration-700"
                         style={{
                           width: `${d.rate}%`,
                           background: d.rate >= 70 ? "#10b981" : d.rate >= 40 ? "#f59e0b" : "#ef4444"
                         }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
