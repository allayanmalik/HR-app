import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import docusign from "docusign-esign";
import { PDFDocument } from "pdf-lib";
import dotenv from "dotenv";
import { createTransport } from "nodemailer";
import { appendAuditLog, ensureDatabaseSchema, loadPersistentState, persistPersistentState } from "./db.js";
import { AWS_REGION, S3_BUCKET_NAME, deleteObjectFromS3, getDocumentUploadMiddleware, getObjectFromS3, uploadBufferToS3 } from "./storage.js";

dotenv.config();

const app = express();
// Trust the first proxy hop (ALB/ECS) so req.ip reflects the real client IP for rate limiting
app.set("trust proxy", 1);
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-production-key-change-me";
const LEGACY_ADMIN_PASSWORD = "admin123";
const LEGACY_ADMIN_PASSWORD_HASH = bcrypt.hashSync(LEGACY_ADMIN_PASSWORD, 10);

const loginAttempts = new Map();
const pendingLogins = new Map();
const passwordResetTokens = new Map();
const INVITE_RESEND_WINDOW_MS = 5 * 60 * 1000;
const TWO_FA_RESEND_WINDOW_MS = 30 * 1000;

if (process.env.NODE_ENV === "production" && (!process.env.JWT_SECRET || process.env.JWT_SECRET === "super-secret-production-key-change-me")) {
  console.error("Insecure JWT_SECRET detected in production. Set a strong JWT_SECRET environment variable.");
  process.exit(1);
}

app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
const allowedCorsOrigins = new Set([
  "http://localhost:5173",
  "https://am-service.co.uk",
  process.env.APP_URL,
  process.env.CORS_ORIGIN
].filter(Boolean));

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedCorsOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
}));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Lightweight in-memory rate limiter for all API routes (defense-in-depth against abuse/DoS)
const apiRequestCounts = new Map();
function apiRateLimiter(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxRequests = 400;
  const record = apiRequestCounts.get(key) || { count: 0, windowStart: now };
  if (now - record.windowStart > windowMs) {
    record.count = 0;
    record.windowStart = now;
  }
  record.count += 1;
  apiRequestCounts.set(key, record);
  if (record.count > maxRequests) {
    return res.status(429).json({ error: "Too many requests. Please slow down and try again shortly." });
  }
  next();
}
app.use("/api", apiRateLimiter);

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

function getUserInviteStatus(user) {
  if (!user) return "unknown";
  if (user.mustSetPassword || !user.passwordHash) return "pending_invitation";
  return "active";
}

async function sendInviteEmail(user, subject, body, invitationType = "invite") {
  user.inviteSentAt = new Date().toISOString();
  user.inviteType = invitationType;
  const token = createPasswordResetToken(user, "setup");
  const inviteLink = `${getAppBaseUrl()}/?setPassword=${token}`;
  await sendNotificationEmail(user.email, subject, body(inviteLink));
  return inviteLink;
}

function ensureInviteCooldown(user) {
  const lastSentAt = user?.inviteSentAt ? new Date(user.inviteSentAt).getTime() : 0;
  const remaining = INVITE_RESEND_WINDOW_MS - (Date.now() - lastSentAt);
  return remaining > 0 ? remaining : 0;
}

function ensure2FACooldown(pending) {
  const lastSentAt = pending?.lastSentAt || 0;
  const remaining = TWO_FA_RESEND_WINDOW_MS - (Date.now() - lastSentAt);
  return remaining > 0 ? remaining : 0;
}

let db = {
  users: buildInitialUsers(),
  sites: [],
  staff: [],
  templates: [],
  instances: [],
  docusignEnvelopes: [],
  audit: []
};

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
    void appendAuditLog(entry).catch((err) => {
      console.error("Failed to persist audit entry to PostgreSQL:", err && err.message ? err.message : err);
    });
    return entry;
  } catch (err) {
    console.error('Failed to record audit entry', err && err.message ? err.message : err);
    return null;
  }
}

function saveDbToDisk() {
  return persistPersistentState(db).catch((err) => {
    console.error("Failed to persist DB to PostgreSQL:", err && err.message ? err.message : err);
  });
}

