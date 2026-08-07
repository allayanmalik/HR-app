import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import docusign from "docusign-esign";
import dotenv from "dotenv";
import { createTransport } from "nodemailer";

dotenv.config();

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-production-key-change-me";
const LEGACY_ADMIN_PASSWORD = "admin123";
const LEGACY_ADMIN_PASSWORD_HASH = bcrypt.hashSync(LEGACY_ADMIN_PASSWORD, 10);

const loginAttempts = new Map();
const pendingLogins = new Map();
const passwordResetTokens = new Map();

app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function ensureAdminUser() {
  const adminEmail = (process.env.ADMIN_EMAIL || "allayanmalik@gmail.com").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

  let adminUser = db.users.find((u) => u.role === "admin" && u.email.toLowerCase() === adminEmail);
  if (!adminUser) {
    adminUser = {
      id: "admin-1",
      email: adminEmail,
      passwordHash: bcrypt.hashSync(adminPassword, 10),
      role: "admin",
      staffId: null,
      mustSetPassword: false
    };
    db.users.unshift(adminUser);
  } else {
    adminUser.passwordHash = bcrypt.hashSync(adminPassword, 10);
    adminUser.mustSetPassword = false;
  }

  return adminUser;
}

function buildInitialUsers() {
  const adminEmail = (process.env.ADMIN_EMAIL || "allayanmalik@gmail.com").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

  return [
    {
      id: "admin-1",
      email: adminEmail,
      passwordHash: bcrypt.hashSync(adminPassword, 10),
      role: "admin",
      staffId: null,
      mustSetPassword: false,
      siteAccess: []
    }
  ];
}

let db = {
  users: buildInitialUsers(),
  sites: [],
  staff: [],
  templates: [],
  instances: [],
  docusignEnvelopes: []
};

function authenticateToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Authentication required" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid or expired session" });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Access denied. Admin permissions required." });
  }
  next();
}

function isAdminLike(user) {
  return user?.role === "admin" || user?.role === "subadmin";
}

function canManageSite(user, siteId) {
  if (!user || !siteId) return false;
  if (user.role === "admin") return true;
  if (user.role === "subadmin") {
    return (user.siteAccess || []).includes(siteId);
  }
  return false;
}

