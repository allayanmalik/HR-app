import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import docusign from "docusign-esign";
import { PDFDocument } from "pdf-lib";
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

if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "super-secret-production-key-change-me")) {
  console.error("Insecure JWT_SECRET detected in production. Set a strong JWT_SECRET environment variable.");
  process.exit(1);
}

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

// Serve frontend if built
const DIST_DIR = path.resolve("./dist");
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get("/", (req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));
  // SPA fallback
  app.get(/^(?!\/api\/).*/, (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

// Configure a single SMTP transporter and verify on startup when SMTP is configured
let mailTransporter = null;
const DEV_EMAIL_TO_CONSOLE = process.env.DEV_EMAIL_TO_CONSOLE === "true";
if (process.env.SMTP_HOST) {
  try {
    mailTransporter = createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER && process.env.SMTP_PASS ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });

    mailTransporter.verify().then(() => {
      console.log("SMTP transporter verified and ready to send emails");
    }).catch((err) => {
      console.error("SMTP transporter verification failed:", err && err.message ? err.message : err);
      // keep mailTransporter set so sendNotificationEmail will attempt and bubble errors
    });
  } catch (err) {
    console.error("Failed to configure SMTP transporter:", err && err.message ? err.message : err);
    mailTransporter = null;
  }
}

// SES client (lazy)
let sesClient = null;
function getSesClient() {
  if (!sesClient && process.env.USE_SES === "true" && process.env.AWS_REGION) {
    try {
      sesClient = new SESClient({ region: process.env.AWS_REGION });
      console.log("SES client configured");
    } catch (err) {
      console.warn("Failed to configure SES client:", err && err.message ? err.message : err);
      sesClient = null;
    }
  }
  return sesClient;
}

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

// Simple in-memory audit log
db.audit = [];

function addAudit(action, user, details = {}) {
  try {
    const entry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      action,
      user: { id: user?.id || null, email: user?.email || (user && user.email) || "unknown", role: user?.role || "unknown" },
      timestamp: new Date().toISOString(),
      details
    };
    db.audit.unshift(entry);
    // Persist audit entry to disk (append JSONL) for durability
    try {
      const dataDir = path.resolve("./data");
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(path.join(dataDir, "audit.log"), JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("Failed to persist audit entry to disk:", err && err.message ? err.message : err);
    }
    return entry;
  } catch (err) {
    console.error('Failed to record audit entry', err && err.message ? err.message : err);
    return null;
  }
}

// Persistent DB helpers (JSON file). Keeps current in-memory `db` in sync with disk.
const DB_FILE = path.resolve("./data/db.json");
function loadDbFromDisk() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf8");
      const parsed = JSON.parse(raw);
      // Merge into in-memory db, preserve structures
      db.users = parsed.users || db.users;
      db.sites = parsed.sites || db.sites;
      db.staff = parsed.staff || db.staff;
      db.templates = parsed.templates || db.templates;
      db.instances = parsed.instances || db.instances;
      db.docusignEnvelopes = parsed.docusignEnvelopes || db.docusignEnvelopes;
      db.audit = parsed.audit || db.audit;
      console.log("Loaded persisted DB from disk");
    }
  } catch (err) {
    console.warn("Failed to load DB from disk:", err && err.message ? err.message : err);
  }
}

function saveDbToDisk() {
  try {
    const dataDir = path.resolve("./data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const snapshot = {
      users: db.users,
      sites: db.sites,
      staff: db.staff,
      templates: db.templates,
      instances: db.instances,
      docusignEnvelopes: db.docusignEnvelopes,
      audit: db.audit
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to persist DB to disk:", err && err.message ? err.message : err);
  }
}

// Load DB at startup
loadDbFromDisk();

// Configure S3 if credentials provided; otherwise use local file storage
const S3_BUCKET = process.env.S3_BUCKET || null;
let s3 = null;
if (process.env.AWS_REGION && S3_BUCKET) {
  s3 = new S3Client({ region: process.env.AWS_REGION });
  console.log("S3 enabled: bucket=", S3_BUCKET);
} else {
  console.log("S3 not configured — using local storage for uploaded documents");
}

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

const DOCUMENT_MIME_TYPES = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  zip: "application/zip"
};

