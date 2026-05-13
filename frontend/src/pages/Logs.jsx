import { useState, useEffect, useRef, useCallback } from "react";

const BASE = import.meta.env.VITE_API_URL ?? "/api";

// ── Log line color coding ────────────────────────────────────────────────────
function classifyLine(line) {
  const l = line.toLowerCase();
  if (l.includes("[err]") || l.includes("error") || l.includes("exception") || l.includes("traceback") || l.includes("failed") || l.includes("econnrefused"))
    return "error";
  if (l.includes("warning") || l.includes("warn") || l.includes("deprecated"))
    return "warn";
  if (l.includes("200 ok") || l.includes("completed") || l.includes("approved") || l.includes("startup complete"))
    return "success";
  if (l.includes("[out]") || l.includes("info") || l.includes("starting") || l.includes("uvicorn"))
    return "info";
  if (l.includes("--- live tail") || l.includes("separator"))
    return "sep";
  return "default";
}

const lineClass = {
  error:   "text-red-400",
  warn:    "text-amber-400",
  success: "text-emerald-400",
  info:    "text-blue-400",
  sep:     "text-slate-500 italic border-t border-slate-700 pt-1 mt-1",
  default: "text-slate-300",
};

const logTagClass = {
  "[OUT]": "text-slate-500",
  "[ERR]": "text-red-500",
};

// ── Render a single log line with syntax-ish highlighting ────────────────────
function LogLine({ line, index }) {
  const cls = classifyLine(line);
  // Extract tag prefix like "[OUT] " or "[ERR] "
  const tagMatch = line.match(/^(\[(?:OUT|ERR|SYS)\])\s*/);
  const tag = tagMatch ? tagMatch[1] : null;
  const rest = tag ? line.slice(tagMatch[0].length) : line;

  return (
    <div className={`flex gap-2 py-[1px] hover:bg-white/[0.03] px-1 rounded group ${cls === "sep" ? "mt-2" : ""}`}>
      <span className="select-none text-slate-600 font-mono text-[10px] w-8 text-right shrink-0 pt-[1px] group-hover:text-slate-500">
        {index + 1}
      </span>
      <span className={`font-mono text-xs break-all whitespace-pre-wrap ${lineClass[cls]}`}>
        {tag && <span className={`mr-1 font-bold text-[10px] ${logTagClass[tag] || "text-slate-500"}`}>{tag}</span>}
        {rest}
      </span>
    </div>
  );
}