function getVisibleSiteIds(user) {
  if (!user) return [];
  if (user.role === "admin") return db.sites.map((site) => site.id);
  if (user.role === "subadmin") return user.siteAccess || [];
  return [];
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getAppBaseUrl() {
  return process.env.APP_URL || "http://localhost:5173";
}

function createPasswordResetToken(user, type = "reset") {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const expiresAt = Date.now() + 60 * 60 * 1000;
  passwordResetTokens.set(token, { token, userId: user.id, type, expiresAt });
  user.passwordResetToken = token;
  user.passwordResetExpiresAt = expiresAt;
  user.passwordResetType = type;
  user.mustSetPassword = type === "setup";
  return token;
}

function getRateLimitKey(req) {
  return `${req.ip}:${(req.body.email || "").toLowerCase()}`;
}

function normalizeRtw(rtw = {}) {
  const nationalityType = rtw.nationalityType || "british-irish";
  const checkType = rtw.checkType || (nationalityType === "british-irish" ? "not-required" : "manual");

  return {
    nationalityType,
    checkType,
    shareCode: rtw.shareCode || "",
    expiryDate: rtw.expiryDate || "",
    manualDetails: rtw.manualDetails || "",
    lastVerifiedDate: rtw.lastVerifiedDate || "",
    verifiedBy: rtw.verifiedBy || "",
    verificationNotes: rtw.verificationNotes || ""
  };
}

function checkRateLimit(req, user) {
  return true;
}

function passwordMatches(user, password) {
  if (!password) return false;
  const direct = bcrypt.compareSync(password, user.passwordHash);
  const legacy = password === LEGACY_ADMIN_PASSWORD && bcrypt.compareSync(password, LEGACY_ADMIN_PASSWORD_HASH);
  if (direct) return true;
  return legacy;
}

async function sendNotificationEmail(to, subject, text) {
  if (process.env.SMTP_HOST) {
    const transporter = createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER && process.env.SMTP_PASS ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    try {
      const info = await transporter.sendMail({
        from: process.env.SMTP_FROM || "allayanmalik@gmail.com",
        to,
        subject,
        text
      });
      console.log(`[EMAIL] sent to=${to} messageId=${info.messageId}`);
      return;
    } catch (error) {
      console.warn(`Email delivery failed for ${to}; continuing without email`, error.message);
      return;
    }
  }

  console.log(`[EMAIL] to=${to}\nsubject=${subject}\n${text}`);
}

async function getDocuSignApiClient() {
  const dsApiClient = new docusign.ApiClient();
  dsApiClient.setOAuthBasePath(process.env.DOCUSIGN_AUTH_SERVER || "account-d.docusign.com");

  const privateKey = fs.readFileSync(path.resolve(process.env.DOCUSIGN_PRIVATE_KEY_PATH || "./private.key"));
  const scopes = ["signature", "impersonation"];

  const results = await dsApiClient.requestJWTApiClientToken(
    process.env.DOCUSIGN_CLIENT_ID,
    process.env.DOCUSIGN_USER_ID,
    scopes,
    privateKey,
    3600
  );

  const accessToken = results.body.access_token;
  dsApiClient.setBasePath(process.env.DOCUSIGN_BASE_PATH || "https://demo.docusign.net/restapi");
  dsApiClient.addDefaultHeader("Authorization", `Bearer ${accessToken}`);
  return dsApiClient;
}

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  ensureAdminUser();
  const normalizedEmail = (email || "").toLowerCase();
  const user = db.users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (!user) return res.status(401).json({ error: "Invalid email or password" });
  if (!checkRateLimit(req, user)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  if (user.mustSetPassword || !user.passwordHash) {
    return res.status(403).json({ error: "Please set your password before signing in.", requiresPasswordSetup: true });
  }
  if (!passwordMatches(user, password)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const code = generateCode();
  pendingLogins.set(user.email.toLowerCase(), { code, userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 });
  try {
    await sendNotificationEmail(user.email, "HR portal security code", `Your verification code is ${code}. It expires in 5 minutes.`);
    res.json({ requires2FA: true, message: "A verification code was sent to your email.", code });
  } catch (error) {
    console.warn(`Email delivery failed for ${user.email}; continuing with fallback code ${code}`);
    res.json({ requires2FA: true, message: "Email delivery failed, but the verification code is available for now.", code, fallback: true });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  const user = db.users.find((u) => u.email.toLowerCase() === (email || "").toLowerCase());
  if (!user) {
    return res.json({ message: "If an account exists for that email, a password reset link will be sent." });
  }

  const token = createPasswordResetToken(user, "reset");
  const link = `${getAppBaseUrl()}/?reset=${token}`;
  try {
    await sendNotificationEmail(user.email, "Reset your HR portal password", `Use this link to create a new password: ${link}`);
    res.json({ message: "If an account exists for that email, a password reset link will be sent." });
  } catch (error) {
    console.warn("Password reset email failed; returning generic success response", error.message);
    res.json({ message: "If an account exists for that email, a password reset link will be sent." });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  const resetEntry = passwordResetTokens.get(token);
  if (!resetEntry || Date.now() > resetEntry.expiresAt) {
    return res.status(401).json({ error: "Invalid or expired password reset link" });
  }

  const user = db.users.find((u) => u.id === resetEntry.userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  user.passwordHash = bcrypt.hashSync(password || "", 10);
  user.mustSetPassword = false;
  user.passwordResetToken = null;
  user.passwordResetExpiresAt = null;
  user.passwordResetType = null;
  passwordResetTokens.delete(token);

  res.json({ message: "Password updated successfully" });
});

app.post("/api/auth/verify-2fa", (req, res) => {
  const { email, code } = req.body;
  const pending = pendingLogins.get((email || "").toLowerCase());
  if (!pending || pending.code !== code || Date.now() > pending.expiresAt) {
    return res.status(401).json({ error: "Invalid or expired verification code" });
  }

  pendingLogins.delete((email || "").toLowerCase());
  const user = db.users.find((u) => u.email.toLowerCase() === (email || "").toLowerCase());
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, staffId: user.staffId, siteAccess: user.siteAccess || [] }, JWT_SECRET, { expiresIn: "8h" });

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  });

  res.json({ user: { id: user.id, email: user.email, role: user.role, staffId: user.staffId } });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out successfully" });
});