async function bootstrapDatabase() {
  await ensureDatabaseSchema();
  const { state, hasData } = await loadPersistentState(db);
  Object.assign(db, state);
  if (!db.users || db.users.length === 0) {
    db.users = buildInitialUsers();
  }
  if (!hasData) {
    await persistPersistentState(db);
  }
  console.log("Loaded persisted DB from PostgreSQL", {
    host: process.env.DB_HOST || "hr-portal-db.c5m4oagyag9k.eu-west-2.rds.amazonaws.com",
    database: process.env.DB_NAME || "postgres",
    region: AWS_REGION,
    bucket: S3_BUCKET_NAME
  });
}

const documentUpload = getDocumentUploadMiddleware();

await bootstrapDatabase();

// Check for staff whose right to work is approaching expiry and email the relevant admins/staff member
runRtwExpiryCheck().catch((err) => console.error("Initial RTW expiry check failed", err && err.message ? err.message : err));
setInterval(() => {
  runRtwExpiryCheck().catch((err) => console.error("Scheduled RTW expiry check failed", err && err.message ? err.message : err));
}, 24 * 60 * 60 * 1000);

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
  return process.env.APP_URL || (process.env.NODE_ENV === "production" ? "https://am-service.co.uk" : "http://localhost:5173");
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
    verificationNotes: rtw.verificationNotes || "",
    noTimeLimit: Boolean(rtw.noTimeLimit),
    // Tracks the expiryDate value we last sent notifications for, so we never email twice for the same date
    expiryNotifiedForDate: rtw.expiryNotifiedForDate || null
  };
}

function normalizeAddress(address = {}) {
  const a = address || {};
  return {
    line1: a.line1 || "",
    line2: a.line2 || "",
    city: a.city || "",
    postcode: a.postcode || ""
  };
}

function normalizeSortCode(value = "") {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 6);
  if (digits.length !== 6) return digits;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return null;
  return Math.round((target - Date.now()) / 86400000);
}

