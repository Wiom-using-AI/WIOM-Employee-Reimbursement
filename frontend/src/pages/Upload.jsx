import { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { uploadFiles, pollStatus, checkDuplicates } from "../services/api";

const POLL_INTERVAL = 600;

const STEPS = [
  { num: 1, label: "Upload Files",  desc: "Excel + ZIP"    },
  { num: 2, label: "OCR Scanning",  desc: "Reading bills"  },
  { num: 3, label: "AI Validation", desc: "6-check engine" },
  { num: 4, label: "Results Ready", desc: "View dashboard" },
];

export default function Upload() {
  const navigate = useNavigate();
  const [excel,          setExcel]          = useState(null);
  const [zip,            setZip]            = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [phase,          setPhase]          = useState("idle"); // idle | checking | uploading | processing | error
  const [errorMsg,       setErrorMsg]       = useState("");
  const [currentStep,    setCurrentStep]    = useState("");
  const [dupResult,      setDupResult]      = useState(null);  // { total, duplicate_count, new_count, duplicates, skip_row_indices }
  const [showDupModal,   setShowDupModal]   = useState(false);
  const pollRef = useRef(null);

  // ── actual upload (called after duplicate decision) ──────────────────────────
  const _doUpload = async (skipRowIndices) => {
    setShowDupModal(false);
    setPhase("uploading");
    setUploadProgress(0);
    try {
      const { session_id } = await uploadFiles(excel, zip, setUploadProgress, skipRowIndices);
      setPhase("processing");
      pollRef.current = setInterval(async () => {
        try {
          const status = await pollStatus(session_id);
          if (status.current_step) setCurrentStep(status.current_step);
          if (status.processing_status === "completed") {
            clearInterval(pollRef.current);
            navigate(`/dashboard/${session_id}`);
          } else if (status.processing_status === "error") {
            clearInterval(pollRef.current);
            setPhase("error");
            setErrorMsg(status.error || "Validation failed");
          }
        } catch {
          clearInterval(pollRef.current);
          setPhase("error");
          setErrorMsg("Lost connection to server");
        }
      }, POLL_INTERVAL);
    } catch (err) {
      setPhase("error");
      setErrorMsg(err.response?.data?.detail || err.message || "Upload failed");
    }
  };

  // ── main submit: pre-flight duplicate check ───────────────────────────────────
  const handleSubmit = async () => {
    if (!excel || !zip) return;
    setErrorMsg("");
    setPhase("checking");
    try {
      const result = await checkDuplicates(excel);
      if (result.duplicate_count > 0) {
        setDupResult(result);
        setShowDupModal(true);
        setPhase("idle");      // reset while user decides
        return;
      }
      // No duplicates — go straight to upload
      await _doUpload([]);
    } catch {
      // If check endpoint fails (network / server), proceed without skip
      await _doUpload([]);
    }
  };

  const busy       = phase === "uploading" || phase === "processing" || phase === "checking";
  const activeStep = (phase === "idle" || phase === "error" || phase === "checking") ? 1
                   : phase === "uploading" ? 1
                   : phase === "processing" ? 2 : 4;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10">

      {/* Duplicate Modal */}
      {showDupModal && dupResult && (
        <DuplicateModal
          result={dupResult}
          onSkipDuplicates={() => _doUpload(dupResult.skip_row_indices)}
          onProcessAll={() => _doUpload([])}
          onCancel={() => { setShowDupModal(false); setPhase("idle"); }}
        />
      )}

      {/* ── Hero ── */}
      <div className="text-center mb-8 animate-slide-up">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-5 relative">
          <div className="absolute inset-0 rounded-2xl blur-xl opacity-40"
               style={{ background: "#e5007d" }} />
          <div className="relative w-16 h-16 rounded-2xl flex items-center justify-center"
               style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)", boxShadow: "0 8px 24px rgba(229,0,125,0.35)" }}>
            <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z" />
            </svg>
          </div>
        </div>

        <h1 className="text-3xl sm:text-4xl font-black mb-3 tracking-tight" style={{ color: "var(--text-main)" }}>
          Expense Validator
        </h1>
        <p className="text-sm sm:text-base leading-relaxed max-w-2xl mx-auto" style={{ color: "var(--text-sub)" }}>
          Upload your expense report &amp; bill ZIP — OCR, mapping, and validation runs automatically.
        </p>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-0 mt-6 max-w-sm mx-auto">
          {STEPS.map((s, i) => (
            <div key={s.num} className="flex items-center">
              <div className="flex flex-col items-center">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black transition-all duration-300"
                     style={{
                       background: s.num < activeStep ? "#10b981"
                                 : s.num === activeStep ? "linear-gradient(135deg,#ff4db8,#e5007d)"
                                 : "var(--border)",
                       color: s.num <= activeStep ? "white" : "var(--text-muted)",
                       boxShadow: s.num === activeStep ? "0 0 12px rgba(229,0,125,0.4)" : "none",
                     }}>
                  {s.num < activeStep ? "✓" : s.num}
                </div>
                <p className="text-[9px] font-semibold mt-1 whitespace-nowrap"
                   style={{ color: s.num === activeStep ? "#e5007d" : "var(--text-muted)" }}>
                  {s.label}
                </p>
              </div>
              {i < STEPS.length - 1 && (
                <div className="w-10 h-px mx-1 mb-4 transition-all duration-300"
                     style={{ background: s.num < activeStep ? "#10b981" : "var(--border)" }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Upload card ── */}
      <div className="card p-6 sm:p-7 space-y-4 animate-slide-up max-w-3xl mx-auto" style={{ animationDelay: "0.1s" }}>

        <div className="flex items-center justify-between gap-4 pb-2">
          <div>
            <p className="text-xs font-black uppercase tracking-widest" style={{ color: "#e5007d" }}>New validation</p>
            <h2 className="text-lg font-black mt-1" style={{ color: "var(--text-main)" }}>Start a batch</h2>
          </div>
          <span className="text-[11px] font-bold px-2.5 py-1 rounded-full"
                style={{ background: "rgba(229,0,125,0.09)", color: "#e5007d", border: "1px solid rgba(229,0,125,0.18)" }}>
            Secure upload
          </span>
        </div>

        <DropZone
          label="Expense Report"
          sublabel="Excel file (.xlsx) — from Keka or ERP export"
          accept=".xlsx,.xls"
          icon={<SheetIcon />}
          file={excel}
          onFile={setExcel}
          disabled={busy}
          accentColor="#e5007d"
        />

        <DropZone
          label="Bill Attachments"
          sublabel="ZIP archive — PDF, JPG, PNG receipts"
          accept=".zip"
          icon={<ZipIcon />}
          file={zip}
          onFile={setZip}
          disabled={busy}
          accentColor="#7c3aed"
        />

        {/* Error */}
        {phase === "error" && (
          <div className="flex items-start gap-3 p-4 rounded-xl text-sm"
               style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444" }}>
            <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div><strong>Error:</strong> {errorMsg}</div>
          </div>
        )}

        {/* Checking indicator */}
        {phase === "checking" && (
          <div className="flex items-center gap-3 p-4 rounded-xl"
               style={{ background: "rgba(229,0,125,0.06)", border: "1px solid rgba(229,0,125,0.18)" }}>
            <svg className="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24" style={{ color: "#e5007d" }}>
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <p className="text-sm font-semibold" style={{ color: "#e5007d" }}>
              Checking for duplicate claims…
            </p>
          </div>
        )}

        {/* Upload / Processing progress */}
        {(phase === "uploading" || phase === "processing") && (
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <p className="text-xs font-semibold" style={{ color: "var(--text-sub)" }}>
                {phase === "uploading"
                  ? `Uploading files… ${uploadProgress}%`
                  : currentStep || "Validating expenses…"}
              </p>
              {phase === "uploading" && (
                <span className="text-xs font-bold tabular-nums" style={{ color: "#e5007d" }}>{uploadProgress}%</span>
              )}
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
              {phase === "uploading" ? (
                <div className="h-full rounded-full transition-all duration-300"
                     style={{ width: `${uploadProgress}%`, background: "linear-gradient(90deg,#ff4db8,#e5007d)" }} />
              ) : (
                <div className="h-full w-1/3 rounded-full animate-bar-slide"
                     style={{ background: "linear-gradient(90deg,#ff4db8,#7c3aed)" }} />
              )}
            </div>
            {phase === "processing" && (
              <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                OCR scanning bills in parallel · AI validation running…
              </p>
            )}
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!excel || !zip || busy}
          className="btn-primary w-full justify-center py-3 text-sm"
        >
          {busy ? (
            <>
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              {phase === "checking" ? "Checking duplicates…"
             : phase === "uploading" ? "Uploading…"
             : "Validating…"}
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              Validate Expenses
            </>
          )}
        </button>

        {/* Feature pills */}
        <div className="flex flex-wrap gap-2 justify-center pt-1">
          {["OCR on every bill", "Fuzzy filename match", "Duplicate detection", "Excel + Sheets export"].map(f => (
            <span key={f} className="text-[11px] font-medium px-2.5 py-1 rounded-full"
                  style={{ background: "var(--bg-card2)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              {f}
            </span>
          ))}
        </div>
      </div>

      {/* ── Format guide ── */}
      <div className="card p-5 mt-4 animate-slide-up max-w-3xl mx-auto" style={{ animationDelay: "0.2s" }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: "var(--text-muted)" }}>
          Required Excel Columns
        </p>
        <div className="grid grid-cols-2 gap-y-1.5 gap-x-4">
          {[
            ["Employee Name",    true],
            ["Expense Date",     true],
            ["Expense Category", true],
            ["Claimed Amount",   true],
            ["Attachment Name",  true],
            ["Employee ID",      false],
            ["Description",      false],
            ["Claim Number",     false],
          ].map(([col, req]) => (
            <div key={col} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: req ? "#e5007d" : "var(--text-muted)" }} />
              <span className="text-xs" style={{ color: req ? "var(--text-main)" : "var(--text-muted)" }}>
                {col}
                {!req && <span className="text-[10px] ml-1" style={{ color: "var(--text-muted)" }}>(optional)</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Duplicate Claims Modal ─────────────────────────────────────────────────── */
function DuplicateModal({ result, onSkipDuplicates, onProcessAll, onCancel }) {
  const allDups = result.new_count === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backdropFilter: "blur(4px)" }}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />

      {/* Modal card */}
      <div className="relative card p-6 w-full max-w-lg flex flex-col animate-slide-up"
           style={{ zIndex: 51, maxHeight: "85vh" }}>

        {/* Header */}
        <div className="flex items-start gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-lg"
               style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.2)" }}>
            ⚠️
          </div>
          <div className="flex-1">
            <h3 className="font-black text-base" style={{ color: "var(--text-main)" }}>
              Duplicate Claims Detected
            </h3>
            <p className="text-sm mt-1 leading-relaxed" style={{ color: "var(--text-sub)" }}>
              {result.duplicate_count} claim{result.duplicate_count !== 1 ? "s" : ""} in this batch{" "}
              {result.duplicate_count !== 1 ? "were" : "was"} already processed in a previous batch.
              {!allDups && (
                <> <strong style={{ color: "var(--text-main)" }}>{result.new_count} new claim{result.new_count !== 1 ? "s" : ""}</strong> found.</>
              )}
            </p>
          </div>
          <button onClick={onCancel} className="p-1.5 rounded-lg shrink-0 transition-colors"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={e => e.currentTarget.style.color = "var(--text-main)"}
                  onMouseLeave={e => e.currentTarget.style.color = "var(--text-muted)"}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Duplicate list */}
        <div className="overflow-y-auto space-y-2 mb-5 pr-1" style={{ maxHeight: "320px" }}>
          {result.duplicates.map((d, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-xl"
                 style={{
                   background: "rgba(245,158,11,0.05)",
                   border: "1px solid rgba(245,158,11,0.15)",
                 }}>
              {/* Already-processed badge */}
              <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-black"
                   style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}>
                {i + 1}
              </div>

              {/* Claim details */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: "var(--text-main)" }}>
                  {d.employee_name}
                  {d.claim_number && (
                    <span className="ml-1.5 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
                      #{d.claim_number}
                    </span>
                  )}
                </p>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-sub)" }}>
                  {d.expense_category} · {d.expense_date} · ₹{Number(d.claimed_amount || 0).toLocaleString("en-IN")}
                </p>
              </div>

              {/* Status + date */}
              <div className="text-right shrink-0 space-y-1">
                <span className="inline-block text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={{
                        background: d.prev_status === "Approved"
                          ? "rgba(16,185,129,0.12)"
                          : d.prev_status === "Rejected"
                          ? "rgba(239,68,68,0.10)"
                          : "rgba(245,158,11,0.10)",
                        color: d.prev_status === "Approved" ? "#10b981"
                             : d.prev_status === "Rejected" ? "#ef4444"
                             : "#f59e0b",
                      }}>
                  {d.prev_status || "Processed"}
                </span>
                <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{d.prev_session_date}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div className="space-y-2.5">
          {!allDups ? (
            <button
              onClick={onSkipDuplicates}
              className="btn-primary w-full justify-center py-3"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              Process {result.new_count} New Claim{result.new_count !== 1 ? "s" : ""} Only
            </button>
          ) : (
            <div className="flex items-center gap-2 p-3 rounded-xl text-sm"
                 style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", color: "#f59e0b" }}>
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              All {result.total} claims are already in a previous batch.
            </div>
          )}

          <button onClick={onProcessAll} className="btn-secondary w-full justify-center py-2.5">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
            </svg>
            Process All {result.total} Claims Anyway
          </button>

          <button onClick={onCancel}
                  className="w-full text-sm py-2 text-center rounded-xl transition-colors"
                  style={{ color: "var(--text-muted)" }}
                  onMouseEnter={e => e.currentTarget.style.color = "var(--text-main)"}
                  onMouseLeave={e => e.currentTarget.style.color = "var(--text-muted)"}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Drop Zone ──────────────────────────────────────────────────────────────── */
function DropZone({ label, sublabel, accept, icon, file, onFile, disabled, accentColor }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    if (disabled) return;
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  }, [disabled, onFile]);

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={e => { e.preventDefault(); setDragging(false); }}
      className="relative flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all duration-150"
      style={{
        border: `1.5px dashed ${dragging || file ? accentColor : "var(--border)"}`,
        background: dragging ? `${accentColor}08` : file ? `${accentColor}05` : "var(--bg-card2)",
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: dragging ? `0 0 0 3px ${accentColor}20` : "none",
      }}
    >
      <input
        ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => e.target.files[0] && onFile(e.target.files[0])}
        disabled={disabled}
      />

      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
           style={{ background: `${accentColor}15`, color: accentColor, border: `1px solid ${accentColor}25` }}>
        {icon}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold mb-0.5" style={{ color: "var(--text-main)" }}>{label}</p>
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>{sublabel}</p>
        {file && (
          <p className="mt-1.5 text-xs font-medium truncate" style={{ color: accentColor }}>
            ✓ {file.name}
            <span className="ml-1" style={{ color: "var(--text-muted)" }}>({(file.size / 1024).toFixed(0)} KB)</span>
          </p>
        )}
      </div>

      {file ? (
        <button
          onClick={e => { e.stopPropagation(); onFile(null); }}
          disabled={disabled}
          className="p-1.5 rounded-lg transition-colors shrink-0"
          style={{ color: "var(--text-muted)" }}
          onMouseEnter={e => e.currentTarget.style.color = "#ef4444"}
          onMouseLeave={e => e.currentTarget.style.color = "var(--text-muted)"}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      ) : (
        <span className="text-[11px] font-bold shrink-0 px-2 py-1 rounded-lg"
              style={{ background: `${accentColor}12`, color: accentColor }}>
          {accept.toUpperCase().replace(/\./g, "").replace(/,/g, " · ")}
        </span>
      )}
    </div>
  );
}

function SheetIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0119 9.414V19a2 2 0 01-2 2z"/>
    </svg>
  );
}
function ZipIcon() {
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
    </svg>
  );
}
