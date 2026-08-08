import React, { useState, useEffect, useRef } from "react";

import {
  Users, Building2, FileText, AlertTriangle, CheckCircle2, Plus, X,
  Pencil, Trash2, Search, ShieldCheck, Printer,
  LayoutDashboard, ClipboardList, Info, Download,
  GraduationCap, LogOut, Lock, Mail
} from "lucide-react";

const API_BASE = (import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "/api" : "http://localhost:80/api")).replace(/\/$/, "");

/* Helper HTTP Request Wrapper */
async function apiFetch(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include" // Send HttpOnly Cookie across requests
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${endpoint}`, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "An API error occurred");
  return data;
}

/* Utilities */
const todayISO = () => new Date().toISOString().slice(0, 10);
function daysBetween(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / 86400000);
}
function fmtDate(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function rtwInfo(staff) {
  const rtw = staff.rtw || {};
  if (rtw.checkType === "not-required") return { label: "Not required — British / Irish citizen", tone: "neutral", days: null };
  if (rtw.noTimeLimit) return { label: "No time limit on right to work", tone: "good", days: null };
  if (!rtw.expiryDate) return { label: "Expiry date not recorded", tone: "unknown", days: null };
  const days = daysBetween(rtw.expiryDate);
  if (days < 0) return { label: `Expired ${fmtDate(rtw.expiryDate)}`, tone: "bad", days };
  if (days <= 90) return { label: `Expires ${fmtDate(rtw.expiryDate)} · ${days}d left`, tone: "warn", days };
  return { label: `Valid until ${fmtDate(rtw.expiryDate)}`, tone: "good", days };
}

function trainingStatus(expiryDate) {
  if (!expiryDate) return { label: "No expiry", tone: "neutral" };
  const days = daysBetween(expiryDate);
  if (days < 0) return { label: `Expired (${fmtDate(expiryDate)})`, tone: "bad" };
  if (days <= 30) return { label: `Expires soon (${days}d left)`, tone: "warn" };
  return { label: `Valid until ${fmtDate(expiryDate)}`, tone: "good" };
}

const TONE = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/30",
  bad: "bg-rose-50 text-rose-700 ring-rose-600/20",
  neutral: "bg-slate-100 text-slate-600 ring-slate-500/20",
  unknown: "bg-slate-50 text-slate-500 ring-slate-400/30",
};

function Badge({ tone, children }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset whitespace-nowrap ${TONE[tone]}`}>
      {children}
    </span>
  );
}