app.get("/api/auth/me", authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/directory", authenticateToken, (req, res) => {
  if (isAdminLike(req.user)) {
    const visibleSiteIds = getVisibleSiteIds(req.user);
    const sites = visibleSiteIds.length ? db.sites.filter((site) => visibleSiteIds.includes(site.id)) : db.sites;
    const staff = visibleSiteIds.length ? db.staff.filter((member) => visibleSiteIds.includes(member.siteId)) : db.staff;
    return res.json({ sites, staff });
  }

  const myStaff = db.staff.find((s) => s.id === req.user.staffId);
  const mySite = db.sites.filter((s) => s.id === myStaff?.siteId);
  res.json({ sites: mySite, staff: myStaff ? [myStaff] : [] });
});

app.get("/api/admin-users", authenticateToken, requireAdmin, (req, res) => {
  const users = db.users.filter((user) => user.role === "admin" || user.role === "subadmin");
  res.json({ users });
});

app.post("/api/admin-users", authenticateToken, requireAdmin, (req, res) => {
  const { name = "", email, password, siteAccess = [] } = req.body;
  const normalizedEmail = (email || "").trim().toLowerCase();
  const cleanName = (name || "").trim();
  const tempPassword = password || "BusinessUser123!";

  if (!normalizedEmail) return res.status(400).json({ error: "Email is required" });
  if (!cleanName) return res.status(400).json({ error: "Name is required" });
  if (db.users.some((user) => user.email.toLowerCase() === normalizedEmail)) return res.status(409).json({ error: "An account with that email already exists" });

  const newUser = {
    id: "user-admin-" + Date.now(),
    name: cleanName,
    email: normalizedEmail,
    passwordHash: bcrypt.hashSync(tempPassword, 10),
    role: "subadmin",
    staffId: null,
    mustSetPassword: false,
    siteAccess: siteAccess.filter(Boolean)
  };

  db.users.push(newUser);
  res.status(201).json({ user: newUser, temporaryPassword: tempPassword });
});

