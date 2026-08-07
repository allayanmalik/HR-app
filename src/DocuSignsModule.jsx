import React, { useState, useEffect } from "react";

export default function DocuSignContractsModule({ currentUser }) {
  const [contracts, setContracts] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [selectedStaff, setSelectedStaff] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [signingUrl, setSigningUrl] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchContracts();
    if (currentUser.role === "admin") {
      fetchDirectory();
    }
  }, []);

  const fetchContracts = async () => {
    try {
      const res = await fetch("/api/contracts");
      const data = await res.json();
      setContracts(data.docusignEnvelopes || []);
    } catch (err) {
      console.error("Failed to load contracts:", err);
    }
  };

  const fetchDirectory = async () => {
    try {
      const res = await fetch("/api/directory");
      const data = await res.json();
      setStaffList(data.staff || []);
    } catch (err) {
      console.error("Failed to load staff list:", err);
    }
  };

  // Convert uploaded file to Base64
  const toBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = (error) => reject(error);
    });

  // ADMIN: Upload PDF & Request Signature
  const handleSendContract = async (e) => {
    e.preventDefault();
    if (!selectedStaff || !selectedFile || !documentTitle) {
      alert("Please fill all fields and select a PDF file.");
      return;
    }

    setLoading(true);
    try {
      const base64Data = await toBase64(selectedFile);
      const res = await fetch("/api/docusign/send-envelope", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: selectedStaff,
          title: documentTitle,
          documentBase64: base64Data,
          fileName: selectedFile.name
        })
      });

      if (res.ok) {
        alert("Contract sent successfully! Email notification dispatched to staff.");
        setDocumentTitle("");
        setSelectedFile(null);
        fetchContracts();
      } else {
        const err = await res.json();
        alert(`Error: ${err.error}`);
      }
    } catch (err) {
      console.error(err);
      alert("Failed to send envelope.");
    } finally {
      setLoading(false);
    }
  };

  // STAFF: Launch Embedded DocuSign Signing Session inside modal
  const handleStartSigning = async (envelopeId) => {
    setLoading(true);
    try {
      const res = await fetch("/api/docusign/create-recipient-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          envelopeId,
          returnUrl: window.location.href
        })
      });

      const data = await res.json();
      if (data.signingUrl) {
        setSigningUrl(data.signingUrl);
      } else {
        alert("Could not load embedded signing session.");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // DOWNLOAD: Download signed document
  const handleDownload = (envelopeId, title) => {
    window.open(`/api/docusign/contracts/${envelopeId}/download`, "_blank");
  };

  return (
    <div style={{ padding: "20px", fontFamily: "sans-serif" }}>
      <h2>DocuSign Document Management</h2>

      {/* ADMIN PANEL: UPLOAD & REQUEST SIGNATURE */}
      {currentUser.role === "admin" && (
        <div style={{ background: "#f5f5f5", padding: "15px", borderRadius: "8px", marginBottom: "25px" }}>
          <h3>Upload Document & Request Signature</h3>
          <form onSubmit={handleSendContract}>
            <div style={{ marginBottom: "10px" }}>
              <label>Select Staff Member: </label>
              <select
                value={selectedStaff}
                onChange={(e) => setSelectedStaff(e.target.value)}
                style={{ width: "100%", padding: "8px", marginTop: "4px" }}
                required
              >
                <option value="">-- Choose Staff --</option>
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.firstName} {s.lastName} ({s.email})
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: "10px" }}>
              <label>Document Title: </label>
              <input
                type="text"
                placeholder="e.g. Non-Disclosure Agreement"
                value={documentTitle}
                onChange={(e) => setDocumentTitle(e.target.value)}
                style={{ width: "100%", padding: "8px", marginTop: "4px" }}
                required
              />
            </div>

            <div style={{ marginBottom: "15px" }}>
              <label>Upload Document (PDF): </label>
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setSelectedFile(e.target.files[0])}
                style={{ display: "block", marginTop: "4px" }}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{ padding: "10px 20px", backgroundColor: "#005cb9", color: "#fff", border: "none", borderRadius: "4px" }}
            >
              {loading ? "Dispatching..." : "Send via DocuSign"}
            </button>
          </form>
        </div>
      )}

      {/* CONTRACTS TABLE FOR STAFF & ADMIN */}
      <h3>Contract Documents</h3>
      <table border="1" cellPadding="10" cellSpacing="0" style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#eee" }}>
            <th>Title</th>
            <th>Staff Name</th>
            <th>Status</th>
            <th>Sent Date</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {contracts.length === 0 ? (
            <tr>
              <td colSpan="5" style={{ textAlign: "center" }}>No contracts available.</td>
            </tr>
          ) : (
            contracts.map((c) => (
              <tr key={c.id}>
                <td>{c.title}</td>
                <td>{c.staffName}</td>
                <td>
                  <span style={{ color: c.status === "completed" ? "green" : "orange", fontWeight: "bold" }}>
                    {c.status.toUpperCase()}
                  </span>
                </td>
                <td>{new Date(c.sentDate).toLocaleDateString()}</td>
                <td>
                  {c.status !== "completed" && (currentUser.role === "admin" || c.staffId === currentUser.staffId) && (
                    <button
                      onClick={() => handleStartSigning(c.id)}
                      style={{ padding: "5px 10px", backgroundColor: "#007bff", color: "#fff", border: "none", borderRadius: "3px", marginRight: "5px" }}
                    >
                      Sign in Portal
                    </button>
                  )}

                  <button
                    onClick={() => handleDownload(c.id, c.title)}
                    style={{ padding: "5px 10px", backgroundColor: "#28a745", color: "#fff", border: "none", borderRadius: "3px" }}
                  >
                    Download PDF
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* EMBEDDED DOCUSIGN SIGNING MODAL */}
      {signingUrl && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.7)", padding: "20px" }}>
          <div style={{ background: "#fff", height: "100%", borderRadius: "8px", position: "relative", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "10px", textAlign: "right", borderBottom: "1px solid #ccc" }}>
              <button
                onClick={() => { setSigningUrl(null); fetchContracts(); }}
                style={{ padding: "5px 15px", backgroundColor: "#dc3545", color: "#fff", border: "none" }}
              >
                Close Window
              </button>
            </div>
            <iframe src={signingUrl} title="DocuSign Signing" style={{ width: "100%", height: "100%", border: "none" }} />
          </div>
        </div>
      )}
    </div>
  );
}