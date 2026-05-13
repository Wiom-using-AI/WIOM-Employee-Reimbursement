import { useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { searchClaims, getAuthToken } from "../services/api";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend,
} from "recharts";

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmtAmt = (n) =>
  n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L`
  : n >= 1000 ? `₹${(n / 1000).toFixed(1)}K`
  : `₹${Math.round(n).toLocaleString("en-IN")}`;

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

// Date helpers
function isoToday() { return new Date().toISOString().slice(0, 10); }
function isoNDaysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10);
}
function isoNMonthsAgo(n) {
  const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString().slice(0, 10);
}
function isoStartOfMonth() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    Approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
    Rejected:  "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
    Flagged:   "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[status] ?? "bg-slate-100 text-slate-600 dark:bg-gray-800 dark:text-gray-400"}`}>
      {status || "—"}
    </span>
  );
}

function SourceBadge({ source }) {
  if (source === "keka")
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400">Keka</span>;
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400">Upload</span>;
}

// ── Stat chip ─────────────────────────────────────────────────────────────────
function Chip({ label, value, color = "slate" }) {
  const colors = {
    slate:   "bg-slate-100 dark:bg-gray-800 text-slate-600 dark:text-gray-300",
    pink:    "bg-pink-50 dark:bg-pink-900/20 text-pink-700 dark:text-pink-400 border border-pink-100 dark:border-pink-800/40",
    green:   "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-800/40",
    violet:  "bg-violet-50 dark:bg-violet-900/20 text-violet-700 dark:text-violet-400 border border-violet-100 dark:border-violet-800/40",
    sky:     "bg-sky-50 dark:bg-sky-900/20 text-sky-700 dark:text-sky-400 border border-sky-100 dark:border-sky-800/40",
    amber:   "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-100 dark:border-amber-800/40",
    red:     "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-100 dark:border-red-800/40",
  };
  return (
    <div className={`px-3 py-2 rounded-xl text-xs font-semibold ${colors[color]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70 mb-0.5">{label}</div>
      <div className="text-sm font-black">{value}</div>
    </div>
  );
}

// ── Quick-filter presets ──────────────────────────────────────────────────────
const PRESETS = [
  { label: "Hotel > ₹2000",     q: "hotel",  minAmount: 2000 },
  { label: "Travel claims",     q: "travel" },
  { label: "Food claims",       q: "food" },
  { label: "Keka Approved",     kekaOnly: true },
  { label: "Zoho Pushed",       zohoOnly: true },
  { label: "Approved only",     status: "Approved" },
  { label: "Rejected",          status: "Rejected" },
  { label: "Flagged",           status: "Flagged" },
  { label: "Last 7 days",       fromDate: isoNDaysAgo(7),    toDate: isoToday() },
  { label: "This month",        fromDate: isoStartOfMonth(),  toDate: isoToday() },
  { label: "Last 3 months",     fromDate: isoNMonthsAgo(3),  toDate: isoToday() },
  { label: "Last 6 months",     fromDate: isoNMonthsAgo(6),  toDate: isoToday() },
];

const PIE_COLORS = ["#10b981", "#f59e0b", "#ef4444", "#94a3b8"];

// ── Main component ────────────────────────────────────────────────────────────
export default function GlobalSearch() {
  const navigate = useNavigate();

  // Filter state
  const [query,     setQuery]     = useState("");
  const [status,    setStatus]    = useState("");
  const [category,  setCategory]  = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [fromDate,  setFromDate]  = useState("");
  const [toDate,    setToDate]    = useState("");
  const [kekaOnly,  setKekaOnly]  = useState(false);
  const [zohoOnly,  setZohoOnly]  = useState(false);

  // UI state
  const [results,      setResults]      = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");
  const [sortBy,       setSortBy]       = useState("date");
  const [showCharts,   setShowCharts]   = useState(false);
  const [exporting,    setExporting]    = useState(false);

  // ── Search handler ──────────────────────────────────────────────────────────
  async function handleSearch(e) {
    e?.preventDefault();
    const hasFilter = query || status || category || minAmount || maxAmount || fromDate || toDate || kekaOnly || zohoOnly;
    if (!hasFilter) { setError("Enter at least one search criteria"); return; }
    setLoading(true);
    setError("");
    try {
      const data = await searchClaims({
        q:         query     || undefined,
        status:    status    || undefined,
        category:  category  || undefined,
        minAmount: minAmount ? Number(minAmount) : undefined,
        maxAmount: maxAmount ? Number(maxAmount) : undefined,
        fromDate:  fromDate  || undefined,
        toDate:    toDate    || undefined,
        kekaOnly,
        zohoOnly,
        limit: 500,
      });
      setResults(data.results || []);
      setShowCharts(true);
    } catch (err) {
      setError(err.response?.data?.detail || "Search failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ── Apply a quick-filter preset ─────────────────────────────────────────────
  function applyPreset(preset) {
    if (preset.q         !== undefined) setQuery(preset.q);
    if (preset.status    !== undefined) setStatus(preset.status);
    if (preset.category  !== undefined) setCategory(preset.category);
    if (preset.minAmount !== undefined) setMinAmount(String(preset.minAmount));
    if (preset.fromDate  !== undefined) setFromDate(preset.fromDate);
    if (preset.toDate    !== undefined) setToDate(preset.toDate);
    if (preset.kekaOnly  !== undefined) setKekaOnly(preset.kekaOnly);
    if (preset.zohoOnly  !== undefined) setZohoOnly(preset.zohoOnly);
  }

  // ── Clear all ───────────────────────────────────────────────────────────────
  function clearAll() {
    setQuery(""); setStatus(""); setCategory("");
    setMinAmount(""); setMaxAmount("");
    setFromDate(""); setToDate("");
    setKekaOnly(false); setZohoOnly(false);
    setResults(null); setError(""); setShowCharts(false);
  }

  // ── Export results to CSV ───────────────────────────────────────────────────
  async function exportCSV() {
    if (!results || results.length === 0) return;
    setExporting(true);
    try {
      const headers = [
        "Employee Name", "Employee Code", "Session ID", "Session Date", "Source",
        "Expense Date", "Category", "Description",
        "Claimed Amount (₹)", "Status", "Keka Action", "Zoho Pushed"
      ];
      const rows = sorted.map((r) => [
        r.employee_name || "",
        r.employee_id || "",
        (r.session_id || "").slice(0, 8),
        fmtDate(r.created_at),
        r.source || "",
        r.expense_date || "",
        r.expense_category || "",
        r.description || "",
        r.claimed_amount ?? 0,
        r.status || "",
        r.keka_actioned || "—",
        r.zoho_pushed ? "Yes" : "No",
      ]);
      const csv = [headers, ...rows]
        .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
        .join("\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Wiom_Search_Results_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  // ── Sorted results ──────────────────────────────────────────────────────────
  const sorted = [...(results || [])].sort((a, b) => {
    if (sortBy === "amount")   return b.claimed_amount - a.claimed_amount;
    if (sortBy === "employee") return (a.employee_name || "").localeCompare(b.employee_name || "");
    if (sortBy === "status")   return (a.status || "").localeCompare(b.status || "");
    return (b.created_at || "").localeCompare(a.created_at || "");
  });

  // ── Analytics ───────────────────────────────────────────────────────────────
  const totalAmt    = (results || []).reduce((s, r) => s + (r.claimed_amount || 0), 0);
  const approvedAmt = (results || []).filter(r => r.status === "Approved").reduce((s, r) => s + (r.claimed_amount || 0), 0);
  const approvedN   = (results || []).filter((r) => r.status === "Approved").length;
  const rejectedN   = (results || []).filter((r) => r.status === "Rejected").length;
  const flaggedN    = (results || []).filter((r) => r.status === "Flagged").length;
  const kekaActN    = (results || []).filter((r) => r.keka_actioned && r.keka_actioned !== "pending").length;
  const zohoN       = (results || []).filter((r) => r.zoho_pushed).length;
  const uniqueSess  = new Set((results || []).map((r) => r.session_id)).size;
  const uniqueEmps  = new Set((results || []).map((r) => r.employee_name).filter(Boolean)).size;

  // Pie chart data
  const pieData = [
    { name: "Approved", value: approvedN },
    { name: "Flagged",  value: flaggedN },
    { name: "Rejected", value: rejectedN },
  ].filter(d => d.value > 0);

  // Category bar chart
  const catMap = {};
  for (const r of results || []) {
    const cat = r.expense_category || "Other";
    if (!catMap[cat]) catMap[cat] = { cat, total: 0, count: 0 };
    catMap[cat].total += r.claimed_amount || 0;
    catMap[cat].count += 1;
  }
  const catData = Object.values(catMap).sort((a, b) => b.total - a.total).slice(0, 8);

  // Employee bar chart
  const empMap = {};
  for (const r of results || []) {
    const emp = r.employee_name || "Unknown";
    if (!empMap[emp]) empMap[emp] = { emp, total: 0, count: 0 };
    empMap[emp].total += r.claimed_amount || 0;
    empMap[emp].count += 1;
  }
  const empData = Object.values(empMap).sort((a, b) => b.total - a.total).slice(0, 8);

  const hasFilters = query || status || category || minAmount || maxAmount || fromDate || toDate || kekaOnly || zohoOnly;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0d1117] py-8 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
              <span>🔍</span> Global Search
            </h1>
            <p className="text-sm text-slate-500 dark:text-gray-400 mt-0.5">
              Search claims across all sessions &amp; batches by employee, category, amount, date
            </p>
          </div>
          {results && results.length > 0 && (
            <button
              onClick={exportCSV}
              disabled={exporting}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-60 transition-all shadow-sm"
              style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)" }}
            >
              {exporting ? "Generating…" : "⬇️ Export Results CSV"}
            </button>
          )}
        </div>

        {/* ── Search form ──────────────────────────────────────────────────── */}
        <form
          onSubmit={handleSearch}
          className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 p-6 shadow-sm space-y-4"
        >
          {/* Main search input */}
          <div className="relative">
            <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 dark:text-gray-500 pointer-events-none"
              fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by employee name, category, description…"
              className="w-full pl-12 pr-4 py-3 rounded-2xl border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-800 text-slate-800 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400 transition-all"
            />
          </div>

          {/* Row 1: Status + Category + Min + Max */}
          <div className="flex flex-wrap gap-3 items-center">
            <select value={status} onChange={(e) => setStatus(e.target.value)}
              className="text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-400 transition-all">
              <option value="">All Status</option>
              <option value="Approved">✅ Approved</option>
              <option value="Rejected">❌ Rejected</option>
              <option value="Flagged">⚑ Flagged</option>
            </select>

            <input type="text" value={category} onChange={(e) => setCategory(e.target.value)}
              placeholder="Category (hotel, travel…)"
              className="text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-300 placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-pink-400 transition-all w-48" />

            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">₹</span>
              <input type="number" value={minAmount} onChange={(e) => setMinAmount(e.target.value)}
                placeholder="Min amount" min={0}
                className="text-sm pl-7 pr-3 py-2 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-300 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-pink-400 transition-all w-32" />
            </div>

            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">₹</span>
              <input type="number" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="Max amount" min={0}
                className="text-sm pl-7 pr-3 py-2 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-300 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-pink-400 transition-all w-32" />
            </div>
          </div>

          {/* Row 2: Date range + Keka + Zoho + Search btn */}
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 dark:text-gray-500 font-medium whitespace-nowrap">📅 From</span>
              <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
                className="text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-400 transition-all" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 dark:text-gray-500 font-medium whitespace-nowrap">To</span>
              <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
                className="text-sm px-3 py-2 rounded-xl border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-400 transition-all" />
            </div>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={kekaOnly} onChange={(e) => setKekaOnly(e.target.checked)}
                className="w-4 h-4 accent-pink-600 rounded" />
              <span className="text-sm text-slate-600 dark:text-gray-300 font-medium whitespace-nowrap">🔗 Keka only</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={zohoOnly} onChange={(e) => setZohoOnly(e.target.checked)}
                className="w-4 h-4 accent-pink-600 rounded" />
              <span className="text-sm text-slate-600 dark:text-gray-300 font-medium whitespace-nowrap">📦 Zoho only</span>
            </label>

            <button type="submit" disabled={loading}
              className="ml-auto flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-60 transition-all shadow-sm hover:shadow-md"
              style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)" }}>
              {loading ? (
                <><svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>Searching…</>
              ) : (
                <><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M21 21l-4.35-4.35M17 11A6 6 0 115 11a6 6 0 0112 0z" />
                  </svg>Search</>
              )}
            </button>

            {hasFilters && (
              <button type="button" onClick={clearAll}
                className="text-xs px-3 py-2 rounded-xl border border-slate-200 dark:border-gray-700 text-slate-400 hover:text-red-500 hover:border-red-300 transition-all">
                Clear
              </button>
            )}
          </div>

          {/* Quick presets */}
          <div className="flex flex-wrap gap-2">
            <span className="text-[10px] text-slate-400 dark:text-gray-600 uppercase tracking-wide self-center font-semibold mr-1">Quick:</span>
            {PRESETS.map((preset) => (
              <button key={preset.label} type="button" onClick={() => applyPreset(preset)}
                className="text-[11px] px-2.5 py-1 rounded-full border border-slate-200 dark:border-gray-700 text-slate-500 dark:text-gray-400 hover:border-pink-400 hover:text-pink-600 dark:hover:text-pink-300 transition-all">
                {preset.label}
              </button>
            ))}
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {error}
            </p>
          )}
        </form>

        {/* ── Results ──────────────────────────────────────────────────────── */}
        {results !== null && (
          <div className="space-y-5">
            {results.length === 0 ? (
              <div className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 p-12 text-center">
                <div className="text-5xl mb-3">🔍</div>
                <p className="text-slate-500 dark:text-gray-400 text-sm font-medium">
                  No claims found. Try different keywords or filters.
                </p>
              </div>
            ) : (
              <>
                {/* ── Summary stat chips ── */}
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                  <Chip label="Total Claims" value={results.length} color="slate" />
                  <Chip label="Total Amount" value={fmtAmt(totalAmt)} color="pink" />
                  <Chip label="Approved" value={approvedN} color="green" />
                  <Chip label="Approved Amt" value={fmtAmt(approvedAmt)} color="green" />
                  <Chip label="Flagged" value={flaggedN} color="amber" />
                  <Chip label="Rejected" value={rejectedN} color="red" />
                  <Chip label="Keka Actioned" value={kekaActN} color="violet" />
                  <Chip label="Zoho Pushed" value={zohoN} color="sky" />
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-slate-400 dark:text-gray-500">
                  <span>📂 {uniqueSess} session{uniqueSess !== 1 ? "s" : ""}</span>
                  <span>•</span>
                  <span>👤 {uniqueEmps} employee{uniqueEmps !== 1 ? "s" : ""}</span>
                  <span>•</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                    Approval rate: {results.length > 0 ? Math.round((approvedN / results.length) * 100) : 0}%
                  </span>
                </div>

                {/* ── Analytics charts ── */}
                {showCharts && results.length > 1 && (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

                    {/* Pie: Status breakdown */}
                    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 p-5">
                      <p className="text-sm font-bold text-slate-700 dark:text-gray-200 mb-4">Status Breakdown</p>
                      <ResponsiveContainer width="100%" height={180}>
                        <PieChart>
                          <Pie data={pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value" label={({ name, percent }) => `${name} ${Math.round(percent * 100)}%`} labelLine={false} fontSize={10}>
                            {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                          </Pie>
                          <Tooltip formatter={(v, n) => [v, n]} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Bar: Category breakdown */}
                    {catData.length > 0 && (
                      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 p-5">
                        <p className="text-sm font-bold text-slate-700 dark:text-gray-200 mb-4">Top Categories</p>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={catData} layout="vertical" margin={{ top: 0, right: 8, left: 4, bottom: 0 }}>
                            <XAxis type="number" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtAmt(v)} />
                            <YAxis type="category" dataKey="cat" width={70} tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                            <Tooltip formatter={(v) => [fmtAmt(v), "Amount"]} />
                            <Bar dataKey="total" fill="#ff4db8" radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* Bar: Top employees */}
                    {empData.length > 1 && (
                      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 p-5">
                        <p className="text-sm font-bold text-slate-700 dark:text-gray-200 mb-4">Top Claimants</p>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={empData} layout="vertical" margin={{ top: 0, right: 8, left: 4, bottom: 0 }}>
                            <XAxis type="number" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtAmt(v)} />
                            <YAxis type="category" dataKey="emp" width={80} tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                            <Tooltip formatter={(v) => [fmtAmt(v), "Total"]} />
                            <Bar dataKey="total" fill="#7c3aed" radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Results table header + sort ── */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-bold text-slate-700 dark:text-gray-200 uppercase tracking-wide">
                    Results — {sorted.length} claim{sorted.length !== 1 ? "s" : ""}
                  </h2>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400 dark:text-gray-500 mr-1">Sort:</span>
                    {[
                      { key: "date",     label: "Date" },
                      { key: "amount",   label: "Amount" },
                      { key: "employee", label: "Employee" },
                      { key: "status",   label: "Status" },
                    ].map(({ key, label }) => (
                      <button key={key} onClick={() => setSortBy(key)}
                        className={`text-xs px-3 py-1.5 rounded-lg border font-semibold transition-all ${
                          sortBy === key
                            ? "bg-pink-600 text-white border-pink-600"
                            : "border-slate-200 dark:border-gray-700 text-slate-500 dark:text-gray-400 hover:border-pink-400 hover:text-pink-600"
                        }`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Table ── */}
                <div className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 overflow-hidden">
                  <div className="max-h-[600px] overflow-y-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-slate-50 dark:bg-gray-800 text-xs font-semibold text-slate-500 dark:text-gray-400 uppercase tracking-wide">
                          <th className="text-left px-4 py-3 whitespace-nowrap">Employee</th>
                          <th className="text-left px-4 py-3 whitespace-nowrap">Session</th>
                          <th className="text-left px-4 py-3 whitespace-nowrap">Category</th>
                          <th className="text-left px-4 py-3 whitespace-nowrap">Expense Date</th>
                          <th className="text-right px-4 py-3 whitespace-nowrap">Amount</th>
                          <th className="text-center px-4 py-3 whitespace-nowrap">Status</th>
                          <th className="text-center px-4 py-3 whitespace-nowrap">Keka</th>
                          <th className="text-center px-4 py-3 whitespace-nowrap">Zoho</th>
                          <th className="px-4 py-3"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((row, idx) => (
                          <tr
                            key={`${row.session_id}-${row.row_index ?? idx}`}
                            onClick={() => navigate(`/dashboard/${row.session_id}`)}
                            className="border-b border-slate-100 dark:border-gray-800 hover:bg-pink-50/40 dark:hover:bg-pink-900/10 cursor-pointer transition-colors"
                          >
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="font-semibold text-slate-800 dark:text-white text-sm leading-tight">
                                {row.employee_name || "—"}
                              </div>
                              {row.employee_id && (
                                <div className="text-[11px] text-slate-400 dark:text-gray-500 mt-0.5">{row.employee_id}</div>
                              )}
                            </td>

                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="font-mono text-[11px] text-slate-500 dark:text-gray-400">
                                {(row.session_id || "").slice(0, 8)}…
                              </div>
                              <div className="text-[10px] text-slate-400 dark:text-gray-500 mt-0.5">
                                {fmtDate(row.created_at)}
                              </div>
                              <div className="mt-1"><SourceBadge source={row.source} /></div>
                            </td>

                            <td className="px-4 py-3">
                              <div className="text-slate-700 dark:text-gray-300 text-sm font-medium">
                                {row.expense_category || "—"}
                              </div>
                              {row.expense_nature && row.expense_nature !== row.expense_category && (
                                <div className="text-[11px] text-slate-400 dark:text-gray-500 mt-0.5">{row.expense_nature}</div>
                              )}
                              {row.description && (
                                <div className="text-[10px] text-slate-400 dark:text-gray-600 mt-0.5 max-w-[200px] truncate" title={row.description}>
                                  {row.description}
                                </div>
                              )}
                            </td>

                            <td className="px-4 py-3 whitespace-nowrap text-sm text-slate-600 dark:text-gray-400">
                              {fmtDate(row.expense_date)}
                            </td>

                            <td className="px-4 py-3 whitespace-nowrap text-right">
                              <span className="font-bold text-slate-800 dark:text-white tabular-nums">
                                {fmtAmt(row.claimed_amount ?? 0)}
                              </span>
                            </td>

                            <td className="px-4 py-3 text-center whitespace-nowrap">
                              <StatusBadge status={row.status} />
                            </td>

                            <td className="px-4 py-3 text-center whitespace-nowrap text-sm">
                              {row.keka_actioned === "approved" ? (
                                <span className="text-emerald-600 dark:text-emerald-400 font-medium">✅</span>
                              ) : row.keka_actioned === "rejected" ? (
                                <span className="text-red-500 font-medium">❌</span>
                              ) : (
                                <span className="text-slate-300 dark:text-gray-700">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center whitespace-nowrap text-sm">
                              {row.zoho_pushed ? (
                                <span className="text-sky-600 dark:text-sky-400 font-medium">📦</span>
                              ) : (
                                <span className="text-slate-300 dark:text-gray-700">—</span>
                              )}
                            </td>

                            <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                              <Link to={`/dashboard/${row.session_id}`}
                                className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-slate-200 dark:border-gray-700 text-slate-400 hover:border-pink-400 hover:text-pink-600 transition-all"
                                title="Open session">
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Initial empty state ──────────────────────────────────────────── */}
        {results === null && !loading && (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-slate-100 dark:border-gray-800 p-16 text-center">
            <div className="text-6xl mb-4">🔍</div>
            <p className="text-slate-600 dark:text-gray-400 font-semibold text-base">
              Search across all expense claims
            </p>
            <p className="text-slate-400 dark:text-gray-600 text-sm mt-1">
              Use filters above — search by name, category, amount, date range
            </p>
            <div className="mt-6 flex flex-wrap gap-2 justify-center text-xs text-slate-400 dark:text-gray-600">
              <span>Try: "Rahul" → all Rahul's claims</span>
              <span>•</span>
              <span>"hotel &gt; ₹2000" → expensive hotel stays</span>
              <span>•</span>
              <span>"Last 3 months" preset → recent activity</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