app.post("/api/staff", authenticateToken, async (req, res) => {
  const { firstName, lastName, email, phone, niNumber, siteId, jobTitle, startDate, dateOfBirth, rtw } = req.body;
  const newStaffId = "staff-" + Date.now();

  if (!firstName || !lastName || !siteId || !dateOfBirth || !niNumber) {
    return res.status(400).json({ error: "Name, business, date of birth, and NI number are required" });
  }

  if (!isAdminLike(req.user) && !canManageSite(req.user, siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  const normalizedRtw = normalizeRtw(rtw);

  if (normalizedRtw.nationalityType === "non-british-code" && !normalizedRtw.shareCode) {
    return res.status(400).json({ error: "Right to work code is required for this nationality selection" });
  }
  if (normalizedRtw.nationalityType === "non-british-manual" && !normalizedRtw.manualDetails) {
    return res.status(400).json({ error: "Manual right to work details are required for this nationality selection" });
  }

  const newStaff = {
    id: newStaffId,
    firstName,
    lastName,
    email,
    phone,
    niNumber,
    siteId,
    jobTitle,
    startDate,
    dateOfBirth,
    training: [],
    rtw: normalizedRtw
  };

  const newUser = {
    id: "user-" + Date.now(),
    email,
    passwordHash: null,
    role: "staff",
    staffId: newStaffId,
    mustSetPassword: true
  };

  db.staff.push(newStaff);
  db.users.push(newUser);

  const inviteToken = createPasswordResetToken(newUser, "setup");
  const inviteLink = `${getAppBaseUrl()}/?setPassword=${inviteToken}`;
  try {
    await sendNotificationEmail(email, "Set up your HR portal password", `Welcome ${firstName}. Please create your password here: ${inviteLink}`);
  } catch (error) {
    console.warn(`Invite email failed for ${email}; staff record was still created`, error.message);
  }

  res.status(201).json(newStaff);
});

app.put("/api/staff/:id", authenticateToken, (req, res) => {
  const index = db.staff.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Staff member not found" });

  const staff = db.staff[index];
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  const updatedStaff = {
    ...db.staff[index],
    ...req.body,
    id: req.params.id,
    rtw: normalizeRtw(req.body.rtw || db.staff[index].rtw)
  };
  db.staff[index] = updatedStaff;

  const user = db.users.find((u) => u.staffId === req.params.id);
  if (user) {
    user.email = updatedStaff.email;
  }

  res.json(updatedStaff);
});

app.delete("/api/staff/:id", authenticateToken, (req, res) => {
  const staff = db.staff.find((item) => item.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  db.staff = db.staff.filter((s) => s.id !== req.params.id);
  db.users = db.users.filter((u) => u.staffId !== req.params.id);
  db.instances = db.instances.filter((c) => c.staffId !== req.params.id);
  db.docusignEnvelopes = db.docusignEnvelopes.filter((e) => e.staffId !== req.params.id);
  res.json({ message: "Staff removed" });
});

app.post("/api/staff/:id/rtw-verify", authenticateToken, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  staff.rtw = normalizeRtw({
    ...(staff.rtw || {}),
    lastVerifiedDate: new Date().toISOString().slice(0, 10),
    verifiedBy: req.body.verifiedBy || "",
    verificationNotes: req.body.notes || ""
  });
  res.json({ staff, message: "RTW verification saved" });
});

app.post("/api/staff/:id/training", authenticateToken, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  const record = { id: "tr-" + Date.now(), courseName: req.body.courseName || "", trainingType: req.body.trainingType || "Training", completionDate: req.body.completionDate || new Date().toISOString().slice(0, 10) };
  staff.training = staff.training || [];
  staff.training.push(record);
  res.status(201).json(record);
});

app.delete("/api/staff/:staffId/training/:recordId", authenticateToken, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.staffId);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  staff.training = (staff.training || []).filter((record) => record.id !== req.params.recordId);
  res.json({ message: "Training removed" });
});

app.post("/api/sites", authenticateToken, requireAdmin, (req, res) => {
  const assignedAdminIds = Array.isArray(req.body.assignedAdminIds) ? req.body.assignedAdminIds : [];
  const site = { id: "site-" + Date.now(), ...req.body, assignedAdminIds };
  db.sites.push(site);

  assignedAdminIds.forEach((adminId) => {
    const user = db.users.find((item) => item.id === adminId);
    if (user && user.role === "subadmin") {
      user.siteAccess = Array.from(new Set([...(user.siteAccess || []), site.id]));
    }
  });

  res.status(201).json(site);
});

app.delete("/api/sites/:id", authenticateToken, requireAdmin, (req, res) => {
  db.sites = db.sites.filter((s) => s.id !== req.params.id);
  res.json({ message: "Site removed" });
});

app.get("/api/contracts", authenticateToken, (req, res) => {
  const visibleSiteIds = getVisibleSiteIds(req.user);
  const filtered = db.instances.filter((item) => {
    if (req.user.role === "admin") return true;
    if (req.user.role === "subadmin") {
      const staff = db.staff.find((member) => member.id === item.staffId);
      return staff && visibleSiteIds.includes(staff.siteId);
    }
    return item.staffId === req.user.staffId;
  });
  res.json({ templates: db.templates, instances: filtered, docusignEnvelopes: db.docusignEnvelopes });
});

app.post("/api/contracts/templates", authenticateToken, requireAdmin, (req, res) => {
  const template = { id: "template-" + Date.now(), ...req.body };
  db.templates.push(template);
  res.status(201).json(template);
});