function StatusBadge({ status }) {
  if (status === "signed") return <Badge tone="good">Signed</Badge>;
  return <Badge tone="warn">Awaiting signature</Badge>;
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className={`w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-xl`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";
const labelCls = "mb-1 block text-xs font-medium text-slate-600";
const btnPrimary = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300";
const btnSecondary = "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50";
const btnDanger = "rounded-lg border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50";

function Field({ label, children, className = "" }) {
  return (
    <div className={`mb-3 ${className}`.trim()}>
      <label className={labelCls}>{label}</label>
      {children}
    </div>
  );
}

function EmptyState({ icon: Icon, title, body, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
      <Icon size={28} className="mb-3 text-slate-400" />
      <p className="font-semibold text-slate-700">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{body}</p>
      {action}
    </div>
  );
}

function SignaturePad({ onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasDrawn = useRef(false);

  useEffect(() => {
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1e293b";
  }, []);

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const start = (e) => {
    e.preventDefault();
    drawing.current = true;
    const { x, y } = getPos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const { x, y } = getPos(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineTo(x, y);
    ctx.stroke();
    hasDrawn.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (hasDrawn.current) onChange(canvasRef.current.toDataURL("image/png"));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    hasDrawn.current = false;
    onChange(null);
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={600}
        height={170}
        className="h-40 w-full touch-none rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 cursor-crosshair"
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      <button type="button" onClick={clear} className="mt-2 text-xs font-medium text-slate-500 hover:text-slate-700">Clear signature</button>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Login Component                                                        */
/* ---------------------------------------------------------------------- */

function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [requires2FA, setRequires2FA] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [mode, setMode] = useState("login");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSuccessMessage("");
    try {
      const data = await apiFetch("/auth/login", "POST", { email, password });
      if (data.requires2FA) {
        setPendingEmail(email);
        setRequires2FA(true);
        setCode(data.code || "");
        setSuccessMessage(data.message || "A verification code is ready.");
        return;
      }
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("reset") || params.get("setPassword") || "";
    if (token) {
      setResetToken(token);
      setMode("reset");
      setShowForgotPassword(false);
    }
  }, []);

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setError("");
    setSuccessMessage("");
    try {
      await apiFetch("/auth/forgot-password", "POST", { email: resetEmail });
      setSuccessMessage("If an account exists for that email, a reset link has been sent.");
      setShowForgotPassword(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError("");
    setSuccessMessage("");
    try {
      const data = await apiFetch("/auth/reset-password", "POST", { token: resetToken, password: newPassword });
      setSuccessMessage(data.message || "Password updated successfully");
      setMode("login");
      setPassword("");
      setNewPassword("");
      setResetToken("");
    } catch (err) {
      setError(err.message);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const data = await apiFetch("/auth/verify-2fa", "POST", { email: pendingEmail, code });
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4 font-sans text-slate-900">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 text-amber-400">
            <ShieldCheck size={26} />
          </div>
          <h1 className="text-xl font-bold text-slate-900">HR &amp; Compliance Portal</h1>
          <p className="mt-1 text-xs text-slate-500">Secure sign-in using your portal credentials</p>
        </div>

        {error && <div className="mb-4 rounded-lg bg-rose-50 p-3 text-xs font-medium text-rose-700 ring-1 ring-rose-200">{error}</div>}
        {successMessage && <div className="mb-4 rounded-lg bg-emerald-50 p-3 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">{successMessage}</div>}

        {mode === "reset" ? (
          <form onSubmit={handleResetPassword} className="space-y-4">
            <Field label="New Password">
              <input type="password" required className={`${inputCls}`} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Create a password" />
            </Field>
            <button type="submit" className={`${btnPrimary} w-full py-2.5`}>Save password</button>
            <button type="button" onClick={() => { setMode("login"); setResetToken(""); }} className={`${btnSecondary} w-full`}>Back to sign in</button>
          </form>
        ) : showForgotPassword ? (
          <form onSubmit={handleForgotPassword} className="space-y-4">
            <Field label="Email Address">
              <input type="email" required className={`${inputCls}`} value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} placeholder="name@your-company.com" />
            </Field>
            <button type="submit" className={`${btnPrimary} w-full py-2.5`}>Send reset link</button>
            <button type="button" onClick={() => setShowForgotPassword(false)} className={`${btnSecondary} w-full`}>Back to sign in</button>
          </form>
        ) : requires2FA ? (
          <form onSubmit={handleVerify} className="space-y-4">
            <Field label="Verification Code">
              <input className={`${inputCls} tracking-[0.3em]`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" maxLength={6} />
            </Field>
            <button type="submit" className={`${btnPrimary} w-full py-2.5`}>Verify Code</button>
            <button type="button" onClick={() => setRequires2FA(false)} className={`${btnSecondary} w-full`}>Back</button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Email Address">
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="email" required className={`${inputCls} pl-9`} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@your-company.com" />
              </div>
            </Field>
            <Field label="Password">
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="password" required className={`${inputCls} pl-9`} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
            </Field>
            <button type="submit" className={`${btnPrimary} w-full py-2.5`}>Sign In</button>
            <button type="button" onClick={() => { setShowForgotPassword(true); setResetEmail(email); }} className="w-full text-center text-sm font-medium text-slate-600 hover:text-slate-900">Forgot password?</button>
          </form>
        )}

      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Main Client Application                                                */
/* ---------------------------------------------------------------------- */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState(null);
  const [dir, setDir] = useState({ sites: [], staff: [] });
  const [contracts, setContracts] = useState({ templates: [], instances: [] });
  const [adminUsers, setAdminUsers] = useState([]);
  const [tab, setTab] = useState("dashboard");
  const [staffTab, setStaffTab] = useState("my-details");
  const [contractsSubTab, setContractsSubTab] = useState("templates");
  const [toast, setToast] = useState(null);

  const [staffModal, setStaffModal] = useState(null);
  const [siteModal, setSiteModal] = useState(false);
  const [businessUserModal, setBusinessUserModal] = useState(false);
  const [templateModal, setTemplateModal] = useState(null);
  const [assignModal, setAssignModal] = useState(null);
  const [uploadContractModal, setUploadContractModal] = useState(false);
  const [signModal, setSignModal] = useState(null);
  const [viewContractId, setViewContractId] = useState(null);
  const [verifyStaffId, setVerifyStaffId] = useState(null);
  const [trainingModal, setTrainingModal] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const loadData = async (user = currentUser) => {
    try {
      const requests = [apiFetch("/directory"), apiFetch("/contracts")];
      if (user?.role === "admin") requests.push(apiFetch("/admin-users"));
      const [dirRes, contractRes, adminUsersRes] = await Promise.all(requests);
      setDir(dirRes);
      setContracts(contractRes);
      if (adminUsersRes) setAdminUsers(adminUsersRes.users || []);
      else setAdminUsers([]);
    } catch (err) {
      showToast(err.message);
    }
  };

  useEffect(() => {
    apiFetch("/auth/me")
      .then((res) => {
        setCurrentUser(res.user);
        return loadData(res.user);
      })
      .catch(() => setCurrentUser(null))
      .finally(() => setLoading(false));
  }, []);

  const handleLoginSuccess = async (user) => {
    setCurrentUser(user);
    if (user.role === "admin" || user.role === "subadmin") setTab("dashboard");
    else setStaffTab("my-details");
    await loadData(user);
  };

  const handleLogout = async () => {
    await apiFetch("/auth/logout", "POST");
    setCurrentUser(null);
  };

  /* CRUD Handlers interfacing REST API */
  const saveStaff = async (staffData) => {
    const isEdit = dir.staff.some((s) => s.id === staffData.id);
    if (isEdit) {
      await apiFetch(`/staff/${staffData.id}`, "PUT", staffData);
    } else {
      await apiFetch("/staff", "POST", staffData);
    }
    setStaffModal(null);
    await loadData();
    showToast(isEdit ? "Staff updated" : "Staff added");
  };

  const deleteStaff = async (id) => {
    await apiFetch(`/staff/${id}`, "DELETE");
    setConfirmDelete(null);
    await loadData();
    showToast("Staff deleted");
  };

  const verifyRtw = async (staffId, verifiedBy, notes = "") => {
    await apiFetch(`/staff/${staffId}/rtw-verify`, "POST", { verifiedBy, notes });
    setVerifyStaffId(null);
    await loadData();
    showToast("Verification saved");
  };

  const saveTraining = async (staffId, record) => {
    await apiFetch(`/staff/${staffId}/training`, "POST", record);
    setTrainingModal(null);
    await loadData();
    showToast("Training recorded");
  };

  const deleteTraining = async (staffId, recordId) => {
    await apiFetch(`/staff/${staffId}/training/${recordId}`, "DELETE");
    await loadData();
    showToast("Training removed");
  };

  const saveSite = async (siteData) => {
    await apiFetch("/sites", "POST", siteData);
    setSiteModal(false);
    await loadData();
    showToast("Location added");
  };

  const saveSubAdmin = async (payload) => {
    await apiFetch("/admin-users", "POST", payload);
    setBusinessUserModal(false);
    await loadData();
    showToast("Business user created");
  };

  const deleteSite = async (id) => {
    try {
      await apiFetch(`/sites/${id}`, "DELETE");
      setConfirmDelete(null);
      await loadData();
      showToast("Location removed");
    } catch (err) {
      showToast(err.message);
    }
  };

  const saveTemplate = async (templateData) => {
    await apiFetch("/contracts/templates", "POST", templateData);
    setTemplateModal(null);
    await loadData();
    showToast("Template saved");
  };

  const assignTemplate = async (templateId, staffId) => {
    await apiFetch("/contracts/assign", "POST", { templateId, staffId });
    setAssignModal(null);
    await loadData();
    showToast("Contract assigned");
  };

  const toBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
  });

  const uploadContract = async ({ title, staffId, file }) => {
    const documentBase64 = await toBase64(file);
    await apiFetch("/docusign/send-envelope", "POST", { staffId, title, documentBase64, fileName: file.name });
    setUploadContractModal(false);
    await loadData();
    showToast("Contract sent and assigned");
  };

  const signContract = async (instanceId, payload) => {
    await apiFetch(`/contracts/${instanceId}/sign`, "POST", payload);
    setSignModal(null);
    await loadData();
    showToast("Contract signed");
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
      </div>
    );
  }

  if (!currentUser) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />;
  }

  const hasAdminAccess = currentUser.role === "admin" || currentUser.role === "subadmin";
  const staffMember = currentUser.role === "staff" ? dir.staff.find((s) => s.id === currentUser.staffId) : null;

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-amber-400">
              <ShieldCheck size={18} />
            </div>
            <div>
              <p className="text-sm font-bold leading-tight text-slate-900">Staff Portal (Client/Server API)</p>
              <p className="text-[11px] leading-tight text-slate-400">Role: {currentUser.role}</p>
            </div>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            <LogOut size={14} /> Sign out
          </button>
        </div>

        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 pb-2">
          {hasAdminAccess ? (
            <>
              <NavBtn active={tab === "dashboard"} onClick={() => setTab("dashboard")} icon={LayoutDashboard} label="Dashboard" />
              <NavBtn active={tab === "staff"} onClick={() => setTab("staff")} icon={Users} label="Staff" />
              <NavBtn active={tab === "rtw"} onClick={() => setTab("rtw")} icon={ShieldCheck} label="Right to work" />
              <NavBtn active={tab === "training"} onClick={() => setTab("training")} icon={GraduationCap} label="Training" />
              <NavBtn active={tab === "contracts"} onClick={() => setTab("contracts")} icon={FileText} label="Contracts" />
              <NavBtn active={tab === "sites"} onClick={() => setTab("sites")} icon={Building2} label="Business" />
            </>
          ) : (
            <>
              <NavBtn active={staffTab === "my-details"} onClick={() => setStaffTab("my-details")} icon={Users} label="My details" />
              <NavBtn active={staffTab === "my-training"} onClick={() => setStaffTab("my-training")} icon={GraduationCap} label="My training" />
              <NavBtn active={staffTab === "my-contracts"} onClick={() => setStaffTab("my-contracts")} icon={FileText} label="My contracts" />
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {hasAdminAccess && tab === "dashboard" && <Dashboard dir={dir} contracts={contracts} goTab={setTab} />}
        {hasAdminAccess && tab === "staff" && (
          <StaffTab
            dir={dir}
            onAdd={() => setStaffModal("new")}
            onEdit={(id) => setStaffModal(id)}
            onDelete={(s) => setConfirmDelete({ type: "staff", id: s.id, label: `${s.firstName} ${s.lastName}` })}
          />
        )}
        {hasAdminAccess && tab === "rtw" && <RtwTab dir={dir} onVerify={(id) => setVerifyStaffId(id)} />}
        {hasAdminAccess && tab === "training" && (
          <TrainingAdminTab
            dir={dir}
            onAddTraining={(staffId) => setTrainingModal({ staffId })}
            onDeleteTraining={(staffId, recordId) => deleteTraining(staffId, recordId)}
          />
        )}
        {hasAdminAccess && tab === "contracts" && (
          <ContractsAdminTab
            contracts={contracts}
            subTab={contractsSubTab} setSubTab={setContractsSubTab}
            onNewTemplate={() => setTemplateModal("new")}
            onAssign={(id) => setAssignModal(id)}
            onUpload={() => setUploadContractModal(true)}
            onView={(id) => setViewContractId(id)}
            onDownload={(id) => window.open(`${API_BASE.replace("/api", "")}/contracts/${id}/download`, "_blank")}
          />
        )}
        {hasAdminAccess && tab === "sites" && (
          <SitesTab dir={dir} adminUsers={adminUsers} onAdd={() => setSiteModal(true)} onDelete={(s) => setConfirmDelete({ type: "site", id: s.id, label: s.name })} onAddSubAdmin={() => setBusinessUserModal(true)} />
        )}

        {currentUser.role === "staff" && staffMember && staffTab === "my-details" && (
          <MyDetails staff={staffMember} site={dir.sites.find((s) => s.id === staffMember.siteId)} />
        )}
        {currentUser.role === "staff" && staffMember && staffTab === "my-training" && <MyTraining staff={staffMember} />}
        {currentUser.role === "staff" && staffMember && staffTab === "my-contracts" && (
          <MyContracts staff={staffMember} contracts={contracts} onSign={(id) => setSignModal(id)} onView={(id) => setViewContractId(id)} />
        )}
      </main>

      {/* Modals & Dialogs */}
      {staffModal && (
        <StaffModal
          initial={staffModal === "new" ? null : dir.staff.find((s) => s.id === staffModal)}
          sites={dir.sites}
          onClose={() => setStaffModal(null)}
          onSave={saveStaff}
        />
      )}
      {siteModal && <Modal title="Add business" onClose={() => setSiteModal(false)}><SiteForm adminUsers={adminUsers} onSave={saveSite} onCancel={() => setSiteModal(false)} /></Modal>}
      {businessUserModal && <Modal title="Add business user" onClose={() => setBusinessUserModal(false)}><BusinessUserForm onSave={saveSubAdmin} onCancel={() => setBusinessUserModal(false)} /></Modal>}
      {trainingModal && <TrainingModal staff={dir.staff.find((s) => s.id === trainingModal.staffId)} onClose={() => setTrainingModal(null)} onSave={(record) => saveTraining(trainingModal.staffId, record)} />}
      {templateModal && <TemplateModal onClose={() => setTemplateModal(null)} onSave={saveTemplate} />}
      {assignModal && <AssignModal template={contracts.templates.find((t) => t.id === assignModal)} staff={dir.staff} onClose={() => setAssignModal(null)} onAssign={(sId) => assignTemplate(assignModal, sId)} />}
      {uploadContractModal && <UploadContractModal staff={dir.staff} onClose={() => setUploadContractModal(false)} onSave={uploadContract} />}
      {signModal && <SignModal instance={contracts.instances.find((c) => c.id === signModal)} onClose={() => setSignModal(null)} onSign={(payload) => signContract(signModal, payload)} />}
      {viewContractId && <ViewContractModal instance={contracts.instances.find((c) => c.id === viewContractId)} onClose={() => setViewContractId(null)} />}
      {verifyStaffId && <VerifyModal staff={dir.staff.find((s) => s.id === verifyStaffId)} onClose={() => setVerifyStaffId(null)} onVerify={(by, notes) => verifyRtw(verifyStaffId, by, notes)} />}
      
      {confirmDelete && (
        <Modal title="Confirm deletion" onClose={() => setConfirmDelete(null)}>
          <p className="mb-4 text-sm text-slate-600">Permanently remove <span className="font-semibold">{confirmDelete.label}</span>?</p>
          <div className="flex justify-end gap-2">
            <button className={btnSecondary} onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className={btnDanger} onClick={() => {
              if (confirmDelete.type === "staff") deleteStaff(confirmDelete.id);
              if (confirmDelete.type === "site") deleteSite(confirmDelete.id);
            }}>Delete</button>
          </div>
        </Modal>
      )}

      {toast && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-lg">{toast}</div>}
    </div>
  );
}

/* Nav & Subviews */
function NavBtn({ active, onClick, icon: Icon, label }) {
  return (
    <button onClick={onClick} className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${active ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}>
      <Icon size={15} /> {label}
    </button>
  );
}

function Dashboard({ dir, contracts, goTab }) {
  const expired = dir.staff.filter((s) => rtwInfo(s).tone === "bad");
  const expiring = dir.staff.filter((s) => rtwInfo(s).tone === "warn");
  const awaiting = contracts.instances.filter((c) => c.status === "sent");

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Staff" value={dir.staff.length} icon={Users} onClick={() => goTab("staff")} />
        <StatCard label="Locations" value={dir.sites.length} icon={Building2} onClick={() => goTab("sites")} />
        <StatCard label="RTW expiring" value={expiring.length} icon={AlertTriangle} tone={expiring.length ? "warn" : undefined} onClick={() => goTab("rtw")} />
        <StatCard label="RTW expired" value={expired.length} icon={AlertTriangle} tone={expired.length ? "bad" : undefined} onClick={() => goTab("rtw")} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Contracts awaiting signature" onSeeAll={() => goTab("contracts")}>
          {awaiting.length === 0 ? <p className="py-4 text-sm text-slate-400">No pending contracts.</p> : (
            <ul className="divide-y divide-slate-100">
              {awaiting.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2 text-sm font-medium">
                  <span>{c.staffName}</span>
                  <StatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, tone, onClick }) {
  return (
    <button onClick={onClick} className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-slate-300">
      <Icon size={16} className={tone === "bad" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "text-slate-400"} />
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </button>
  );
}

function Panel({ title, onSeeAll, children }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <button onClick={onSeeAll} className="text-xs text-slate-400 hover:text-slate-700">See all</button>
      </div>
      {children}
    </div>
  );
}

function StaffTab({ dir, onAdd, onEdit, onDelete }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <button onClick={onAdd} className={`${btnPrimary} flex items-center gap-1.5`}><Plus size={15} /> Add staff</button>
      </div>
      <ul className="space-y-2">
        {dir.staff.map((s) => (
          <li key={s.id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
            <div>
              <p className="font-semibold">{s.firstName} {s.lastName}</p>
              <p className="text-xs text-slate-500">NI: {s.niNumber || "N/A"}</p>
            </div>
            <div className="flex gap-1">
              <button onClick={() => onEdit(s.id)} className="p-2 text-slate-400 hover:text-slate-700"><Pencil size={16} /></button>
              <button onClick={() => onDelete(s)} className="p-2 text-slate-400 hover:text-rose-600"><Trash2 size={16} /></button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StaffModal({ initial, sites, onClose, onSave }) {
  const [form, setForm] = useState(initial || {
    firstName: "", lastName: "", email: "", phone: "", niNumber: "",
    siteId: sites[0]?.id || "", jobTitle: "", startDate: todayISO(), dateOfBirth: "",
    rtw: { nationalityType: "british-irish", checkType: "not-required", shareCode: "", expiryDate: "", manualDetails: "" }
  });

  const rtwRequired = form.rtw?.nationalityType === "non-british-code" || form.rtw?.nationalityType === "non-british-manual";

  return (
    <Modal title={initial ? "Edit Staff" : "Add Staff"} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First Name"><input className={inputCls} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
        <Field label="Last Name"><input className={inputCls} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
        <Field label="Email"><input className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Phone"><input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Date of Birth"><input type="date" className={inputCls} value={form.dateOfBirth || ""} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} /></Field>
        <Field label="NI Number"><input className={inputCls} value={form.niNumber} onChange={(e) => setForm({ ...form, niNumber: e.target.value.toUpperCase() })} /></Field>
        <Field label="Business">
          <select className={inputCls} value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Job Title"><input className={inputCls} value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></Field>
        <Field label="Start Date"><input type="date" className={inputCls} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
        <Field label="Nationality">
          <select className={inputCls} value={form.rtw?.nationalityType || "british-irish"} onChange={(e) => setForm({ ...form, rtw: { ...(form.rtw || {}), nationalityType: e.target.value, checkType: e.target.value === "british-irish" ? "not-required" : "manual", shareCode: "", manualDetails: "", expiryDate: "" } })}>
            <option value="british-irish">British/Irish Citizen</option>
            <option value="non-british-code">Non-British citizen with right to work code</option>
            <option value="non-british-manual">Non-British Citizen, manual details/passport number etc</option>
          </select>
        </Field>
        <Field label="Right to Work Status">
          <select className={inputCls} value={form.rtw?.checkType || "not-required"} onChange={(e) => setForm({ ...form, rtw: { ...(form.rtw || {}), checkType: e.target.value } })}>
            <option value="not-required">Not required</option>
            <option value="pending">Pending review</option>
            <option value="manual">Manual review</option>
          </select>
        </Field>
      </div>
      {rtwRequired && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Right to Work Code / Share Code"><input className={inputCls} value={form.rtw?.shareCode || ""} onChange={(e) => setForm({ ...form, rtw: { ...(form.rtw || {}), shareCode: e.target.value } })} /></Field>
          <Field label="Right to Work Expires"><input type="date" className={inputCls} value={form.rtw?.expiryDate || ""} onChange={(e) => setForm({ ...form, rtw: { ...(form.rtw || {}), expiryDate: e.target.value } })} /></Field>
          <Field label="Manual Details / Passport Number" className="sm:col-span-2"><textarea className={inputCls} rows={3} value={form.rtw?.manualDetails || ""} onChange={(e) => setForm({ ...form, rtw: { ...(form.rtw || {}), manualDetails: e.target.value } })} /></Field>
        </div>
      )}
      <p className="mt-3 text-xs text-slate-500">If British/Irish is selected, right to work code is not required. For other nationalities, a right to work code or manual details are required.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={() => onSave(form)}>Save</button>
      </div>
    </Modal>
  );
}

function TrainingAdminTab({ dir, onAddTraining, onDeleteTraining }) {
  return (
    <div className="space-y-4">
      {dir.staff.map((s) => (
        <div key={s.id} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex justify-between gap-2 border-b pb-2">
            <span className="font-semibold">{s.firstName} {s.lastName}</span>
            <button onClick={() => onAddTraining(s.id)} className={`${btnSecondary} text-xs`}><Plus size={14} /> Add Training</button>
          </div>
          <ul className="mt-2 divide-y text-xs">
            {(s.training || []).map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-3 py-2">
                <div>
                  <p className="font-medium text-slate-700">{t.courseName}</p>
                  <p className="mt-1 text-[11px] text-slate-500">{t.trainingType || "Training"} · {fmtDate(t.completionDate)}</p>
                </div>
                <button onClick={() => onDeleteTraining(s.id, t.id)} className="text-rose-600"><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function TrainingModal({ staff, onClose, onSave }) {
  const [courseName, setCourseName] = useState("");
  const [trainingType, setTrainingType] = useState("Training");
  const [completionDate, setCompletionDate] = useState(todayISO());
  return (
    <Modal title={`Log Training: ${staff?.firstName}`} onClose={onClose}>
      <Field label="Course Title"><input className={inputCls} value={courseName} onChange={(e) => setCourseName(e.target.value)} /></Field>
      <Field label="Training Type"><input className={inputCls} value={trainingType} onChange={(e) => setTrainingType(e.target.value)} /></Field>
      <Field label="Completed On"><input type="date" className={inputCls} value={completionDate} onChange={(e) => setCompletionDate(e.target.value)} /></Field>
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={() => onSave({ courseName, trainingType, completionDate })}>Save</button>
      </div>
    </Modal>
  );
}

function MyTraining({ staff }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="font-bold">Training Records</h3>
      <ul className="mt-4 divide-y text-xs">
        {(staff.training || []).map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 py-2">
            <div>
              <p className="font-medium text-slate-700">{r.courseName}</p>
              <p className="mt-1 text-[11px] text-slate-500">{r.trainingType || "Training"} · {fmtDate(r.completionDate)}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RtwTab({ dir, onVerify }) {
  return (
    <div className="space-y-2">
      {dir.staff.map((s) => {
        const info = rtwInfo(s);
        return (
          <div key={s.id} className="flex flex-col gap-3 rounded-xl border bg-white p-3.5 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-semibold">{s.firstName} {s.lastName}</p>
              <p className="text-xs text-slate-500">{s.email}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Badge tone={info.tone}>{info.label}</Badge>
                {s.rtw?.verifiedBy && <Badge tone="neutral">Verified by {s.rtw.verifiedBy}</Badge>}
              </div>
              {s.rtw?.expiryDate && <p className="mt-2 text-xs text-slate-500">Expiry date: {fmtDate(s.rtw.expiryDate)}</p>}
              {s.rtw?.manualDetails && <p className="mt-1 text-xs text-slate-500">Details: {s.rtw.manualDetails}</p>}
            </div>
            <button onClick={() => onVerify(s.id)} className="rounded border px-2 py-1 text-xs">Verify</button>
          </div>
        );
      })}
    </div>
  );
}

function VerifyModal({ staff, onClose, onVerify }) {
  const [by, setBy] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <Modal title={`Verify RTW: ${staff?.firstName || "Staff"}`} onClose={onClose}>
      <Field label="Verified By"><input className={inputCls} value={by} onChange={(e) => setBy(e.target.value)} /></Field>
      <Field label="Verification Notes"><textarea className={inputCls} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="mt-3 flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={() => onVerify(by, notes)}>Confirm</button>
      </div>
    </Modal>
  );
}

function SitesTab({ dir, adminUsers, onAdd, onDelete, onAddSubAdmin }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button onClick={onAdd} className={btnPrimary}>Add Business</button>
        <button onClick={onAddSubAdmin} className={btnSecondary}>Add Business users</button>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-800">Business users</h3>
        <ul className="mt-3 space-y-2">
          {adminUsers.map((user) => (
            <li key={user.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
              <span>{user.email}</span>
              <span className="text-xs text-slate-500">{user.siteAccess?.length ? `${user.siteAccess.length} location(s)` : "No locations"}</span>
            </li>
          ))}
        </ul>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {dir.sites.map((s) => (
          <li key={s.id} className="flex justify-between rounded-xl border bg-white p-4">
            <div><p className="font-semibold">{s.name}</p><p className="text-xs text-slate-400">{s.address}</p></div>
            <button onClick={() => onDelete(s)} className="text-rose-600"><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SiteForm({ adminUsers, onSave, onCancel }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [selectedAdmins, setSelectedAdmins] = useState([]);

  const toggleAdmin = (adminId) => {
    setSelectedAdmins((current) => current.includes(adminId) ? current.filter((id) => id !== adminId) : [...current, adminId]);
  };

  return (
    <div className="space-y-3">
      <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Address"><input className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <p className="mb-2 text-sm font-medium text-slate-700">Assign business users</p>
        <div className="space-y-2">
          {adminUsers.map((user) => (
            <label key={user.id} className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={selectedAdmins.includes(user.id)} onChange={() => toggleAdmin(user.id)} />
              <span>{user.email}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button className={btnSecondary} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={() => onSave({ name, address, assignedAdminIds: selectedAdmins })}>Save</button>
      </div>
    </div>
  );
}

function BusinessUserForm({ onSave, onCancel }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="space-y-3">
      <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Email"><input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password (optional)"><input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <div className="mt-3 flex justify-end gap-2">
        <button className={btnSecondary} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} onClick={() => onSave({ name, email, password })}>Save</button>
      </div>
    </div>
  );
}

function ContractsAdminTab({ contracts, subTab, setSubTab, onNewTemplate, onAssign, onUpload, onView, onDownload }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setSubTab("templates")} className={btnSecondary}>Templates</button>
        <button onClick={() => setSubTab("assigned")} className={btnSecondary}>Assigned</button>
        <button onClick={onUpload} className={btnPrimary}>Upload & Assign</button>
      </div>
      {subTab === "templates" ? (
        <div>
          <button onClick={onNewTemplate} className={btnPrimary}>New Template</button>
          <ul className="mt-3 space-y-2">
            {contracts.templates.map((t) => (
              <li key={t.id} className="flex justify-between rounded-xl border bg-white p-3">
                <span>{t.title}</span>
                <button onClick={() => onAssign(t.id)} className={`${btnPrimary} text-xs`}>Assign</button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className="space-y-2">
          {contracts.instances.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 rounded-xl border bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">{c.staffName} - {c.templateTitle}</p>
                <p className="text-xs text-slate-500">Status: {c.status}</p>
              </div>
              <div className="flex gap-2">
                <button onClick={() => onView(c.id)} className={btnSecondary}>View</button>
                <button onClick={() => onDownload(c.id)} className={btnPrimary}>Download</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TemplateModal({ onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <Modal title="New Template" onClose={onClose} wide>
      <Field label="Title"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Body"><textarea className={`${inputCls} h-40`} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <div className="flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={() => onSave({ title, body })}>Save</button>
      </div>
    </Modal>
  );
}

function AssignModal({ template, staff, onClose, onAssign }) {
  const [staffId, setStaffId] = useState("");
  return (
    <Modal title={`Assign ${template?.title}`} onClose={onClose}>
      <Field label="Staff Member">
        <select className={inputCls} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">Select...</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
        </select>
      </Field>
      <div className="flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} onClick={() => onAssign(staffId)}>Assign</button>
      </div>
    </Modal>
  );
}

function UploadContractModal({ staff, onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [staffId, setStaffId] = useState("");
  const [file, setFile] = useState(null);
  return (
    <Modal title="Upload & Assign Contract" onClose={onClose} wide>
      <Field label="Document Title"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Staff Member">
        <select className={inputCls} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">Select...</option>
          {staff.map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
        </select>
      </Field>
      <Field label="Upload PDF"><input type="file" accept=".pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
      <div className="flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} disabled={!title || !staffId || !file} onClick={() => onSave({ title, staffId, file })}>Send</button>
      </div>
    </Modal>
  );
}

function MyDetails({ staff, site }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="text-xl font-bold">{staff.firstName} {staff.lastName}</h2>
      <p className="text-sm text-slate-500">{site?.name}</p>
      <p className="mt-2 text-sm font-mono">NI Number: {staff.niNumber || "N/A"}</p>
    </div>
  );
}

function MyContracts({ staff, contracts, onSign, onView }) {
  const mine = contracts.instances.filter((c) => c.staffId === staff.id);
  return (
    <ul className="space-y-2">
      {mine.map((c) => (
        <li key={c.id} className="flex flex-col gap-2 rounded-xl border bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-semibold">{c.templateTitle}</p>
            <div className="mt-1"><StatusBadge status={c.status} /></div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => onView(c.id)} className={btnSecondary}>View</button>
            <button onClick={() => c.status === "completed" ? onView(c.id) : onSign(c.id)} className={btnPrimary}>
              {c.status === "completed" ? "Open" : "Sign"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SignModal({ instance, onClose, onSign }) {
  const [typedName, setTypedName] = useState("");
  const [sig, setSig] = useState(null);
  return (
    <Modal title={instance?.templateTitle} onClose={onClose} wide>
      <div className="mb-4 max-h-40 overflow-y-auto rounded bg-slate-50 p-2 text-sm">{instance?.body}</div>
      <Field label="Full Name"><input className={inputCls} value={typedName} onChange={(e) => setTypedName(e.target.value)} /></Field>
      <Field label="Signature"><SignaturePad onChange={setSig} /></Field>
      <div className="flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} disabled={!typedName || !sig} onClick={() => onSign({ typedName, signatureDataUrl: sig })}>Sign</button>
      </div>
    </Modal>
  );
}

function ViewContractModal({ instance, onClose }) {
  return (
    <Modal title={instance?.templateTitle} onClose={onClose} wide>
      <div className="mb-4 max-h-40 overflow-y-auto rounded bg-slate-50 p-2 text-sm">{instance?.body}</div>
      {instance?.signatureDataUrl && <img src={instance.signatureDataUrl} alt="Signature" className="h-20 border" />}
      <div className="mt-4 flex justify-end gap-2">
        <button className={btnSecondary} onClick={onClose}>Close</button>
        <button className={btnPrimary} onClick={() => window.print()}><Printer size={15} /> Print</button>
      </div>
    </Modal>
  );
}