function getDocumentMimeType(fileName = "") {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  return DOCUMENT_MIME_TYPES[ext] || "application/octet-stream";
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

function clearRateLimit(req) {
  const key = getRateLimitKey(req);
  loginAttempts.delete(key);
}

function normalizeDocuments(documents = []) {
  return Array.isArray(documents) ? documents : [];
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
  const key = getRateLimitKey(req);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 8;

  const record = loginAttempts.get(key) || { count: 0, firstAttemptAt: now, blockedUntil: 0 };
  if (record.blockedUntil && now < record.blockedUntil) {
    return false;
  }

  if (now - record.firstAttemptAt > windowMs) {
    loginAttempts.set(key, { count: 0, firstAttemptAt: now, blockedUntil: 0 });
    return true;
  }

  if (record.count >= maxAttempts) {
    record.blockedUntil = now + 10 * 60 * 1000;
    loginAttempts.set(key, record);
    return false;
  }

  return true;
}

function registerFailedLoginAttempt(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const record = loginAttempts.get(key) || { count: 0, firstAttemptAt: now, blockedUntil: 0 };
  if (now - record.firstAttemptAt > windowMs) {
    record.count = 0;
    record.firstAttemptAt = now;
    record.blockedUntil = 0;
  }
  record.count += 1;
  loginAttempts.set(key, record);
}

function passwordMatches(user, password) {
  if (!password) return false;
  const direct = bcrypt.compareSync(password, user.passwordHash);
  const legacy = password === LEGACY_ADMIN_PASSWORD && bcrypt.compareSync(password, LEGACY_ADMIN_PASSWORD_HASH);
  if (direct) return true;
  return legacy;
}

async function sendNotificationEmail(to, subject, text) {
  // Prefer SES when explicitly enabled
  const ses = getSesClient();
  if (ses) {
    const source = process.env.SES_FROM || process.env.SMTP_FROM || "no-reply@hr-app.local";
    const command = new SendEmailCommand({
      Source: source,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Text: { Data: text, Charset: "UTF-8" } }
      }
    });
    const info = await ses.send(command);
    console.log(`[EMAIL][SES] sent to=${to} messageId=${info.MessageId || "n/a"}`);
    return;
  }

  // If a verified SMTP transporter exists, use it and bubble send errors to callers
  if (mailTransporter) {
    const info = await mailTransporter.sendMail({ from: process.env.SMTP_FROM || "no-reply@hr-app.local", to, subject, text });
    console.log(`[EMAIL] sent to=${to} messageId=${info.messageId}`);
    return;
  }

  // Dev fallback: log to console and return (does not throw)
  if (DEV_EMAIL_TO_CONSOLE) {
    console.log(`[DEV EMAIL] to=${to}\nsubject=${subject}\n${text}`);
    return;
  }

  // No transporter and no dev fallback: throw so callers can handle the failure explicitly
  throw new Error("No SMTP/SES transporter configured and DEV_EMAIL_TO_CONSOLE is not enabled");
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
  if (!user) {
    registerFailedLoginAttempt(req);
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (!checkRateLimit(req, user)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  if (user.mustSetPassword || !user.passwordHash) {
    return res.status(403).json({ error: "Please set your password before signing in.", requiresPasswordSetup: true });
  }
  if (!passwordMatches(user, password)) {
    registerFailedLoginAttempt(req);
    return res.status(401).json({ error: "Invalid email or password" });
  }

  clearRateLimit(req);

  const code = generateCode();
  pendingLogins.set(user.email.toLowerCase(), { code, userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 });
  try {
    await sendNotificationEmail(user.email, "HR portal security code", `Your verification code is ${code}. It expires in 5 minutes.`);
    // Do NOT include the code in the response — it must be delivered only via email.
    res.json({ requires2FA: true, message: "A verification code was sent to your email." });
  } catch (error) {
    console.error(`Email delivery failed for ${user.email}; aborting login flow.`, error && error.message ? error.message : error);
    // Remove pending code so there's no dangling value
    pendingLogins.delete(user.email.toLowerCase());
    return res.status(500).json({ error: "Failed to deliver verification code. Contact the administrator." });
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

function withDocumentMeta(staffMember) {
  return {
    ...staffMember,
    documents: (staffMember.documents || []).map(({ documentBase64, ...meta }) => meta)
  };
}

app.get("/api/directory", authenticateToken, (req, res) => {
  if (isAdminLike(req.user)) {
    const visibleSiteIds = getVisibleSiteIds(req.user);
    const sites = visibleSiteIds.length ? db.sites.filter((site) => visibleSiteIds.includes(site.id)) : db.sites;
    const staff = (visibleSiteIds.length ? db.staff.filter((member) => visibleSiteIds.includes(member.siteId)) : db.staff).map(withDocumentMeta);
    return res.json({ sites, staff });
  }

  const myStaff = db.staff.find((s) => s.id === req.user.staffId);
  const mySite = db.sites.filter((s) => s.id === myStaff?.siteId);
  res.json({ sites: mySite, staff: myStaff ? [withDocumentMeta(myStaff)] : [] });
});

app.get("/api/admin-users", authenticateToken, requireAdmin, (req, res) => {
  const users = db.users.filter((user) => user.role === "admin" || user.role === "subadmin");
  res.json({ users });
});

app.post("/api/admin-users", authenticateToken, requireAdmin, async (req, res) => {
  const { name = "", email, siteAccess = [] } = req.body;
  const normalizedEmail = (email || "").trim().toLowerCase();
  const cleanName = (name || "").trim();

  if (!normalizedEmail) return res.status(400).json({ error: "Email is required" });
  if (!cleanName) return res.status(400).json({ error: "Name is required" });
  if (db.users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const newUser = {
    id: "user-admin-" + Date.now(),
    name: cleanName,
    email: normalizedEmail,
    passwordHash: null, // They will set this themselves via the invite link
    role: "subadmin",
    staffId: null,
    mustSetPassword: true, // Forces them into the password setup flow
    siteAccess: siteAccess.filter(Boolean)
  };

  db.users.push(newUser);

  // Generate the setup link and send the email, include their assigned sites for verification
  const inviteToken = createPasswordResetToken(newUser, "setup");
  const inviteLink = `${getAppBaseUrl()}/?setPassword=${inviteToken}`;
  const assignedSiteNames = (db.sites || []).filter((s) => (newUser.siteAccess || []).includes(s.id)).map((s) => s.name).join(", ") || "(none)";

  try {
    await sendNotificationEmail(
      normalizedEmail,
      "Set up your Business User account",
      `Welcome ${cleanName}.

You have been granted Business User access to the HR portal with access to: ${assignedSiteNames}.

Please check that your name and email are correct and create your password here: ${inviteLink}`
    );
  } catch (error) {
    // If email failed, remove the user we just pushed and return an error so the admin can retry with corrected SMTP settings.
    db.users = db.users.filter((u) => u.id !== newUser.id);
    console.error(`Invite email failed for ${normalizedEmail}; user record removed.`, error && error.message ? error.message : error);
    return res.status(500).json({ error: "Failed to send invite email. User was not created." });
  }

  res.status(201).json({ user: newUser, message: "Invitation email sent successfully" });
  addAudit("admin_user_created", req.user, { createdUserId: newUser.id, createdUserEmail: newUser.email, siteAccess: newUser.siteAccess });
  saveDbToDisk();
});

// Edit admin/subadmin user
app.put("/api/admin-users/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name = "", email, siteAccess = [], password } = req.body;
  const user = db.users.find((u) => u.id === id);
  if (!user) return res.status(404).json({ error: "User not found" });
  // Prevent modifying the primary admin account
  if (user.id === "admin-1") return res.status(403).json({ error: "Cannot modify primary admin account" });

  const normalizedEmail = (email || "").trim().toLowerCase();
  if (normalizedEmail && db.users.some((u) => u.email.toLowerCase() === normalizedEmail && u.id !== id)) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  if (name) user.name = name.trim();
  if (normalizedEmail) user.email = normalizedEmail;
  user.siteAccess = Array.isArray(siteAccess) ? siteAccess.filter(Boolean) : user.siteAccess;

  if (password) {
    user.passwordHash = bcrypt.hashSync(password, 10);
    user.mustSetPassword = false;
  }

  // Optionally send setup/reset email if requested
  if (req.body.sendSetupLink) {
    const token = createPasswordResetToken(user, "setup");
    const link = `${getAppBaseUrl()}/?setPassword=${token}`;
    try {
      await sendNotificationEmail(user.email, "Set up your Business User account", `Please create your password here: ${link}`);
    } catch (err) {
      console.error(`Failed to send setup link to ${user.email}`, err && err.message ? err.message : err);
      return res.status(500).json({ error: "Failed to send setup email" });
    }
  }

  res.json({ user });
  addAudit("admin_user_updated", req.user, { updatedUserId: user.id, updatedFields: Object.keys(req.body || {}) });
  saveDbToDisk();
});

// Delete admin/subadmin user
app.delete("/api/admin-users/:id", authenticateToken, requireAdmin, (req, res) => {
  const { id } = req.params;
  const user = db.users.find((u) => u.id === id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.id === "admin-1") return res.status(403).json({ error: "Cannot delete primary admin account" });

  db.users = db.users.filter((u) => u.id !== id);
  res.json({ ok: true });
  addAudit("admin_user_deleted", req.user, { deletedUserId: id });
  saveDbToDisk();
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
    documents: [],
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
  addAudit("staff_created", req.user, { staffId: newStaffId, email, siteId });
  saveDbToDisk();
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
    rtw: normalizeRtw(req.body.rtw || db.staff[index].rtw),
    documents: normalizeDocuments(req.body.documents || db.staff[index].documents)
  };
  db.staff[index] = updatedStaff;

  const user = db.users.find((u) => u.staffId === req.params.id);
  if (user) {
    user.email = updatedStaff.email;
  }

  res.json(updatedStaff);
  saveDbToDisk();
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
  addAudit("staff_deleted", req.user, { staffId: req.params.id });
  saveDbToDisk();
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
  saveDbToDisk();
});

app.delete("/api/staff/:staffId/training/:recordId", authenticateToken, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.staffId);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  staff.training = (staff.training || []).filter((record) => record.id !== req.params.recordId);
  res.json({ message: "Training removed" });
  saveDbToDisk();
});