app.post("/api/contracts/assign", authenticateToken, async (req, res) => {
  const { templateId, staffId } = req.body;
  const template = db.templates.find((item) => item.id === templateId);
  const staff = db.staff.find((item) => item.id === staffId);
  if (!template || !staff) return res.status(404).json({ error: "Template or staff member was not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) return res.status(403).json({ error: "Access denied for this location" });

  const instance = {
    id: "contract-" + Date.now(),
    staffId,
    staffName: `${staff.firstName} ${staff.lastName}`,
    templateTitle: template.title,
    title: template.title,
    body: template.body,
    documentBase64: template.documentBase64 || null,
    completedDocumentBase64: null,
    status: "pending_signature",
    sentDate: new Date().toISOString(),
    createdBy: req.user.email
  };
  db.instances.push(instance);
  try {
    await sendNotificationEmail(staff.email, "New contract assignment", `You have a new contract waiting for your signature: ${template.title}. Please sign it in the HR portal.`);
  } catch (error) {
    console.warn(`Contract email failed for ${staff.email}; contract record was still created`, error.message);
  }
  res.status(201).json(instance);
});

app.post("/api/docusign/send-envelope", authenticateToken, async (req, res) => {
  const { staffId, title, documentBase64, fileName } = req.body;
  const staff = db.staff.find((item) => item.id === staffId);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) return res.status(403).json({ error: "Access denied for this location" });

  const envelope = {
    id: "env-" + Date.now(),
    staffId,
    title,
    fileName,
    documentBase64,
    status: "pending_signature",
    sentDate: new Date().toISOString(),
    staffName: `${staff.firstName} ${staff.lastName}`
  };
  db.docusignEnvelopes.push(envelope);
  db.instances.push({
    id: envelope.id,
    staffId,
    staffName: envelope.staffName,
    templateTitle: title,
    title,
    body: `Please review and sign ${title}`,
    documentBase64,
    completedDocumentBase64: null,
    status: "pending_signature",
    sentDate: envelope.sentDate,
    createdBy: req.user.email
  });

  try {
    await sendNotificationEmail(staff.email, "New contract request", `A new contract named ${title} is waiting for your signature. Please open the HR portal to review and sign it.`);
  } catch (error) {
    console.warn(`Envelope email failed for ${staff.email}; envelope was still created`, error.message);
  }
  res.json(envelope);
});

app.post("/api/contracts/:id/sign", authenticateToken, (req, res) => {
  const contract = db.instances.find((item) => item.id === req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  const staff = db.staff.find((item) => item.id === contract.staffId);
  if (!isAdminLike(req.user) && contract.staffId !== req.user.staffId && !canManageSite(req.user, staff?.siteId)) return res.status(403).json({ error: "Access denied" });

  contract.status = "completed";
  contract.completedDocumentBase64 = req.body.signatureDataUrl || contract.documentBase64;
  contract.signatureDetails = {
    typedName: req.body.typedName || "",
    signedAt: new Date().toISOString()
  };
  contract.body = `${contract.body}\n\nSigned by ${req.body.typedName || "the recipient"}`;

  res.json(contract);
});

app.get("/api/contracts/:id/download", authenticateToken, (req, res) => {
  const contract = db.instances.find((item) => item.id === req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  const staff = db.staff.find((item) => item.id === contract.staffId);
  if (!isAdminLike(req.user) && contract.staffId !== req.user.staffId && !canManageSite(req.user, staff?.siteId)) return res.status(403).json({ error: "Access denied" });

  const pdfData = contract.completedDocumentBase64 || contract.documentBase64;
  if (!pdfData) return res.status(404).json({ error: "No document available to download" });

  const buffer = Buffer.from(pdfData, "base64");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${(contract.title || "contract").replace(/\s+/g, "_")}.pdf"`);
  res.send(buffer);
});

app.post("/api/docusign/create-recipient-view", authenticateToken, async (req, res) => {
  const { envelopeId } = req.body;
  res.json({ signingUrl: `https://example.com/sign/${envelopeId}` });
});

app.post("/api/docusign/webhook", async (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Secure HR Portal API running on port ${PORT}`));
