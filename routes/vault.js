const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const db = require('../db');
const { authenticate, isStudent, isAdmin } = require('../middleware/auth');

// Configure multer for vault uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/vault/';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const studentId = req.user.id;
    cb(null, `student_${studentId}_${Date.now()}_${file.originalname}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and JPEG are allowed.'));
    }
  }
}).single('file');

// POST /vault/upload
router.post('/upload', authenticate, isStudent, (req, res) => {
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const studentId = req.user.id;
    const { document_role, request_id } = req.body;

    if (!['library_receipt', 'lab_manual', 'grade_card', 'id_card', 'other'].includes(document_role)) {
      return res.status(400).json({ error: 'Invalid document role' });
    }

    try {
      // Normalize path for web (replace backslashes with forward slashes)
      const normalizedPath = req.file.path.replace(/\\/g, '/');

      db.transaction(() => {
        // REPLACE LOGIC: If a document with this role already exists for the student, remove it
        // In the Smart Vault, we only keep the latest version for each role
        const existing = db.prepare('SELECT file_path FROM documents WHERE student_id = ? AND document_role = ?').get(studentId, document_role);
        
        if (existing) {
          // Delete physical file if it exists
          if (fs.existsSync(existing.file_path)) {
            try { fs.unlinkSync(existing.file_path); } catch(e) {}
          }
          // Delete DB record
          db.prepare('DELETE FROM documents WHERE student_id = ? AND document_role = ?').run(studentId, document_role);
        }

        // Insert new document
        const info = db.prepare(`
          INSERT INTO documents (student_id, request_id, file_name, file_path, file_type, document_role, verification_status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `).run(studentId, request_id || null, req.file.originalname, normalizedPath, req.file.mimetype, document_role);

        res.status(201).json({
          id: info.lastInsertRowid,
          file_name: req.file.originalname,
          document_role,
          request_id: request_id || null,
          verification_status: 'pending',
          file_path: normalizedPath
        });
      })();
    } catch (error) {
      console.error('Vault upload error:', error);
      res.status(500).json({ error: error.message });
    }
  });
});

// GET /vault/my-documents
router.get('/my-documents', authenticate, isStudent, (req, res) => {
  try {
    const docs = db.prepare('SELECT * FROM documents WHERE student_id = ? ORDER BY uploaded_at DESC').all(req.user.id);
    res.json(docs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /vault/pending (Admin/Staff only)
router.get('/pending', authenticate, (req, res) => {
  // Any staff member can verify
  if (req.user.role === 'student') return res.status(403).json({ error: 'Forbidden' });

  try {
    const docs = db.prepare(`
      SELECT d.*, u.name as student_name, u.email as student_email 
      FROM documents d
      JOIN users u ON d.student_id = u.id
      WHERE d.verification_status = 'pending'
      ORDER BY d.uploaded_at ASC
    `).all();
    res.json(docs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /vault/verify/:id (Admin/Staff only)
router.patch('/verify/:id', authenticate, (req, res) => {
  if (req.user.role === 'student') return res.status(403).json({ error: 'Forbidden' });

  const { id } = req.params;
  const { status } = req.body; // 'approved' or 'rejected'

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const result = db.prepare('UPDATE documents SET verification_status = ? WHERE id = ?').run(status, id);
    if (result.changes === 0) return res.status(404).json({ error: 'Document not found' });
    res.json({ message: `Document ${status} successfully` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /vault/export (One-Click Download ZIP)
router.get('/export', authenticate, isStudent, async (req, res) => {
  const studentId = req.user.id;
  const rawName = req.user.name || 'Student';
  const studentName = rawName.replace(/\s+/g, '_');

  try {
    // Get all docs
    const docs = db.prepare('SELECT * FROM documents WHERE student_id = ?').all(studentId);
    // Get certificates
    const certs = db.prepare('SELECT * FROM certificates WHERE student_id = ?').all(studentId);
    // Get receipts (payments)
    const payments = db.prepare(`
      SELECT p.*, d.department, d.description 
      FROM payments p 
      JOIN dues d ON p.due_id = d.id 
      WHERE p.student_id = ?
    `).all(studentId);

    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.attachment(`${studentName}_Nexus_Vault.zip`);
    archive.pipe(res);

    // Add Documents
    docs.forEach(doc => {
      if (fs.existsSync(doc.file_path)) {
        archive.file(doc.file_path, { name: `Documents/${doc.document_role}/${doc.file_name}` });
      }
    });

    // Add Certificates
    certs.forEach(cert => {
      if (fs.existsSync(cert.file_path)) {
        archive.file(cert.file_path, { name: `Certificates/${path.basename(cert.file_path)}` });
      }
    });

    // Generate a simple text file for payment summary if no physical receipts exist
    let paymentSummary = "Institutional Payment Summary\n===========================\n\n";
    payments.forEach(p => {
      paymentSummary += `Date: ${p.paid_at}\nDept: ${p.department}\nDesc: ${p.description}\nAmount: ₹${p.amount}\nRef: ${p.transaction_ref}\n---------------------------\n`;
    });
    archive.append(paymentSummary, { name: 'Payment_Summary.txt' });

    await archive.finalize();
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