function fmtDateForEmail(dateStr) {
  if (!dateStr) return "an unknown date";
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
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

const BRAND_NAME = "AM Service HR Portal";

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildBrandedEmail(subject, text) {
  const brandedSubject = subject.toLowerCase().includes("am service hr portal") ? subject : `${BRAND_NAME}: ${subject}`;
  const logoUrl = `${getAppBaseUrl()}/am-logo.jpg`;
  const brandedText = `${BRAND_NAME}\n\n${text}\n\n— This is an automated message from ${BRAND_NAME}. Please do not reply to this email.`;
  const brandedHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
      <div style="text-align:center;padding:18px 0;background:#0f172a;">
        <img src="${logoUrl}" alt="${BRAND_NAME}" style="height:44px;" />
      </div>
      <div style="padding:22px;color:#1e293b;font-size:14px;line-height:1.6;background:#ffffff;">
        <p style="white-space:pre-line;margin:0 0 16px 0;">${escapeHtml(text)}</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;" />
        <p style="color:#94a3b8;font-size:12px;margin:0;">This is an automated message from ${BRAND_NAME}. Please do not reply to this email.</p>
      </div>
    </div>`;
  return { subject: brandedSubject, text: brandedText, html: brandedHtml };
}

async function sendNotificationEmail(to, subject, text) {
  const branded = buildBrandedEmail(subject, text);

  // Prefer SES when explicitly enabled
  const ses = getSesClient();
  if (ses) {
    const source = process.env.SES_FROM || process.env.SMTP_FROM || "no-reply@hr-app.local";
    const command = new SendEmailCommand({
      Source: `"${BRAND_NAME}" <${source}>`,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: branded.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: branded.text, Charset: "UTF-8" },
          Html: { Data: branded.html, Charset: "UTF-8" }
        }
      }
    });
    const info = await ses.send(command);
    console.log(`[EMAIL][SES] sent to=${to} messageId=${info.MessageId || "n/a"}`);
    return;
  }

  // If a verified SMTP transporter exists, use it and bubble send errors to callers
  if (mailTransporter) {
    const fromAddress = process.env.SMTP_FROM || "no-reply@hr-app.local";
    const info = await mailTransporter.sendMail({
      from: `"${BRAND_NAME}" <${fromAddress}>`,
      to,
      subject: branded.subject,
      text: branded.text,
      html: branded.html
    });
    console.log(`[EMAIL] sent to=${to} messageId=${info.messageId}`);
    return;
  }

  // Dev fallback: log to console and return (does not throw)
  if (DEV_EMAIL_TO_CONSOLE) {
    console.log(`[DEV EMAIL] to=${to}\nsubject=${branded.subject}\n${branded.text}`);
    return;
  }

  // No transporter and no dev fallback: throw so callers can handle the failure explicitly
  throw new Error("No SMTP/SES transporter configured and DEV_EMAIL_TO_CONSOLE is not enabled");
}

async function runRtwExpiryCheck() {
  let changed = false;
  for (const staff of db.staff) {
    const rtw = staff.rtw;
    if (!rtw || rtw.checkType === "not-required" || rtw.noTimeLimit || !rtw.expiryDate) continue;

    const days = daysUntil(rtw.expiryDate);
    if (days === null) continue;

    const site = db.sites.find((s) => s.id === staff.siteId);
    const noticeDaysRaw = Number(site?.rtwNoticeDays);
    const noticeDays = Number.isFinite(noticeDaysRaw) && noticeDaysRaw > 0 ? noticeDaysRaw : 90;

    if (days > noticeDays) continue; // Not within the notice window yet
    if (rtw.expiryNotifiedForDate === rtw.expiryDate) continue; // Already notified for this expiry date

    const fullName = `${staff.firstName} ${staff.lastName}`.trim();
    const recipients = db.users.filter((u) => u.role === "admin" || (u.role === "subadmin" && (u.siteAccess || []).includes(staff.siteId)));
    const staffUser = db.users.find((u) => u.staffId === staff.id);

    for (const admin of recipients) {
      try {
        await sendNotificationEmail(
          admin.email,
          `Right to work expiring: ${fullName}`,
          `${fullName}'s right to work is expiring on ${fmtDateForEmail(rtw.expiryDate)}. Please review their right to work details in the AM Service HR Portal.`
        );
      } catch (err) {
        console.warn(`RTW expiry admin email failed for ${admin.email}`, err && err.message ? err.message : err);
      }
    }

    if (staffUser) {
      try {
        await sendNotificationEmail(
          staffUser.email,
          "Your right to work is expiring soon",
          `Your right to work is expiring soon and a new right to work code or details needs to be issued. You can update this yourself in the AM Service HR Portal under "My details", or contact your manager or HR for assistance.`
        );
      } catch (err) {
        console.warn(`RTW expiry staff email failed for ${staffUser.email}`, err && err.message ? err.message : err);
      }
    }

    rtw.expiryNotifiedForDate = rtw.expiryDate;
    changed = true;
  }

  if (changed) {
    await saveDbToDisk();
  }
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
  pendingLogins.set(user.email.toLowerCase(), { code, userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000, lastSentAt: Date.now() });
  try {
    await sendNotificationEmail(user.email, "Your security code", `Your AM Service HR Portal verification code is ${code}. It expires in 5 minutes.`);
    // Do NOT include the code in the response — it must be delivered only via email.
    res.json({ requires2FA: true, message: "A verification code was sent to your email." });
  } catch (error) {
    console.error(`Email delivery failed for ${user.email}; aborting login flow.`, error && error.message ? error.message : error);
    // Remove pending code so there's no dangling value
    pendingLogins.delete(user.email.toLowerCase());
    return res.status(500).json({ error: "Failed to deliver verification code. Contact the administrator." });
  }
});