app.post("/api/staff/:id/documents", authenticateToken, async (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  // Only allow: global admin, subadmin with access to this staff's site, or the staff member themself
  const allowed = req.user.role === "admin" || (req.user.role === "subadmin" && (req.user.siteAccess || []).includes(staff.siteId)) || req.user.staffId === staff.id;
  if (!allowed) return res.status(403).json({ error: "Access denied for this location" });

  const { title, fileName, documentBase64 } = req.body;
  if (!fileName || !documentBase64) {
    return res.status(400).json({ error: "A file name and file content are required" });
  }

  const id = "doc-" + Date.now();
  const record = {
    id,
    title: title || fileName,
    fileName,
    s3Key: null,
    uploadedAt: new Date().toISOString(),
    uploadedBy: req.user.email
  };

  // Upload to S3 if configured, otherwise save to local data/uploads
  try {
    const buffer = Buffer.from(documentBase64, "base64");
    if (s3 && S3_BUCKET) {
      const key = `staff/${staff.id}/${id}/${fileName}`;
      const params = { Bucket: S3_BUCKET, Key: key, Body: buffer, ContentType: getDocumentMimeType(fileName) };
      await s3.send(new PutObjectCommand(params));
      record.s3Key = key;
    } else {
      const uploadsDir = path.resolve("./data/uploads", staff.id);
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, `${id}-${fileName}`);
      fs.writeFileSync(filePath, buffer);
      record.s3Key = `local:${filePath}`;
    }
  } catch (err) {
    console.error("Failed to store uploaded document:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Failed to store document" });
  }

  staff.documents = normalizeDocuments(staff.documents);
  staff.documents.push(record);
  const { s3Key, ...meta } = record;
  res.status(201).json(meta);
  addAudit("staff_document_uploaded", req.user, { staffId: staff.id, documentId: record.id, fileName: record.fileName, storage: record.s3Key });
  saveDbToDisk();
});

