import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cors from "cors";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";
import docusign from "docusign-esign";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-production-key-change-me";

app.use(express.json({ limit: "25mb" })); // Increased limit to support PDF uploading
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

/* ---------------------------------------------------------------------- */
/* In-Memory Database                                                      */
/* ---------------------------------------------------------------------- */
function buildInitialUsers() {
  const adminEmail = (process.env.ADMIN_EMAIL || "admin@hr-app.local").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";

  return [
    {
      id: "admin-1",
      email: adminEmail,
      passwordHash: bcrypt.hashSync(adminPassword, 10),
      role: "admin",
      staffId: null
    }
  ];
}

let db = {
  users: buildInitialUsers(),
  sites: [],
  staff: [],
  templates: [],
  instances: [],
  docusignEnvelopes: [] // Stores metadata & completed PDF buffers for DocuSign docs
};

/* ---------------------------------------------------------------------- */
/* Security Middleware                                                     */
/* ---------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------- */
/* DocuSign Integration Helpers                                           */
/* ---------------------------------------------------------------------- */
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

/* ---------------------------------------------------------------------- */
/* Auth Endpoints                                                         */
/* ---------------------------------------------------------------------- */
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find((u) => u.email.toLowerCase() === (email || "").toLowerCase());

  if (!user || !bcrypt.compareSync(password || "", user.passwordHash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, staffId: user.staffId },
    JWT_SECRET,
    { expiresIn: "8h" }
  );

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

/* ---------------------------------------------------------------------- */
/* Staff & Directory Endpoints                                            */
/* ---------------------------------------------------------------------- */
app.get("/api/directory", authenticateToken, (req, res) => {
  if (req.user.role === "admin") {
    return res.json({ sites: db.sites, staff: db.staff });
  }
  
  const myStaff = db.staff.find((s) => s.id === req.user.staffId);
  const mySite = db.sites.filter((s) => s.id === myStaff?.siteId);
  res.json({ sites: mySite, staff: myStaff ? [myStaff] : [] });
});

app.post("/api/staff", authenticateToken, requireAdmin, (req, res) => {
  const { firstName, lastName, email, phone, niNumber, password, siteId, jobTitle, startDate, rtw } = req.body;
  const newStaffId = "staff-" + Date.now();

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
    training: [],
    rtw: rtw || { checkType: "not-required" }
  };

  const newUser = {
    id: "user-" + Date.now(),
    email,
    passwordHash: bcrypt.hashSync(password || "staff123", 10),
    role: "staff",
    staffId: newStaffId
  };

  db.staff.push(newStaff);
  db.users.push(newUser);

  res.status(201).json(newStaff);
});

app.put("/api/staff/:id", authenticateToken, requireAdmin, (req, res) => {
  const index = db.staff.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Staff member not found" });

  db.staff[index] = { ...db.staff[index], ...req.body, id: req.params.id };
  res.json(db.staff[index]);
});

app.delete("/api/staff/:id", authenticateToken, requireAdmin, (req, res) => {
  db.staff = db.staff.filter((s) => s.id !== req.params.id);
  db.users = db.users.filter((u) => u.staffId !== req.params.id);
  db.instances = db.instances.filter((c) => c.staffId !== req.params.id);
  db.docusignEnvelopes = db.docusignEnvelopes.filter((e) => e.staffId !== req.params.id);
  res.json({ message: "Staff removed successfully" });
});

app.post("/api/staff/:id/rtw-verify", authenticateToken, requireAdmin, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });

  staff.rtw = {
    ...staff.rtw,
    lastVerifiedDate: new Date().toISOString().slice(0, 10),
    verifiedBy: req.body.verifiedBy
  };
  res.json(staff);
});

/* ---------------------------------------------------------------------- */
/* Training Endpoints                                                      */
/* ---------------------------------------------------------------------- */
app.post("/api/staff/:id/training", authenticateToken, requireAdmin, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });

  const record = { id: "tr-" + Date.now(), ...req.body };
  staff.training = staff.training || [];
  staff.training.push(record);
  res.status(201).json(record);
});