app.post("/api/auth/resend-2fa", async (req, res) => {
  const { email } = req.body;
  const key = (email || "").toLowerCase();
  const pending = pendingLogins.get(key);
  if (!pending) {
    return res.status(404).json({ error: "No pending verification code found" });
  }

  const cooldown = ensure2FACooldown(pending);
  if (cooldown > 0) {
    return res.status(429).json({ error: "Please wait 30 seconds before resending the verification email", retryAfterSeconds: Math.ceil(cooldown / 1000) });
  }

  const user = db.users.find((u) => u.id === pending.userId);
  if (!user) {
    pendingLogins.delete(key);
    return res.status(404).json({ error: "User not found" });
  }

  const code = generateCode();
  pending.code = code;
  pending.lastSentAt = Date.now();
  pending.expiresAt = Date.now() + 5 * 60 * 1000;

  try {
    await sendNotificationEmail(user.email, "Your security code", `Your AM Service HR Portal verification code is ${code}. It expires in 5 minutes.`);
    res.json({ message: "A new verification code was sent to your email." });
  } catch (error) {
    console.error(`Failed to resend 2FA code for ${user.email}`, error && error.message ? error.message : error);
    return res.status(500).json({ error: "Failed to resend verification code" });
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
    await sendNotificationEmail(user.email, "Reset your password", `Use this link to create a new password for your AM Service HR Portal account: ${link}`);
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
  const account = db.users.find((user) => user.staffId === staffMember.id);
  return {
    ...staffMember,
    inviteStatus: getUserInviteStatus(account),
    inviteSentAt: account?.inviteSentAt || null,
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
  const users = db.users.filter((user) => user.role === "admin" || user.role === "subadmin").map((user) => ({
    ...user,
    inviteStatus: getUserInviteStatus(user),
    inviteSentAt: user.inviteSentAt || null
  }));
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

  try {
    const assignedSiteNames = (db.sites || []).filter((s) => (newUser.siteAccess || []).includes(s.id)).map((s) => s.name).join(", ") || "(none)";
    await sendInviteEmail(
      newUser,
      "Set up your Business User account",
      (inviteLink) => `Welcome ${cleanName}.

You have been invited to AM Service HR Portal as a Business User with access to the following business location(s): ${assignedSiteNames}.

Please check that your name and email are correct and create your password here: ${inviteLink}`,
      "business-user"
    );
  } catch (error) {
    // If email failed, remove the user we just pushed and return an error so the admin can retry with corrected SMTP settings.
    db.users = db.users.filter((u) => u.id !== newUser.id);
    console.error(`Invite email failed for ${normalizedEmail}; user record removed.`, error && error.message ? error.message : error);
    return res.status(500).json({ error: "Failed to send invite email. User was not created." });
  }

  res.status(201).json({ user: { ...newUser, inviteStatus: getUserInviteStatus(newUser) }, message: "Invitation email sent successfully" });
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

app.post("/api/admin-users/:id/resend-invite", authenticateToken, requireAdmin, async (req, res) => {
  const user = db.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.role !== "subadmin") return res.status(400).json({ error: "Only business users can receive invite emails" });

  const cooldown = ensureInviteCooldown(user);
  if (cooldown > 0) {
    return res.status(429).json({ error: "Please wait 5 minutes before resending the invitation", retryAfterSeconds: Math.ceil(cooldown / 1000) });
  }

  try {
    const assignedSiteNames = (db.sites || []).filter((s) => (user.siteAccess || []).includes(s.id)).map((s) => s.name).join(", ") || "(none)";
    await sendInviteEmail(
      user,
      "Set up your Business User account",
      (inviteLink) => `Welcome ${user.name || user.email}.

You have been invited to AM Service HR Portal as a Business User with access to the following business location(s): ${assignedSiteNames}.

Please create your password here: ${inviteLink}`,
      "business-user"
    );
    res.json({ message: "Invitation resent successfully" });
  } catch (error) {
    console.error(`Failed to resend invite to ${user.email}`, error && error.message ? error.message : error);
    return res.status(500).json({ error: "Failed to resend invitation" });
  }
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
  const { firstName, lastName, email, phone, niNumber, siteId, jobTitle, startDate, dateOfBirth, rtw, address, bankAccountNumber, bankSortCode } = req.body;
  const newStaffId = "staff-" + Date.now();

  const cleanFirstName = (firstName || "").trim();
  const cleanLastName = (lastName || "").trim();
  const cleanEmail = (email || "").trim().toLowerCase();

  // Only name and email are mandatory. Business admins may fill in everything else,
  // and the invited staff member can add or correct any remaining details themselves.
  if (!cleanFirstName || !cleanLastName || !cleanEmail) {
    return res.status(400).json({ error: "First name, last name, and email are required" });
  }

  if (db.users.some((u) => u.email.toLowerCase() === cleanEmail)) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  if (siteId) {
    if (!isAdminLike(req.user) && !canManageSite(req.user, siteId)) {
      return res.status(403).json({ error: "Access denied for this location" });
    }
  } else if (req.user.role !== "admin") {
    return res.status(400).json({ error: "A business/location is required unless you are a global admin" });
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
    firstName: cleanFirstName,
    lastName: cleanLastName,
    email: cleanEmail,
    phone: phone || "",
    niNumber: niNumber || "",
    siteId: siteId || null,
    jobTitle: jobTitle || "",
    startDate: startDate || "",
    dateOfBirth: dateOfBirth || "",
    address: normalizeAddress(address),
    bankAccountNumber: String(bankAccountNumber || "").replace(/\s+/g, ""),
    bankSortCode: normalizeSortCode(bankSortCode),
    training: [],
    documents: [],
    rtw: normalizedRtw
  };

  const newUser = {
    id: "user-" + Date.now(),
    email: cleanEmail,
    passwordHash: null,
    role: "staff",
    staffId: newStaffId,
    mustSetPassword: true,
    inviteType: "staff"
  };

  db.staff.push(newStaff);
  db.users.push(newUser);

  try {
    const site = siteId ? db.sites.find((s) => s.id === siteId) : null;
    const siteName = site?.name || "your organisation";
    await sendInviteEmail(
      newUser,
      "Set up your password",
      (inviteLink) => `Welcome ${cleanFirstName}. AM Service HR Portal has invited you on behalf of ${siteName}. This account lets you access only your own documents and contracts, and you can add or correct your own personal details (such as address, bank details, and right to work information) once you sign in. Please create your password here: ${inviteLink}`,
      "staff"
    );
  } catch (error) {
    console.warn(`Invite email failed for ${cleanEmail}; staff record was still created`, error.message);
  }

  res.status(201).json(newStaff);
  addAudit("staff_created", req.user, { staffId: newStaffId, email: cleanEmail, siteId });
  saveDbToDisk();
});

app.post("/api/staff/:id/resend-invite", authenticateToken, async (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId)) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  const user = db.users.find((u) => u.staffId === staff.id);
  if (!user) return res.status(404).json({ error: "Linked user account not found" });

  const cooldown = ensureInviteCooldown(user);
  if (cooldown > 0) {
    return res.status(429).json({ error: "Please wait 5 minutes before resending the invitation", retryAfterSeconds: Math.ceil(cooldown / 1000) });
  }

  try {
    const site = db.sites.find((s) => s.id === staff.siteId);
    const siteName = site?.name || "your organisation";
    await sendInviteEmail(
      user,
      "Set up your password",
      (inviteLink) => `Welcome ${staff.firstName}. AM Service HR Portal has invited you on behalf of ${siteName}. This account lets you access only your own documents and contracts. Please create your password here: ${inviteLink}`,
      "staff"
    );
    res.json({ message: "Invitation resent successfully" });
  } catch (error) {
    console.warn(`Failed to resend invite to ${user.email}; invite was not sent`, error.message);
    return res.status(500).json({ error: "Failed to resend invitation" });
  }
});

app.put("/api/staff/:id", authenticateToken, (req, res) => {
  const index = db.staff.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Staff member not found" });

  const staff = db.staff[index];
  const isSelf = req.user.role === "staff" && req.user.staffId === staff.id;
  if (!isAdminLike(req.user) && !canManageSite(req.user, staff.siteId) && !isSelf) {
    return res.status(403).json({ error: "Access denied for this location" });
  }

  let incoming = req.body || {};
  if (isSelf) {
    // Staff can add/correct their own personal details, but not business-controlled fields like site, job title, or documents
    const allowedFields = ["firstName", "lastName", "email", "phone", "dateOfBirth", "niNumber", "address", "bankAccountNumber", "bankSortCode", "rtw"];
    incoming = Object.fromEntries(Object.entries(incoming).filter(([key]) => allowedFields.includes(key)));
  }

  if (incoming.firstName !== undefined && !String(incoming.firstName).trim()) return res.status(400).json({ error: "First name cannot be empty" });
  if (incoming.lastName !== undefined && !String(incoming.lastName).trim()) return res.status(400).json({ error: "Last name cannot be empty" });

  if (incoming.email !== undefined) {
    const normalizedEmail = String(incoming.email).trim().toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ error: "Email cannot be empty" });
    if (db.users.some((u) => u.staffId !== req.params.id && u.email.toLowerCase() === normalizedEmail)) {
      return res.status(409).json({ error: "An account with that email already exists" });
    }
    incoming.email = normalizedEmail;
  }

  const updatedStaff = {
    ...staff,
    ...incoming,
    id: req.params.id,
    address: incoming.address !== undefined ? normalizeAddress(incoming.address) : staff.address,
    bankAccountNumber: incoming.bankAccountNumber !== undefined ? String(incoming.bankAccountNumber).replace(/\s+/g, "") : staff.bankAccountNumber,
    bankSortCode: incoming.bankSortCode !== undefined ? normalizeSortCode(incoming.bankSortCode) : staff.bankSortCode,
    rtw: normalizeRtw(incoming.rtw || staff.rtw),
    documents: normalizeDocuments(req.body.documents || staff.documents)
  };
  db.staff[index] = updatedStaff;

  const user = db.users.find((u) => u.staffId === req.params.id);
  if (user && updatedStaff.email) {
    user.email = updatedStaff.email;
  }

  res.json(updatedStaff);
  addAudit("staff_updated", req.user, { staffId: req.params.id, updatedFields: Object.keys(incoming), self: isSelf });
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

app.post("/api/staff/:id/documents", authenticateToken, documentUpload.single("file"), async (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  // Only allow: global admin, subadmin with access to this staff's site, or the staff member themself
  const allowed = req.user.role === "admin" || (req.user.role === "subadmin" && (req.user.siteAccess || []).includes(staff.siteId)) || req.user.staffId === staff.id;
  if (!allowed) return res.status(403).json({ error: "Access denied for this location" });

  const { title } = req.body;
  const fileName = req.file?.originalname || req.body.fileName;
  const documentBase64 = req.body.documentBase64;
  if (!fileName || (!documentBase64 && !req.file)) {
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

  try {
    if (req.file?.key) {
      record.s3Key = req.file.key;
    } else {
      const buffer = Buffer.from(documentBase64, "base64");
      const key = `staff/${staff.id}/${id}/${fileName}`;
      await uploadBufferToS3({ key, body: buffer, contentType: getDocumentMimeType(fileName) });
      record.s3Key = key;
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

  // Otherwise retrieve from S3
  try {
    if (document.s3Key) {
      const s3Object = await getObjectFromS3(document.s3Key);
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
  if (doc?.s3Key) {
    deleteObjectFromS3(doc.s3Key).catch((err) => {
      console.warn("Failed to delete S3 object during document delete:", err && err.message ? err.message : err);
    });
  }
  staff.documents = (staff.documents || []).filter((d) => d.id !== req.params.docId);
  res.json({ message: "Document removed" });
  addAudit("staff_document_deleted", req.user, { staffId: staff.id, documentId: req.params.docId });
  saveDbToDisk();
});

app.post("/api/sites", authenticateToken, requireAdmin, (req, res) => {
  const assignedAdminIds = Array.isArray(req.body.assignedAdminIds) ? req.body.assignedAdminIds : [];
  const rtwNoticeDaysRaw = Number(req.body.rtwNoticeDays);
  const rtwNoticeDays = Number.isFinite(rtwNoticeDaysRaw) && rtwNoticeDaysRaw > 0 ? Math.round(rtwNoticeDaysRaw) : 90;
  const site = { id: "site-" + Date.now(), ...req.body, assignedAdminIds, rtwNoticeDays };
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

// Update business details, including the right-to-work expiry notice period for that business
app.put("/api/sites/:id", authenticateToken, (req, res) => {
  const index = db.sites.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Business not found" });
  if (!canManageSite(req.user, req.params.id)) return res.status(403).json({ error: "Access denied for this location" });

  const { name, address, rtwNoticeDays, assignedAdminIds } = req.body;
  const updated = { ...db.sites[index] };
  if (typeof name === "string" && name.trim()) updated.name = name.trim();
  if (typeof address === "string") updated.address = address;
  if (rtwNoticeDays !== undefined) {
    const days = Number(rtwNoticeDays);
    updated.rtwNoticeDays = Number.isFinite(days) && days > 0 ? Math.round(days) : (updated.rtwNoticeDays || 90);
  }
  if (Array.isArray(assignedAdminIds) && isAdminLike(req.user)) {
    updated.assignedAdminIds = assignedAdminIds;
  }

  db.sites[index] = updated;
  res.json(updated);
  addAudit("site_updated", req.user, { siteId: updated.id, updatedFields: Object.keys(req.body || {}) });
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
    await sendNotificationEmail(staff.email, "New contract assignment", `You have a new contract waiting for your signature: ${template.title}. Please sign it in the AM Service HR Portal.`);
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
    await sendNotificationEmail(staff.email, "New contract request", `A new contract named ${title} is waiting for your signature. Please open the AM Service HR Portal to review and sign it.`);
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
    await sendNotificationEmail(staff.email, "New contract request", `A new contract named ${title} is waiting for your signature. Please open the AM Service HR Portal to review and sign it.`);
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

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Secure HR Portal API running on port ${PORT}`));
