import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  kekaConfig,
  kekaLoginStart, kekaLoginVerify, kekaLoginCaptcha,
  kekaPostmanInteractive, kekaPostmanStatus, kekaPostmanProcess, kekaPostmanDownloadUrl,
  pollStatus,
} from "../services/api";

function today() {
  return new Date().toISOString().slice(0, 10);
}
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function StatusBadge({ status }) {
  const map = {
    Approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
    Rejected: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    Flagged:  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${map[status] || "bg-slate-100 text-slate-500"}`}>
      {status}
    </span>
  );
}

function ConfigBadge({ config }) {
  if (!config) return null;
  if (config.configured) {
    const billOk     = config.bill_download_enabled;
    const sessionOn  = config.session_active;
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          Keka API Ready · {config.company}
        </span>
        {billOk && (
          <span className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${
            sessionOn
              ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
              : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
          }`}>
            <span className={`w-2 h-2 rounded-full ${sessionOn ? "bg-blue-500" : "bg-amber-500"}`} />
            {sessionOn ? "Session: Active" : "Session: Not logged in"}
          </span>
        )}
        {!billOk && (
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            Bill download: OFF (set KEKA_EMAIL+PASSWORD)
          </span>
        )}
      </div>
    );
  }
  const missing = config.missing_credentials || [];
  return (
    <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
      <span className="w-2 h-2 rounded-full bg-red-500" />
      .env mein set karo: {missing.join(", ") || "credentials missing"}
    </span>
  );
}

