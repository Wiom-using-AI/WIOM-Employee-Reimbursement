import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { authLogin } from "../services/api";

export default function Login({ onLogin }) {
  const navigate   = useNavigate();
  const location   = useLocation();
  const redirectTo = location.state?.from || "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd,  setShowPwd]  = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  async function handleLogin(e) {
    e.preventDefault();
    if (!username.trim() || !password) { setError("Username and password are required"); return; }
    setLoading(true); setError("");
    try {
      const data = await authLogin(username.trim(), password);
      onLogin?.({ username: data.username, role: data.role });
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.response?.data?.detail || err.message || "Invalid credentials");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex" style={{ background: "var(--bg-base)" }}>

      {/* Left panel - brand */}
      <div className="hidden lg:flex lg:w-[52%] relative overflow-hidden flex-col justify-between p-12"
           style={{ background: "linear-gradient(145deg, #0a0f1e 0%, #120820 50%, #1a0530 100%)" }}>

        {/* Decorative circles */}
        <div className="absolute top-0 right-0 w-96 h-96 rounded-full opacity-20 blur-3xl"
             style={{ background: "radial-gradient(circle, #e5007d, transparent 70%)", transform: "translate(30%,-30%)" }} />
        <div className="absolute bottom-0 left-0 w-72 h-72 rounded-full opacity-15 blur-3xl"
             style={{ background: "radial-gradient(circle, #7c3aed, transparent 70%)", transform: "translate(-30%,30%)" }} />
        <div className="absolute top-1/2 left-1/2 w-64 h-64 rounded-full opacity-10 blur-2xl"
             style={{ background: "radial-gradient(circle, #ff4db8, transparent 70%)", transform: "translate(-50%,-50%)" }} />

        {/* Logo */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
               style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)", boxShadow: "0 4px 16px rgba(229,0,125,0.4)" }}>
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
          </div>
          <div>
            <p className="text-white font-black text-xl tracking-tight">Wiom</p>
            <p className="text-xs font-semibold tracking-widest uppercase" style={{ color: "#e5007d" }}>Finance</p>
          </div>
        </div>

        {/* Center hero text */}
        <div className="relative z-10 flex-1 flex flex-col justify-center max-w-sm">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full mb-6 w-fit"
               style={{ background: "rgba(229,0,125,0.15)", border: "1px solid rgba(229,0,125,0.3)" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-pink-400 animate-pulse" />
            <span className="text-xs font-semibold text-pink-300">AI-Powered · Live</span>
          </div>

          <h1 className="text-4xl font-black text-white leading-tight mb-4">
            Expense<br />
            <span style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>
              Validator
            </span>
          </h1>
          <p className="text-base leading-relaxed mb-8" style={{ color: "#8ba0c0" }}>
            Upload. Validate. Approve. Push to Zoho — all from one screen. Built for Wiom's finance team.
          </p>

          {/* Feature list */}
          <div className="space-y-3">
            {[
              { icon: "🔍", text: "OCR on every bill — auto amount matching" },
              { icon: "⚡", text: "50 claims validated in ~90 seconds" },
              { icon: "🔗", text: "Keka + Zoho Books integrated" },
              { icon: "🛡️", text: "Role-based access — Admin & Reviewer" },
            ].map(f => (
              <div key={f.text} className="flex items-center gap-3">
                <span className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
                      style={{ background: "rgba(229,0,125,0.12)", border: "1px solid rgba(229,0,125,0.2)" }}>
                  {f.icon}
                </span>
                <span className="text-sm" style={{ color: "#8ba0c0" }}>{f.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom stats */}
        <div className="relative z-10 flex gap-8">
          {[["~97%", "Time saved"], ["6", "Validation checks"], ["3", "Export formats"]].map(([val, lbl]) => (
            <div key={lbl}>
              <p className="text-xl font-black text-white">{val}</p>
              <p className="text-xs" style={{ color: "#4d6080" }}>{lbl}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Right panel - form */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 lg:px-16">

        {/* Mobile logo */}
        <div className="flex lg:hidden items-center gap-3 mb-10">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center"
               style={{ background: "linear-gradient(135deg,#ff4db8,#e5007d)" }}>
            <svg className="w-4.5 h-4.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
          </div>
          <div>
            <p className="text-lg font-black" style={{ color: "var(--text-main)" }}>Wiom Finance</p>
            <p className="text-[10px] font-bold tracking-widest uppercase" style={{ color: "#e5007d" }}>Expense Validator</p>
          </div>
        </div>

        <div className="w-full max-w-sm animate-slide-up">
          <div className="mb-8">
            <h2 className="text-2xl font-black mb-1.5" style={{ color: "var(--text-main)" }}>Welcome back</h2>
            <p className="text-sm" style={{ color: "var(--text-sub)" }}>Sign in to your finance dashboard</p>
          </div>

          {error && (
            <div className="mb-5 flex items-start gap-3 px-4 py-3 rounded-xl text-sm"
                 style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#ef4444" }}>
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd"/>
              </svg>
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold mb-2 uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
                Username
              </label>
              <input
                type="text" value={username} onChange={e => setUsername(e.target.value)}
                disabled={loading} autoFocus autoComplete="username" placeholder="admin"
                className="input-field"
              />
            </div>

            <div>
              <label className="block text-xs font-bold mb-2 uppercase tracking-widest" style={{ color: "var(--text-muted)" }}>
                Password
              </label>
              <div className="relative">
                <input
                  type={showPwd ? "text" : "password"} value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={loading} autoComplete="current-password" placeholder="••••••••"
                  className="input-field pr-11"
                />
                <button type="button" onClick={() => setShowPwd(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg transition-colors"
                  style={{ color: "var(--text-muted)" }}>
                  {showPwd ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="btn-primary w-full justify-center py-3 text-base mt-2"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  Signing in…
                </>
              ) : "Sign In →"}
            </button>
          </form>

          <p className="mt-8 text-center text-xs" style={{ color: "var(--text-muted)" }}>
            🔒 Sessions expire after 24 hours · Wiom Finance v1.0
          </p>
        </div>
      </div>
    </div>
  );
}
