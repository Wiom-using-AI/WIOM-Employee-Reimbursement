import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useState, useLayoutEffect, useEffect } from "react";
import Navbar from "./components/Navbar";
import Upload from "./pages/Upload";
import Dashboard from "./pages/Dashboard";
import KekaPage from "./pages/Keka";
import LogsPage from "./pages/Logs";
import ConfigPage from "./pages/Config";
import Overview from "./pages/Overview";
import Login from "./pages/Login";
import AdminPage from "./pages/Admin";
import SessionHistory from "./pages/SessionHistory";
import GlobalSearch from "./pages/GlobalSearch";
import { authMe, getAuthToken, getAuthRole, getAuthUser, clearAuthToken } from "./services/api";

// AuthGate: blocks rendering until token is verified. Calls onAuth with {username, role} on success.
function AuthGate({ children, onAuth }) {
  const [state, setState] = useState({ loading: true, ok: false });
  const location = useLocation();

  useEffect(() => {
    const token = getAuthToken();
    if (!token) { setState({ loading: false, ok: false }); return; }
    authMe()
      .then((data) => {
        onAuth?.({ username: data.username, role: data.role });
        setState({ loading: false, ok: true });
      })
      .catch(() => { clearAuthToken(); setState({ loading: false, ok: false }); });
  }, [location.pathname]);

  if (state.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0d1117]">
        <svg className="w-8 h-8 animate-spin text-pink-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
      </div>
    );
  }
  if (!state.ok) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return children;
}

function applyTheme(dark) {
  if (dark) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export default function App() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("theme");
    return saved !== "light";
  });

  const [userInfo, setUserInfo] = useState({
    username: getAuthUser(),
    role: getAuthRole(),
  });

  // Always trust the role returned by the server. Never carry over role from a previous user.
  function mergeAuth({ username, role }) {
    setUserInfo({ username, role: role || "reviewer" });
  }

  useLayoutEffect(() => {
    applyTheme(dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  const toggleDark = () => {
    setDark((d) => {
      const next = !d;
      applyTheme(next);
      localStorage.setItem("theme", next ? "dark" : "light");
      return next;
    });
  };

  const isAdmin = userInfo.role === "admin";

  return (
    <div className={`min-h-screen flex flex-col ${dark ? "dark" : ""}`}>
      <Routes>
        {/* Public route */}
        <Route path="/login" element={<Login onLogin={mergeAuth} />} />

        {/* Protected routes */}
        <Route path="*" element={
          <AuthGate onAuth={mergeAuth}>
            <Navbar dark={dark} onToggleDark={toggleDark}
                    username={userInfo.username} role={userInfo.role} />
            <main className="flex-1">
              <Routes>
                <Route path="/" element={<Upload />} />
                <Route path="/dashboard/:sessionId" element={<Dashboard />} />
                <Route path="/keka" element={<KekaPage />} />
                <Route path="/logs" element={<LogsPage />} />
                <Route path="/config" element={
                  isAdmin ? <ConfigPage /> : <Navigate to="/" replace />
                } />
                <Route path="/overview" element={<Overview />} />
                <Route path="/history" element={<SessionHistory />} />
                <Route path="/search" element={<GlobalSearch />} />
                <Route path="/admin" element={
                  isAdmin ? <AdminPage /> : <Navigate to="/" replace />
                } />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
          </AuthGate>
        } />
      </Routes>
    </div>
  );
}