app.get("/api/staff/:id/documents/:docId/download", authenticateToken, async (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  // Only allow: global admin, subadmin with access to this staff's site, or the staff member themself
  const allowedDownload = req.user.role === "admin" || (req.user.role === "subadmin" && (req.user.siteAccess || []).includes(staff.siteId)) || req.user.staffId === staff.id;
  if (!allowedDownload) {
    return res.status(403).json({ error: "Access denied" });
  }

  const document = (staff.documents || []).find((d) => d.id === req.params.docId);
  if (!document) return res.status(404).json({ error: "Document not found" });

  // If document stored as data URL/base64 (legacy), return that
  if (document.documentBase64) {
    const buffer = Buffer.from(document.documentBase64, "base64");
    res.setHeader("Content-Type", getDocumentMimeType(document.fileName));
    res.setHeader("Content-Disposition", `attachment; filename="${document.fileName}"`);
    res.send(buffer);
    addAudit("staff_document_downloaded", req.user, { staffId: staff.id, documentId: document.id, fileName: document.fileName });
    return;
  }

  // Otherwise retrieve from S3 or local path
  try {
    if (document.s3Key && document.s3Key.startsWith("local:")) {
      const filePath = document.s3Key.replace(/^local:/, "");
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Document not found on disk" });
      res.setHeader("Content-Type", getDocumentMimeType(document.fileName));
      res.setHeader("Content-Disposition", `attachment; filename="${document.fileName}"`);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      addAudit("staff_document_downloaded", req.user, { staffId: staff.id, documentId: document.id, fileName: document.fileName, storage: document.s3Key });
      return;
    }

    if (s3 && document.s3Key) {
      const params = { Bucket: S3_BUCKET, Key: document.s3Key };
      const s3Object = await s3.send(new GetObjectCommand(params));
      res.setHeader("Content-Type", getDocumentMimeType(document.fileName));
      res.setHeader("Content-Disposition", `attachment; filename="${document.fileName}"`);
      if (!s3Object.Body || typeof s3Object.Body.pipe !== "function") {
        return res.status(500).json({ error: "Failed to stream S3 document" });
      }
      s3Object.Body.pipe(res);
      addAudit("staff_document_downloaded", req.user, { staffId: staff.id, documentId: document.id, fileName: document.fileName, storage: document.s3Key });
      return;
    }

    return res.status(404).json({ error: "No stored document available" });
  } catch (err) {
    console.error("Failed to retrieve stored document:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "Failed to retrieve document" });
  }
});

app.delete("/api/staff/:staffId/documents/:docId", authenticateToken, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.staffId);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  // Only allow: global admin, subadmin with access to this staff's site, or the staff member themself
  const allowedDelete = req.user.role === "admin" || (req.user.role === "subadmin" && (req.user.siteAccess || []).includes(staff.siteId)) || req.user.staffId === staff.id;
  if (!allowedDelete) return res.status(403).json({ error: "Access denied for this location" });

  const doc = (staff.documents || []).find((d) => d.id === req.params.docId);
  if (doc?.s3Key && s3 && !doc.s3Key.startsWith("local:")) {
    s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: doc.s3Key })).catch((err) => {
      console.warn("Failed to delete S3 object during document delete:", err && err.message ? err.message : err);
    });
  }
  if (doc?.s3Key && doc.s3Key.startsWith("local:")) {
    const filePath = doc.s3Key.replace(/^local:/, "");
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.warn("Failed to remove local file during document delete:", err && err.message ? err.message : err);
      }
    }
  }
  staff.documents = (staff.documents || []).filter((d) => d.id !== req.params.docId);
  res.json({ message: "Document removed" });
  addAudit("staff_document_deleted", req.user, { staffId: staff.id, documentId: req.params.docId });
  saveDbToDisk();
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
  saveDbToDisk();
});