// ── Main Logs Page ─────────────────────────────────────────────────────────────
export default function LogsPage() {
  const [lines, setLines]           = useState([]);
  const [search, setSearch]         = useState("");
  const [fileFilter, setFileFilter] = useState("both");
  const [lineCount, setLineCount]   = useState(500);
  const [live, setLive]             = useState(false);
  const [loading, setLoading]       = useState(false);
  const [logInfo, setLogInfo]       = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const bottomRef  = useRef(null);
  const sseRef     = useRef(null);
  const linesRef   = useRef(lines);
  linesRef.current = lines;

  // ── Fetch snapshot ──────────────────────────────────────────────────────────
  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        lines: lineCount,
        file: fileFilter,
        search,
      });
      const resp = await fetch(`${BASE}/logs?${params}`);
      const data = await resp.json();
      const all = [];
      if (data.logs?.out) all.push(...data.logs.out);
      if (data.logs?.err) all.push(...data.logs.err.map(l => `[ERR] ${l}`));
      setLines(all);
    } catch (e) {
      setLines([`[Error] ${e.message}`]);
    }
    setLoading(false);
  }, [lineCount, fileFilter, search]);

  // ── Fetch log info ─────────────────────────────────────────────────────────
  const fetchInfo = useCallback(async () => {
    try {
      const resp = await fetch(`${BASE}/logs/info`);
      setLogInfo(await resp.json());
    } catch {}
  }, []);

  useEffect(() => {
    fetchLogs();
    fetchInfo();
  }, [fetchLogs, fetchInfo]);

  // ── SSE live stream ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!live) {
      sseRef.current?.close();
      sseRef.current = null;
      return;
    }

    setLines([]); // Clear on stream start
    const sse = new EventSource(`${BASE}/logs/stream?file=${fileFilter}&lines=${Math.min(lineCount, 200)}`);
    sseRef.current = sse;

    sse.onmessage = (e) => {
      const { line } = JSON.parse(e.data);
      setLines(prev => {
        const next = [...prev, line];
        return next.length > 5000 ? next.slice(-5000) : next; // cap at 5000 lines
      });
    };

    sse.onerror = () => {
      setLines(prev => [...prev, "[SSE connection lost — reconnecting…]"]);
    };

    return () => {
      sse.close();
    };
  }, [live, fileFilter, lineCount]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, autoScroll]);

  // ── Filtered lines ─────────────────────────────────────────────────────────
  const filteredLines = search && !live
    ? lines.filter(l => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  // ── Error / warn counts ───────────────────────────────────────────────────
  const errorCount = filteredLines.filter(l => classifyLine(l) === "error").length;
  const warnCount  = filteredLines.filter(l => classifyLine(l) === "warn").length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col" style={{ height: "calc(100vh - 4rem)" }}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span className="text-2xl">📋</span> App Logs
          </h2>
          <p className="text-xs text-slate-400 dark:text-gray-500 mt-0.5">
            Backend + Frontend logs — real-time
          </p>
        </div>

        {/* Log file info */}
        {logInfo && (
          <div className="flex gap-3 text-xs text-slate-400 dark:text-gray-500">
            <span>📄 out.log: <strong className="text-slate-600 dark:text-slate-300">{logInfo.out?.size_kb || 0} KB</strong></span>
            <span>📄 err.log: <strong className={logInfo.err?.size_bytes > 0 ? "text-red-400" : "text-slate-600 dark:text-slate-300"}>{logInfo.err?.size_kb || 0} KB</strong></span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* Live toggle */}
        <button
          onClick={() => setLive(l => !l)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            live
              ? "bg-red-600 text-white shadow-lg shadow-red-500/30"
              : "border border-slate-200 dark:border-gray-700 text-slate-600 dark:text-gray-300 hover:border-red-400 hover:text-red-600"
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${live ? "bg-white animate-pulse" : "bg-slate-400"}`} />
          {live ? "Stop Live" : "Live Stream"}
        </button>

        {/* File filter */}
        <div className="flex rounded-lg border border-slate-200 dark:border-gray-700 overflow-hidden text-xs">
          {["both", "out", "err"].map(f => (
            <button
              key={f}
              onClick={() => { setFileFilter(f); if (live) setLive(false); }}
              className={`px-2.5 py-1.5 font-medium transition-colors ${
                fileFilter === f
                  ? "bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900"
                  : "bg-white dark:bg-gray-800 text-slate-500 dark:text-gray-400 hover:bg-slate-50 dark:hover:bg-gray-700"
              }`}
            >
              {f === "both" ? "Both" : f === "out" ? "stdout" : "stderr"}
            </button>
          ))}
        </div>

        {/* Line count */}
        <select
          value={lineCount}
          onChange={e => setLineCount(Number(e.target.value))}
          disabled={live}
          className="px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value={100}>Last 100 lines</option>
          <option value={500}>Last 500 lines</option>
          <option value={1000}>Last 1000 lines</option>
          <option value={2000}>Last 2000 lines</option>
          <option value={5000}>Last 5000 lines</option>
          <option value={10000}>All logs</option>
        </select>

        {/* Search */}
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Filter logs…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Refresh */}
        {!live && (
          <button
            onClick={() => { fetchLogs(); fetchInfo(); }}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-gray-700 text-xs font-medium text-slate-600 dark:text-gray-300 hover:bg-slate-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            <svg className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        )}

        {/* Auto-scroll toggle */}
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-gray-400 cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={e => setAutoScroll(e.target.checked)}
            className="w-3.5 h-3.5 accent-blue-600"
          />
          Auto-scroll
        </label>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 text-[10px] font-mono mb-2 text-slate-400 dark:text-gray-600">
        <span>{filteredLines.length.toLocaleString()} lines</span>
        {errorCount > 0 && <span className="text-red-400">● {errorCount} errors</span>}
        {warnCount > 0  && <span className="text-amber-400">● {warnCount} warnings</span>}
        {live && <span className="text-red-400 animate-pulse">● LIVE</span>}
        {search && <span className="text-blue-400">filter: "{search}"</span>}
      </div>

      {/* Log viewport */}
      <div className="flex-1 overflow-y-auto bg-[#0d1117] dark:bg-[#0a0d12] rounded-xl border border-slate-200 dark:border-gray-800 p-2"
           onScroll={e => {
             const el = e.currentTarget;
             const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
             if (!atBottom && autoScroll) setAutoScroll(false);
           }}>
        {filteredLines.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 dark:text-slate-700 gap-3">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-sm">{loading ? "Loading logs…" : "No log lines found"}</p>
          </div>
        ) : (
          <>
            {filteredLines.map((line, i) => (
              <LogLine key={i} line={line} index={i} />
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between mt-2 text-[10px] text-slate-400 dark:text-gray-600 font-mono">
        <span>Log dir: <code className="text-slate-500">{logInfo ? "…/expense-validator/logs/" : "…/logs/"}</code></span>
        <div className="flex gap-3">
          <a
            href={`${BASE}/logs?file=both&lines=10000`}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-blue-400 transition-colors"
          >
            ↓ Download full log (JSON)
          </a>
        </div>
      </div>
    </div>
  );
}