app.delete("/api/staff/:staffId/training/:recordId", authenticateToken, requireAdmin, (req, res) => {
  const staff = db.staff.find((s) => s.id === req.params.staffId);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });

  staff.training = (staff.training || []).filter((r) => r.id !== req.params.recordId);
  res.json({ message: "Training record removed" });
});

/* ---------------------------------------------------------------------- */
/* Locations / Sites Endpoints                                           */
/* ---------------------------------------------------------------------- */
app.post("/api/sites", authenticateToken, requireAdmin, (req, res) => {
  const site = { id: "site-" + Date.now(), ...req.body };
  db.sites.push(site);
  res.status(201).json(site);
});

app.delete("/api/sites/:id", authenticateToken, requireAdmin, (req, res) => {
  if (db.staff.some((s) => s.siteId === req.params.id)) {
    return res.status(400).json({ error: "Cannot delete site with active staff members." });
  }
  db.sites = db.sites.filter((s) => s.id !== req.params.id);
  res.json({ message: "Location removed" });
});

/* ---------------------------------------------------------------------- */
/* Contract & DocuSign Endpoints                                          */
/* ---------------------------------------------------------------------- */

// GET: Fetch all contracts (Internal + DocuSign) based on role
app.get("/api/contracts", authenticateToken, (req, res) => {
  if (req.user.role === "admin") {
    return res.json({ 
      templates: db.templates, 
      instances: db.instances,
      docusignEnvelopes: db.docusignEnvelopes.map(({ pdfBuffer, ...meta }) => meta) 
    });
  }
  
  const myInstances = db.instances.filter((c) => c.staffId === req.user.staffId);
  const myDocuSignEnvelopes = db.docusignEnvelopes
    .filter((e) => e.staffId === req.user.staffId)
    .map(({ pdfBuffer, ...meta }) => meta);

  res.json({ templates: [], instances: myInstances, docusignEnvelopes: myDocuSignEnvelopes });
});

// ADMIN: Upload dynamic document and request signature via DocuSign (Sends Email)
app.post("/api/docusign/send-envelope", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { staffId, title, documentBase64, fileName } = req.body;
    const staff = db.staff.find((s) => s.id === staffId);

    if (!staff) return res.status(404).json({ error: "Staff member not found" });
    if (!documentBase64) return res.status(400).json({ error: "No document base64 data provided" });

    const dsApiClient = await getDocuSignApiClient();
    const envelopesApi = new docusign.EnvelopesApi(dsApiClient);

    // 1. Create Document
    const doc = new docusign.Document();
    doc.documentBase64 = documentBase64;
    doc.name = title || "Employment Document";
    doc.fileExtension = fileName ? fileName.split(".").pop() : "pdf";
    doc.documentId = "1";

    // 2. Setup Signer & Placement Anchor
    const clientUserId = "1000"; // Enables embedded signing if launched in app
    const signHere = new docusign.SignHere();
    signHere.anchorString = "/sn1/";
    signHere.anchorUnits = "pixels";
    signHere.anchorYOffset = "10";
    signHere.anchorXOffset = "20";

    const tabs = new docusign.Tabs();
    tabs.signHereTabs = [signHere];

    const signer = new docusign.Signer();
    signer.email = staff.email;
    signer.name = `${staff.firstName} ${staff.lastName}`;
    signer.recipientId = "1";
    signer.clientUserId = clientUserId;
    signer.tabs = tabs;

    const recipients = new docusign.Recipients();
    recipients.signers = [signer];

    // 3. Construct Envelope
    const envDef = new docusign.EnvelopeDefinition();
    envDef.emailSubject = `Signature Required: ${title}`;
    envDef.documents = [doc];
    envDef.recipients = recipients;
    envDef.status = "sent"; // Immediately triggers email dispatch from DocuSign to recipient

    // 4. Send Envelope via API
    const summary = await envelopesApi.createEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, {
      envelopeDefinition: envDef
    });

    // 5. Save Record to Database
    const envelopeRecord = {
      id: summary.envelopeId,
      title: title || "Signature Request",
      staffId: staff.id,
      staffName: `${staff.firstName} ${staff.lastName}`,
      staffEmail: staff.email,
      status: "sent",
      sentDate: new Date().toISOString(),
      signedDate: null,
      pdfBuffer: null
    };

    db.docusignEnvelopes.push(envelopeRecord);
    res.status(201).json(envelopeRecord);
  } catch (error) {
    console.error("DocuSign Send Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: "Failed to dispatch DocuSign envelope" });
  }
});