app.delete("/api/sites/:id", authenticateToken, requireAdmin, (req, res) => {
  db.sites = db.sites.filter((s) => s.id !== req.params.id);
  res.json({ message: "Site removed" });
  saveDbToDisk();
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

// Admin-only: view audit log
app.get("/api/audit", authenticateToken, requireAdmin, (req, res) => {
  res.json({ audit: db.audit });
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
  saveDbToDisk();
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
  saveDbToDisk();
});

// New: upload a document for in-app signing (no DocuSign)
app.post("/api/contracts/upload", authenticateToken, async (req, res) => {
  const { staffId, title, documentBase64, fileName } = req.body;
  const staff = db.staff.find((item) => item.id === staffId);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) return res.status(403).json({ error: "Access denied for this location" });

  const instance = {
    id: "contract-" + Date.now(),
    staffId,
    staffName: `${staff.firstName} ${staff.lastName}`,
    templateTitle: title,
    title,
    body: `Please review and sign ${title}`,
    documentBase64: documentBase64 || null,
    completedDocumentBase64: null,
    signatureDataUrl: null,
    status: "pending_signature",
    sentDate: new Date().toISOString(),
    createdBy: req.user.email,
    fileName: fileName || `${title}.pdf`
  };

  db.instances.push(instance);
  try {
    await sendNotificationEmail(staff.email, "New contract request", `A new contract named ${title} is waiting for your signature. Please open the HR portal to review and sign it.`);
  } catch (error) {
    console.warn(`Envelope email failed for ${staff.email}; contract was still created`, error && error.message ? error.message : error);
  }

  res.status(201).json(instance);
  saveDbToDisk();
});

app.post("/api/contracts/:id/sign", authenticateToken, async (req, res) => {
  const contract = db.instances.find((item) => item.id === req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  const staff = db.staff.find((item) => item.id === contract.staffId);
  // Only allow: global admin, subadmin with access to this staff's site, or the staff member themself
  const allowedSign = req.user.role === "admin" || (req.user.role === "subadmin" && (req.user.siteAccess || []).includes(staff?.siteId)) || contract.staffId === req.user.staffId;
  if (!allowedSign) return res.status(403).json({ error: "Access denied" });

  contract.status = "completed";
  contract.signatureDataUrl = req.body.signatureDataUrl || null;
  contract.completedDocumentBase64 = req.body.completedDocumentBase64 || contract.documentBase64;

  // If we have a source PDF and a signature image, attempt to merge the signature into the PDF synchronously
  if (contract.documentBase64 && contract.signatureDataUrl) {
    try {
      const pdfBytes = Buffer.from(contract.documentBase64, "base64");
      const pdfDoc = await PDFDocument.load(pdfBytes);
      // Extract image from data URL
      const imgMatch = String(contract.signatureDataUrl).match(/^data:(image\/.+);base64,(.*)$/s);
      if (imgMatch) {
        const mime = imgMatch[1];
        const imgB64 = imgMatch[2];
        const imgBytes = Buffer.from(imgB64, "base64");
        let embeddedImg;
        if (mime === "image/png") embeddedImg = await pdfDoc.embedPng(imgBytes);
        else embeddedImg = await pdfDoc.embedJpg(imgBytes);

        const pages = pdfDoc.getPages();
        const lastPage = pages[pages.length - 1];
        const { width, height } = lastPage.getSize();

        // Determine natural image size and scale it to a reasonable proportion of the page width
        const natural = embeddedImg.scale(1);
        const maxWidth = Math.min(width * 0.45, natural.width);
        const scaleFactor = maxWidth / natural.width;
        const drawWidth = natural.width * scaleFactor;
        const drawHeight = natural.height * scaleFactor;

        // Place signature in bottom-right with margin
        const margin = 40;
        const x = width - drawWidth - margin;
        const y = margin;
        lastPage.drawImage(embeddedImg, { x, y, width: drawWidth, height: drawHeight });

        const mergedPdfBytes = await pdfDoc.save();
        contract.completedDocumentBase64 = Buffer.from(mergedPdfBytes).toString("base64");
      }
    } catch (err) {
      console.error("Failed to merge signature into PDF:", err && err.message ? err.message : err);
      // fallback: keep signatureDataUrl and completedDocumentBase64 as-is
    }
  }

  contract.signatureDetails = {
    typedName: req.body.typedName || "",
    signedAt: new Date().toISOString()
  };
  contract.body = `${contract.body}\n\nSigned by ${req.body.typedName || "the recipient"}`;
  addAudit("contract_signed", req.user, { contractId: contract.id, staffId: contract.staffId, typedName: contract.signatureDetails.typedName });
  res.json(contract);
});

app.get("/api/contracts/:id/download", authenticateToken, (req, res) => {
  const contract = db.instances.find((item) => item.id === req.params.id);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  const staff = db.staff.find((item) => item.id === contract.staffId);
  if (!isAdminLike(req.user) && contract.staffId !== req.user.staffId && !canManageSite(req.user, staff?.siteId)) return res.status(403).json({ error: "Access denied" });

  const data = contract.completedDocumentBase64 || contract.documentBase64 || contract.signatureDataUrl;
  if (!data) return res.status(404).json({ error: "No document available to download" });

  // If data is a data URL (e.g., data:image/png;base64,...) then parse and return with the correct content-type
  if (typeof data === "string" && data.startsWith("data:")) {
    const match = data.match(/^data:(.+);base64,(.*)$/s);
    if (!match) return res.status(400).json({ error: "Invalid data URL" });
    const mime = match[1];
    const b64 = match[2];
    const buffer = Buffer.from(b64, "base64");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${(contract.fileName || (contract.title || "contract")).replace(/\s+/g, "_")}"`);
    return res.send(buffer);
  }

  // Otherwise assume base64 PDF
  const buffer = Buffer.from(data, "base64");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${(contract.fileName || (contract.title || "contract")).replace(/\s+/g, "_")}.pdf"`);
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