export default function KekaPage() {
  const navigate = useNavigate();

  const [fromDate, setFromDate] = useState(monthStart());
  const [toDate,   setToDate]   = useState(today());

  const [kekaConfigData, setKekaConfigData] = useState(null);
  useEffect(() => {
    kekaConfig().then(setKekaConfigData).catch(() => {});
  }, []);

  // Postman-style interactive download state
  const [postmanSessId,  setPostmanSessId]  = useState(null);
  const [postmanStatus,  setPostmanStatus]  = useState(null);   // full status object
  const [postmanRunning, setPostmanRunning] = useState(false);
  const [postmanError,   setPostmanError]   = useState("");
  const [stepLog,        setStepLog]        = useState([]);
  const postmanPollRef = useRef(null);
  const stepLogRef     = useRef(null);
  const lastStepRef    = useRef("");

  // 2FA login modal state
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginToken,     setLoginToken]     = useState("");
  const [loginOtp,       setLoginOtp]       = useState("");
  const [loginLoading,   setLoginLoading]   = useState(false);
  const [loginStep,      setLoginStep]      = useState("idle"); // "idle" | "captcha" | "otp_sent" | "verifying"
  const [loginMessage,   setLoginMessage]   = useState("");
  const [loginError,     setLoginError]     = useState("");
  const [captchaB64,     setCaptchaB64]     = useState("");
  const [captchaInput,   setCaptchaInput]   = useState("");

  async function handleLoginStart() {
    setLoginLoading(true);
    setLoginError("");
    setLoginStep("idle");
    setLoginMessage("");
    setCaptchaB64("");
    setCaptchaInput("");
    try {
      const res = await kekaLoginStart();
      if (res.status === "ok") {
        setLoginMessage("Already logged in!");
        setLoginStep("idle");
        setShowLoginModal(false);
        kekaConfig().then(setKekaConfigData).catch(() => {});
      } else if (res.status === "2fa_required") {
        setLoginToken(res.token);
        setLoginStep("otp_sent");
        setLoginMessage(res.message || "OTP sent to your email. Enter it below.");
      } else if (res.status === "captcha_required") {
        setLoginToken(res.token);
        setCaptchaB64(res.captcha_b64);
        setCaptchaInput("");
        setLoginStep("captcha");
        setLoginMessage(res.message || "Auto-solve failed. Type the captcha text below.");
      } else {
        setLoginError(res.message || "Login failed");
      }
    } catch (err) {
      setLoginError(err.response?.data?.detail || err.message || "Login failed");
    }
    setLoginLoading(false);
  }

  async function handleSubmitCaptcha() {
    if (!captchaInput.trim() || !loginToken) return;
    setLoginLoading(true);
    setLoginError("");
    try {
      const res = await kekaLoginCaptcha(loginToken, captchaInput.trim());
      if (res.status === "2fa_required") {
        setLoginToken(res.token);
        setLoginStep("otp_sent");
        setLoginMessage(res.message || "OTP sent to your email. Enter it below.");
        setCaptchaB64("");
      } else if (res.status === "captcha_required") {
        // Wrong captcha — show the new captcha image
        setLoginToken(res.token);
        setCaptchaB64(res.captcha_b64);
        setCaptchaInput("");
        setLoginError("Wrong captcha. Please try again with the new image.");
      } else if (res.status === "ok") {
        setShowLoginModal(false);
        setLoginStep("idle");
        kekaConfig().then(setKekaConfigData).catch(() => {});
      } else {
        setLoginError(res.message || "Captcha submission failed");
      }
    } catch (err) {
      setLoginError(err.response?.data?.detail || err.message || "Captcha submission failed");
    }
    setLoginLoading(false);
  }

  async function handleVerifyOtp() {
    if (!loginOtp.trim() || !loginToken) return;
    setLoginLoading(true);
    setLoginError("");
    setLoginStep("verifying");
    try {
      const res = await kekaLoginVerify(loginToken, loginOtp.trim());
      if (res.status === "ok") {
        setShowLoginModal(false);
        setLoginStep("idle");
        setLoginOtp("");
        setLoginToken("");
        setLoginMessage("");
        kekaConfig().then(setKekaConfigData).catch(() => {});
      } else {
        setLoginError(res.message || "OTP verification failed");
        setLoginStep("otp_sent");
      }
    } catch (err) {
      setLoginError(err.response?.data?.detail || err.message || "Verification failed");
      setLoginStep("otp_sent");
    }
    setLoginLoading(false);
  }

  function openLoginModal() {
    setShowLoginModal(true);
    setLoginStep("idle");
    setLoginOtp("");
    setLoginToken("");
    setLoginError("");
    setLoginMessage("");
    setCaptchaB64("");
    setCaptchaInput("");
  }

  // ── Postman-style interactive flow ────────────────────────────────────────
  async function handlePostmanFetch() {
    setPostmanRunning(true);
    setPostmanError("");
    setStepLog([]);
    lastStepRef.current = "";
    setPostmanStatus({ stage: "starting", current_step: "Backend mein automation shuru ho rahi hai…" });
    try {
      const { session_id } = await kekaPostmanInteractive(fromDate, toDate);
      setPostmanSessId(session_id);

      postmanPollRef.current = setInterval(async () => {
        try {
          const s = await kekaPostmanStatus(session_id);
          setPostmanStatus(s);
          // Append new steps to live log
          if (s.current_step && s.current_step !== lastStepRef.current) {
            lastStepRef.current = s.current_step;
            setStepLog(prev => [...prev, { msg: s.current_step, time: new Date().toLocaleTimeString() }]);
            setTimeout(() => {
              if (stepLogRef.current) stepLogRef.current.scrollTop = stepLogRef.current.scrollHeight;
            }, 50);
          }
          if (s.stage === "fetched" || s.stage === "no_download" || s.stage === "error") {
            clearInterval(postmanPollRef.current);
            setPostmanRunning(false);
            if (s.stage === "error") {
              setPostmanError(s.error || "Fetch failed");
            }
          }
        } catch (err) {
          clearInterval(postmanPollRef.current);
          setPostmanError("Lost connection during fetch");
          setPostmanRunning(false);
        }
      }, 2000);
    } catch (err) {
      setPostmanError(err.response?.data?.detail || err.message || "Fetch failed");
      setPostmanRunning(false);
    }
  }

  async function handlePostmanProcess() {
    if (!postmanSessId) return;
    setPostmanRunning(true);
    setPostmanError("");
    setPostmanStatus(prev => ({ ...prev, stage: "processing", current_step: "Starting validation…" }));
    try {
      await kekaPostmanProcess(postmanSessId);
      // Poll the regular session status to track validation
      postmanPollRef.current = setInterval(async () => {
        try {
          const s = await pollStatus(postmanSessId);
          setPostmanStatus(prev => ({ ...prev, current_step: s.current_step || "Processing…" }));
          if (s.processing_status === "completed") {
            clearInterval(postmanPollRef.current);
            setPostmanRunning(false);
            // Navigate to dashboard for the matched results
            navigate(`/dashboard/${postmanSessId}`);
          } else if (s.processing_status === "error") {
            clearInterval(postmanPollRef.current);
            setPostmanError(s.error || "Validation failed");
            setPostmanRunning(false);
          }
        } catch {
          clearInterval(postmanPollRef.current);
          setPostmanError("Lost connection during processing");
          setPostmanRunning(false);
        }
      }, 2000);
    } catch (err) {
      setPostmanError(err.response?.data?.detail || err.message || "Process failed");
      setPostmanRunning(false);
    }
  }

  function handlePostmanReset() {
    if (postmanPollRef.current) clearInterval(postmanPollRef.current);
    setPostmanSessId(null);
    setPostmanStatus(null);
    setPostmanRunning(false);
    setPostmanError("");
    setStepLog([]);
    lastStepRef.current = "";
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <span className="text-2xl">🔗</span> Keka Auto Sync
          </h2>
          <p className="text-sm text-slate-400 dark:text-gray-500 mt-0.5">
            Date select karo → Keka se claims fetch → OCR + validation → Dashboard
          </p>
        </div>
        <ConfigBadge config={kekaConfigData} />
      </div>

      {/* Sync Form */}
      <div className="card p-6 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
            />
          </div>
        </div>

        {/* ─── Auto Download ─── */}
        <div className="mt-5 pt-5 border-t border-slate-200 dark:border-gray-700">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 flex items-center gap-2">
                <span>🤖</span> Auto-Download from Keka
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300 uppercase tracking-wide">
                  Headless
                </span>
              </h3>
              <p className="text-xs text-slate-500 dark:text-gray-400 mt-1 leading-relaxed">
                Backend mein invisible browser chalega (koi window nahi khulegi) → Date set, <strong className="text-slate-600 dark:text-slate-300">In Approval Process</strong> filter, Run, Excel + Bulk Receipt ZIP sab auto-download → OCR + matching.
              </p>
            </div>
          </div>

          {!postmanStatus && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handlePostmanFetch}
                disabled={postmanRunning || !fromDate || !toDate || !kekaConfigData?.session_active}
                className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Start Auto-Download
              </button>

              {/* Always-visible login button — needed when server-side session expires despite local "Active" status */}
              <button
                onClick={openLoginModal}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                  kekaConfigData?.session_active
                    ? "border-slate-300 dark:border-gray-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-gray-700 bg-white dark:bg-gray-800"
                    : "border-amber-400 dark:border-amber-600 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                {kekaConfigData?.session_active ? "Re-login to Keka" : "⚠ Login to Keka"}
              </button>
            </div>
          )}

          {/* Progress Panel */}
          {postmanStatus && (
            <div className="rounded-xl border border-purple-200 dark:border-purple-800 bg-gradient-to-br from-purple-50 to-indigo-50 dark:from-purple-900/20 dark:to-indigo-900/20 overflow-hidden">

              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-purple-200 dark:border-purple-800">
                <div className="flex items-center gap-2.5">
                  {postmanRunning ? (
                    <svg className="w-4 h-4 animate-spin text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                  ) : postmanStatus.stage === "fetched" || postmanStatus.stage === "completed" ? (
                    <span className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[10px]">✓</span>
                  ) : postmanStatus.stage === "error" ? (
                    <span className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center text-white text-[10px]">✕</span>
                  ) : (
                    <span className="w-4 h-4 rounded-full bg-amber-400" />
                  )}
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    {postmanStatus.stage === "fetched"     ? "Download Complete" :
                     postmanStatus.stage === "error"       ? "Failed" :
                     postmanStatus.stage === "no_download" ? "Nothing Downloaded" :
                     postmanStatus.stage === "processing"  ? "OCR + Matching…" :
                     postmanStatus.stage === "completed"   ? "All Done ✓" :
                     "Running Automation…"}
                  </span>
                </div>
                {!postmanRunning && (
                  <button onClick={handlePostmanReset} className="text-xs text-slate-400 hover:text-red-500 transition-colors px-2 py-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20">
                    ✕ Reset
                  </button>
                )}
              </div>

              {/* Steps */}
              <div className="px-4 py-3">
                <div className="flex items-center gap-0 mb-4">
                  {[
                    { n: 1, label: "Excel", done: !!postmanStatus.downloaded_excel },
                    { n: 2, label: "ZIP",   done: !!postmanStatus.downloaded_zip },
                    { n: 3, label: "OCR",   done: postmanStatus.stage === "completed" },
                  ].map((step, i) => {
                    const active = postmanRunning && (
                      (step.n === 1 && !postmanStatus.downloaded_excel) ||
                      (step.n === 2 && postmanStatus.downloaded_excel && !postmanStatus.downloaded_zip) ||
                      (step.n === 3 && postmanStatus.stage === "processing")
                    );
                    return (
                      <div key={step.n} className="flex items-center flex-1">
                        <div className="flex flex-col items-center">
                          <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all ${
                            step.done  ? "bg-emerald-500 border-emerald-500 text-white" :
                            active     ? "bg-purple-500 border-purple-500 text-white animate-pulse" :
                                         "bg-white dark:bg-gray-800 border-slate-300 dark:border-gray-600 text-slate-400"
                          }`}>
                            {step.done ? "✓" : step.n}
                          </span>
                          <span className={`text-[10px] mt-1 font-medium ${step.done ? "text-emerald-600 dark:text-emerald-400" : active ? "text-purple-600 dark:text-purple-400" : "text-slate-400"}`}>
                            {step.label}
                          </span>
                        </div>
                        {i < 2 && (
                          <div className={`flex-1 h-0.5 mx-1 mb-4 transition-all ${step.done ? "bg-emerald-400" : "bg-slate-200 dark:bg-gray-700"}`} />
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Stats row */}
                {(postmanStatus.claims_count || postmanStatus.rows_count || postmanStatus.bills_downloaded) ? (
                  <div className="flex flex-wrap gap-2 mb-3">
                    {postmanStatus.claims_count > 0 && (
                      <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        {postmanStatus.claims_count} claims
                      </span>
                    )}
                    {postmanStatus.rows_count > 0 && (
                      <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-slate-100 text-slate-600 dark:bg-gray-700 dark:text-slate-300">
                        {postmanStatus.rows_count} rows
                      </span>
                    )}
                    {postmanStatus.bills_downloaded > 0 && (
                      <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        {postmanStatus.bills_downloaded} bill files
                      </span>
                    )}
                  </div>
                ) : null}

                {/* Live step log */}
                {stepLog.length > 0 && (
                  <div
                    ref={stepLogRef}
                    className="max-h-32 overflow-y-auto rounded-lg bg-black/5 dark:bg-black/30 border border-purple-200 dark:border-purple-900 p-2 space-y-0.5 mb-3"
                  >
                    {stepLog.map((entry, i) => (
                      <div key={i} className="flex items-start gap-2 text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed">
                        <span className="text-slate-400 dark:text-slate-600 shrink-0 font-mono">{entry.time}</span>
                        <span>{entry.msg}</span>
                      </div>
                    ))}
                    {postmanRunning && (
                      <div className="flex items-center gap-1.5 text-[11px] text-purple-600 dark:text-purple-400 pt-0.5">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500 animate-ping" />
                        Working…
                      </div>
                    )}
                  </div>
                )}

                {/* Action buttons */}
                {postmanStatus.stage === "fetched" && !postmanRunning && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handlePostmanProcess}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors shadow-sm"
                    >
                      🚀 Run OCR + Matching
                    </button>
                    {postmanSessId && (
                      <>
                        <a href={kekaPostmanDownloadUrl(postmanSessId, "input")} download
                          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-white dark:bg-gray-800 hover:bg-slate-50 dark:hover:bg-gray-700 border border-slate-200 dark:border-gray-600 text-slate-700 dark:text-slate-200 transition-colors">
                          ⬇ Input Folder
                        </a>
                        <a href={kekaPostmanDownloadUrl(postmanSessId, "output")} download
                          className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-white dark:bg-gray-800 hover:bg-slate-50 dark:hover:bg-gray-700 border border-slate-200 dark:border-gray-600 text-slate-700 dark:text-slate-200 transition-colors">
                          ⬇ Output Folder
                        </a>
                      </>
                    )}
                  </div>
                )}

                {postmanStatus.stage === "no_download" && (
                  <div className="p-2.5 text-xs rounded-lg bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300">
                    Kuch download nahi hua — automation mein issue. Reset karke retry karo.
                  </div>
                )}

                {/* Session-expired prompt — most actionable error */}
                {postmanStatus.stage === "session_expired" && (
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/30 border-2 border-amber-300 dark:border-amber-700 space-y-2">
                    <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200">
                      <span className="text-lg leading-none">🔐</span>
                      <div>
                        <strong className="block">Keka session expired</strong>
                        <span className="text-xs opacity-90">
                          Server-side cookies invalid ho gaye. Fresh OTP login chahiye — uske baad turant retry kar sakte ho.
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => { openLoginModal(); handlePostmanReset(); }}
                      className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                              d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                      </svg>
                      Login to Keka (send OTP)
                    </button>
                  </div>
                )}

                {postmanStatus.stage === "error" && postmanError && (
                  <div className="p-2.5 text-xs rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 font-mono break-all">
                    {postmanError}
                  </div>
                )}
              </div>
            </div>
          )}

          {postmanError && !postmanStatus && (
            <div className="mt-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
              {postmanError}
            </div>
          )}
        </div>

      </div>


      {/* 2FA Login Modal */}
      {showLoginModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-base font-bold text-slate-800 dark:text-slate-100">
                  Login to Keka
                </h3>
                <p className="text-sm text-slate-500 dark:text-gray-400 mt-0.5">
                  Required to download bill PDFs
                </p>
              </div>
              <button
                onClick={() => setShowLoginModal(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-gray-300 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {loginError && (
              <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
                {loginError}
              </div>
            )}

            {loginStep === "idle" && (
              <>
                <p className="text-sm text-slate-600 dark:text-slate-300 mb-5">
                  App will open Keka in a headless browser, solve the captcha, and send an OTP to{" "}
                  <strong className="text-slate-800 dark:text-slate-100">your registered email</strong>.
                  This takes about 10–15 seconds.
                </p>
                <div className="flex gap-3 justify-end">
                  <button onClick={() => setShowLoginModal(false)} className="btn-secondary text-sm">Cancel</button>
                  <button
                    onClick={handleLoginStart}
                    disabled={loginLoading}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {loginLoading ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                        </svg>
                        Logging in…
                      </>
                    ) : "Send OTP to Email"}
                  </button>
                </div>
              </>
            )}

            {loginStep === "captcha" && (
              <>
                <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-700 dark:text-amber-300">
                  Auto-solve failed. Type the characters from the image below.
                </div>
                {captchaB64 && (
                  <div className="mb-4 flex flex-col items-center gap-2">
                    <div className="border-2 border-slate-200 dark:border-gray-600 rounded-lg p-3 bg-white dark:bg-gray-800">
                      <img
                        src={`data:image/png;base64,${captchaB64}`}
                        alt="Captcha"
                        className="max-w-full"
                        style={{ imageRendering: "pixelated", minHeight: "40px" }}
                      />
                    </div>
                    <p className="text-xs text-slate-400 dark:text-slate-500">
                      Blurry? The app already tried to enlarge it — just type what you see.
                    </p>
                  </div>
                )}
                <div className="mb-5">
                  <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
                    Captcha Text
                  </label>
                  <input
                    type="text"
                    value={captchaInput}
                    onChange={e => setCaptchaInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSubmitCaptcha()}
                    placeholder="Type the characters shown above"
                    maxLength={10}
                    autoFocus
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-amber-400 focus:border-transparent outline-none text-center tracking-widest text-lg font-mono"
                  />
                </div>
                <div className="flex gap-3 justify-between">
                  <button
                    onClick={() => { setLoginStep("idle"); setCaptchaB64(""); setCaptchaInput(""); }}
                    disabled={loginLoading}
                    className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-gray-300 transition-colors"
                  >
                    Try auto-solve again
                  </button>
                  <div className="flex gap-3">
                    <button onClick={() => setShowLoginModal(false)} className="btn-secondary text-sm">Cancel</button>
                    <button
                      onClick={handleSubmitCaptcha}
                      disabled={loginLoading || !captchaInput.trim()}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {loginLoading ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                          </svg>
                          Submitting…
                        </>
                      ) : "Submit Captcha"}
                    </button>
                  </div>
                </div>
              </>
            )}

            {(loginStep === "otp_sent" || loginStep === "verifying") && (
              <>
                <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm text-blue-700 dark:text-blue-300">
                  {loginMessage}
                </div>
                <div className="mb-5">
                  <label className="block text-xs font-semibold text-slate-500 dark:text-gray-400 mb-1.5 uppercase tracking-wide">
                    Enter OTP
                  </label>
                  <input
                    type="text"
                    value={loginOtp}
                    onChange={e => setLoginOtp(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleVerifyOtp()}
                    placeholder="6-digit code from email"
                    maxLength={8}
                    autoFocus
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-center tracking-widest text-lg font-mono"
                  />
                </div>
                <div className="flex gap-3 justify-between">
                  <button
                    onClick={() => setLoginStep("idle")}
                    disabled={loginLoading}
                    className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-gray-300 transition-colors"
                  >
                    Resend OTP
                  </button>
                  <div className="flex gap-3">
                    <button onClick={() => setShowLoginModal(false)} className="btn-secondary text-sm">Cancel</button>
                    <button
                      onClick={handleVerifyOtp}
                      disabled={loginLoading || !loginOtp.trim()}
                      className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {loginLoading ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                          </svg>
                          Verifying…
                        </>
                      ) : "Verify & Login"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