// STAFF/ADMIN: Generate Embedded Signing URL for in-portal signing
app.post("/api/docusign/create-recipient-view", authenticateToken, async (req, res) => {
  try {
    const { envelopeId, returnUrl } = req.body;
    const envelope = db.docusignEnvelopes.find((e) => e.id === envelopeId);

    if (!envelope) return res.status(404).json({ error: "Envelope not found" });

    // Ensure staff member only signs their own envelope
    if (req.user.role !== "admin" && envelope.staffId !== req.user.staffId) {
      return res.status(403).json({ error: "Unauthorized access to envelope" });
    }

    const dsApiClient = await getDocuSignApiClient();
    const envelopesApi = new docusign.EnvelopesApi(dsApiClient);

    const viewRequest = new docusign.RecipientViewRequest();
    viewRequest.authenticationMethod = "none";
    viewRequest.clientUserId = "1000";
    viewRequest.recipientId = "1";
    viewRequest.returnUrl = returnUrl || "http://localhost:5173/signing-complete";
    viewRequest.userName = envelope.staffName;
    viewRequest.email = envelope.staffEmail;

    const recipientView = await envelopesApi.createRecipientView(
      process.env.DOCUSIGN_ACCOUNT_ID,
      envelopeId,
      { recipientViewRequest: viewRequest }
    );

    res.json({ signingUrl: recipientView.url });
  } catch (error) {
    console.error("DocuSign Session Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: "Could not launch embedded signing UI" });
  }
});

// DOWNLOAD: Retrieve fully signed PDF document (Staff & Admin)
app.get("/api/docusign/contracts/:id/download", authenticateToken, async (req, res) => {
  try {
    const envelope = db.docusignEnvelopes.find((e) => e.id === req.params.id);

    if (!envelope) return res.status(404).json({ error: "Document record not found" });
    if (req.user.role !== "admin" && envelope.staffId !== req.user.staffId) {
      return res.status(403).json({ error: "Unauthorized access to document" });
    }

    // If PDF document buffer is already cached in-memory
    if (envelope.pdfBuffer) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${envelope.title}.pdf"`);
      return res.send(envelope.pdfBuffer);
    }

    // Fetch live directly from DocuSign API if not cached locally
    const dsApiClient = await getDocuSignApiClient();
    const envelopesApi = new docusign.EnvelopesApi(dsApiClient);

    const pdfData = await envelopesApi.getDocument(process.env.DOCUSIGN_ACCOUNT_ID, envelope.id, "combined");
    const buffer = Buffer.from(pdfData, "binary");
    
    // Cache for subsequent requests
    envelope.pdfBuffer = buffer;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${envelope.title}.pdf"`);
    res.send(buffer);
  } catch (error) {
    console.error("Download Error:", error);
    res.status(500).json({ error: "Failed to download signed contract" });
  }
});

// WEBHOOK / RETURN ROUTE: Updates status when signing finishes
app.post("/api/docusign/webhook", async (req, res) => {
  const { envelopeId, status } = req.body;
  const envelope = db.docusignEnvelopes.find((e) => e.id === envelopeId);

  if (envelope) {
    envelope.status = status || "completed";
    envelope.signedDate = new Date().toISOString();
  }
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Secure HR Portal API running on port ${PORT}`));