import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const API = process.env.SMOKE_API_BASE || "http://127.0.0.1:5000";
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-production-key-change-me";
const adminEmail = process.env.ADMIN_EMAIL || "allayanmalik@gmail.com";
const runId = Date.now();

const token = jwt.sign(
  { id: "admin-1", email: adminEmail, role: "admin", staffId: null, siteAccess: [] },
  JWT_SECRET,
  { expiresIn: "8h" }
);

const headers = {
  "Content-Type": "application/json",
  Cookie: `token=${token}`
};

async function api(path, method = "GET", body = undefined) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function run() {
  const siteRes = await api("/api/sites", "POST", { name: `AWS Smoke Site ${runId}`, assignedAdminIds: [] });
  if (!siteRes.ok) throw new Error(`Create site failed: ${siteRes.status} ${siteRes.text}`);
  const site = parseJson(siteRes.text);

  const staffRes = await api("/api/staff", "POST", {
    firstName: "Aws",
    lastName: "Smoke",
    email: `aws-smoke-${runId}@example.com`,
    phone: "0000000000",
    niNumber: "AA123456A",
    siteId: site.id,
    jobTitle: "QA",
    startDate: "2026-01-01",
    dateOfBirth: "1990-01-01"
  });
  if (!staffRes.ok) throw new Error(`Create staff failed: ${staffRes.status} ${staffRes.text}`);
  const staff = parseJson(staffRes.text);

  const docRes = await api(`/api/staff/${staff.id}/documents`, "POST", {
    title: "Smoke Doc",
    fileName: "smoke.txt",
    documentBase64: Buffer.from("hello smoke", "utf8").toString("base64")
  });
  if (!docRes.ok) throw new Error(`Upload doc failed: ${docRes.status} ${docRes.text}`);

  const pdfStub = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF";
  const contractRes = await api("/api/contracts/upload", "POST", {
    staffId: staff.id,
    title: "Smoke Contract",
    documentBase64: Buffer.from(pdfStub, "utf8").toString("base64"),
    fileName: "smoke.pdf"
  });
  if (!contractRes.ok) throw new Error(`Create contract failed: ${contractRes.status} ${contractRes.text}`);
  const contract = parseJson(contractRes.text);

  const signRes = await api(`/api/contracts/${contract.id}/sign`, "POST", {
    signatureDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAoMBg6Xc0eEAAAAASUVORK5CYII=",
    typedName: "Aws Smoke"
  });
  if (!signRes.ok) throw new Error(`Sign contract failed: ${signRes.status} ${signRes.text}`);

  const adminRes = await api("/api/admin-users", "POST", {
    name: "AWS Biz",
    email: `aws-biz-${runId}@example.com`,
    siteAccess: [site.id]
  });
  if (!adminRes.ok) throw new Error(`Create business user failed: ${adminRes.status} ${adminRes.text}`);

  const auditRes = await api("/api/audit", "GET");
  if (!auditRes.ok) throw new Error(`Read audit failed: ${auditRes.status} ${auditRes.text}`);
  const audit = parseJson(auditRes.text);
  console.log("SMOKE PASS");
  console.log(`site=${site.id} staff=${staff.id} contract=${contract.id} auditCount=${audit.audit?.length || 0}`);
  console.log(`latestAuditAction=${audit.audit?.[0]?.action || "n/a"}`);
}

run().catch((err) => {
  console.error("SMOKE FAIL:", err.message);
  process.exit(1);
});
