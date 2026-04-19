const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../db');
const { authenticate, isStudent } = require('../middleware/auth');

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const requestId = req.params.requestId;
    cb(null, `${requestId}_${file.originalname}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'image/jpeg'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and JPEG are allowed.'));
    }
  }
}).array('docs', 5);

const validateClearanceReady = (requestId) => {
  const request = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  if (!request) return { valid: false, missing: ['Request not found'] };

  const missing = [];
  if (!request.department) missing.push('department');
  if (!request.phone_number) missing.push('phone_number');
  if (!request.address) missing.push('address');

  // Check for documents by student_id and role (Vault-aware)
  const docs = db.prepare('SELECT document_role FROM documents WHERE student_id = ?').all(request.student_id);
  const roles = docs.map(d => d.document_role);

  if (!roles.includes('library_receipt')) missing.push('library_receipt document');
  if (!roles.includes('lab_manual')) missing.push('lab_manual document');
  if (!roles.includes('grade_card')) missing.push('grade_card document');
  if (!roles.includes('id_card')) missing.push('id_card document');

  return {
    valid: missing.length === 0,
    missing
  };
};

// POST /clearance/submit
router.post('/submit', authenticate, isStudent, (req, res) => {
  const studentId = req.user.id;

  // Block if student has unpaid dues
  const unpaidDues = db.prepare("SELECT SUM(amount) as total FROM dues WHERE student_id = ? AND status = 'unpaid'").get(studentId);
  if (unpaidDues?.total > 0) {
    return res.status(402).json({ error: `You have ₹${unpaidDues.total} in unpaid dues. Please clear all dues before starting a clearance application.` });
  }

  // Check for active request (now including 'draft')
  const activeRequest = db.prepare(`
    SELECT * FROM clearance_requests 
    WHERE student_id = ? AND status NOT IN ('approved', 'rejected')
  `).get(studentId);

  if (activeRequest) {
    return res.status(409).json({ error: 'You already have an active clearance request.' });
  }

  const insert = db.prepare(`
    INSERT INTO clearance_requests (student_id, status, current_stage) 
    VALUES (?, 'draft', 'librarian')
  `);
  
  const info = insert.run(studentId);
  const newRequest = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(info.lastInsertRowid);

  res.status(201).json(newRequest);
});

// PATCH /clearance/:requestId/details
router.patch('/:requestId/details', authenticate, isStudent, (req, res) => {
  const { requestId } = req.params;
  const { department, phone_number, address } = req.body;
  const studentId = req.user.id;

  const allowedDepts = ['Computer Science', 'Electronics', 'Mechanical', 'Civil', 'Chemical', 'Physics', 'Mathematics'];
  if (!allowedDepts.includes(department)) {
    return res.status(400).json({ error: 'Invalid department' });
  }

  if (!/^\d{10}$/.test(phone_number)) {
    return res.status(400).json({ error: 'Phone number must be 10 digits' });
  }

  if (!address || address.length < 10) {
    return res.status(400).json({ error: 'Address must be at least 10 characters' });
  }

  const request = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.student_id !== studentId) return res.status(403).json({ error: 'Unauthorized' });
  if (!['draft', 'pending'].includes(request.status)) {
    return res.status(400).json({ error: 'Cannot edit an approved or in-progress request' });
  }

  db.prepare(`
    UPDATE clearance_requests 
    SET department = ?, phone_number = ?, address = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(department, phone_number, address, requestId);

  const updated = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  res.json(updated);
});

// POST /clearance/:requestId/documents
router.post('/:requestId/documents', authenticate, isStudent, (req, res) => {
  try {
    upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    const requestId = req.params.requestId;
    const studentId = req.user.id;

    // Check ownership
    const request = db.prepare('SELECT student_id FROM clearance_requests WHERE id = ?').get(requestId);
    if (!request) {
      return res.status(404).json({ error: 'Clearance request not found' });
    }
    if (request.student_id !== studentId) {
      return res.status(403).json({ error: 'Unauthorized to upload documents for this request' });
    }

    let { document_role } = req.body || {};
    const files = req.files;

    if (!document_role) document_role = 'other';

    if (!['library_receipt', 'lab_manual', 'grade_card', 'id_card', 'other'].includes(document_role)) {
      return res.status(400).json({ error: 'Invalid document role' });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded.' });
    }

    const insertDoc = db.prepare(`
      INSERT INTO documents (request_id, student_id, file_name, file_path, file_type, document_role) 
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const uploadedDocs = [];
    const transaction = db.transaction((files) => {
      for (const file of files) {
        const info = insertDoc.run(requestId, studentId, file.originalname, file.path, file.mimetype, document_role);
        uploadedDocs.push({
          id: info.lastInsertRowid,
          request_id: requestId,
          student_id: studentId,
          file_name: file.originalname,
          file_path: file.path,
          file_type: file.mimetype,
          document_role
        });
      }
    });

    transaction(files);

    res.json(uploadedDocs);
    });
  } catch (error) {
    console.error('Document upload outer error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /clearance/:requestId/ready
router.post('/:requestId/ready', authenticate, isStudent, (req, res) => {
  const { requestId } = req.params;
  const studentId = req.user.id;

  const request = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.student_id !== studentId) return res.status(403).json({ error: 'Unauthorized' });

  // Block if student still has unpaid dues
  const unpaidDues = db.prepare("SELECT SUM(amount) as total FROM dues WHERE student_id = ? AND status = 'unpaid'").get(studentId);
  if (unpaidDues?.total > 0) {
    return res.status(402).json({ error: `You have ₹${unpaidDues.total} in unpaid dues. Please settle them before submitting for review.` });
  }

  const validation = validateClearanceReady(requestId);
  if (!validation.valid) {
    return res.status(422).json({ error: 'Incomplete application', missing: validation.missing });
  }

  db.transaction(() => {
    // 1. Link any floating vault documents to this request
    db.prepare(`
      UPDATE documents 
      SET request_id = ? 
      WHERE student_id = ? AND request_id IS NULL
    `).run(requestId, studentId);

    // 2. Mark application as pending and record submission time
    db.prepare(`
      UPDATE clearance_requests 
      SET status = 'pending', updated_at = CURRENT_TIMESTAMP, submitted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(requestId);
  })();

  const updated = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  res.json(updated);
});

// POST /clearance/resubmit
router.post('/resubmit', authenticate, isStudent, (req, res) => {
  const studentId = req.user.id;

  // Check for active request
  const activeRequest = db.prepare(`
    SELECT * FROM clearance_requests 
    WHERE student_id = ? AND status NOT IN ('approved', 'rejected')
  `).get(studentId);

  if (activeRequest) {
    return res.status(409).json({ error: 'You already have an active clearance request.' });
  }

  // Get most recent rejected request
  const lastRejected = db.prepare(`
    SELECT * FROM clearance_requests 
    WHERE student_id = ? AND status = 'rejected'
    ORDER BY submitted_at DESC LIMIT 1
  `).get(studentId);

  if (!lastRejected) {
    return res.status(400).json({ error: 'No rejected request found to resubmit.' });
  }

  const transaction = db.transaction(() => {
    // Create new request
    const insert = db.prepare(`
      INSERT INTO clearance_requests (student_id, status, current_stage, department, phone_number, address, parent_request_id) 
      VALUES (?, 'draft', ?, ?, ?, ?, ?)
    `);
    
    const info = insert.run(studentId, lastRejected.flagged_stage, lastRejected.department, lastRejected.phone_number, lastRejected.address, lastRejected.id);
    const newRequestId = info.lastInsertRowid;

    // Copy documents
    const docs = db.prepare('SELECT * FROM documents WHERE request_id = ?').all(lastRejected.id);
    const insertDoc = db.prepare(`
      INSERT INTO documents (request_id, file_name, file_path, file_type, document_role) 
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const doc of docs) {
      insertDoc.run(newRequestId, doc.file_name, doc.file_path, doc.file_type, doc.document_role);
    }

    // Carry forward approvals
    // Advance current_stage: librarian → accounts → lab_incharge → hod → principal → done
    const stages = ['librarian', 'accounts', 'lab_incharge', 'hod', 'principal'];
    const lastRejectedStageIndex = stages.indexOf(lastRejected.flagged_stage);
    
    if (lastRejectedStageIndex > 0) {
      const approvedStages = stages.slice(0, lastRejectedStageIndex);
      const approvals = db.prepare('SELECT * FROM approvals WHERE request_id = ?').all(lastRejected.id);
      const insertApproval = db.prepare(`
        INSERT INTO approvals (request_id, stage, authority_id, action, comment)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      for (const stage of approvedStages) {
        const approval = approvals.find(a => a.stage === stage && a.action === 'approved');
        if (approval) {
          insertApproval.run(newRequestId, stage, approval.authority_id, 'approved', approval.comment);
        }
      }
    }

    return db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(newRequestId);
  });

  const newRequest = transaction();
  res.status(201).json(newRequest);
});

// GET /clearance/mine
router.get('/mine', authenticate, isStudent, (req, res) => {
  const studentId = req.user.id;

  const request = db.prepare(`
    SELECT * FROM clearance_requests 
    WHERE student_id = ? 
    ORDER BY id DESC LIMIT 1
  `).get(studentId);

  // Fetch all documents for the student (Vault + Request-specific)
  const documents = db.prepare('SELECT * FROM documents WHERE student_id = ?').all(studentId);
  const dues = db.prepare('SELECT * FROM dues WHERE student_id = ?').all(studentId);
  const blocked = dues.some(d => d.status === 'unpaid');

  const groupedDocs = {
    library_receipt: documents.filter(d => d.document_role === 'library_receipt'),
    lab_manual: documents.filter(d => d.document_role === 'lab_manual'),
    grade_card: documents.filter(d => d.document_role === 'grade_card'),
    id_card: documents.filter(d => d.document_role === 'id_card'),
    other: documents.filter(d => d.document_role === 'other')
  };

  if (!request) {
    return res.json({ 
      message: 'No clearance request found.', 
      id: null,
      status: 'none',
      stages: [], 
      dues: dues,
      documents: documents,
      grouped_documents: groupedDocs,
      blocked: blocked
    });
  }

  const approvals = db.prepare('SELECT * FROM approvals WHERE request_id = ?').all(request.id);
  const stages = ['librarian', 'accounts', 'lab_incharge', 'hod', 'principal'];
  const stageBreakdown = stages.map(stage => {
    const action = approvals.find(a => a.stage === stage);
    return {
      stage: stage,
      status: action ? action.action : 'pending',
      comment: action ? action.comment : null,
      acted_at: action ? action.acted_at : null
    };
  });

  res.json({
    ...request,
    stages: stageBreakdown,
    documents: documents, 
    grouped_documents: groupedDocs, 
    approvals,
    dues,
    blocked,
    validation: validateClearanceReady(request.id)
  });
});

// GET /clearance/status/:requestId
router.get('/status/:requestId', authenticate, isStudent, (req, res) => {
  const requestId = req.params.requestId;
  const request = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);

  if (!request) {
    return res.status(404).json({ error: 'Request not found.' });
  }

  const stages = ['librarian', 'accounts', 'lab_incharge', 'hod', 'principal'];
  const approvals = db.prepare('SELECT * FROM approvals WHERE request_id = ?').all(requestId);

  const stageBreakdown = stages.map(stage => {
    const action = approvals.find(a => a.stage === stage);
    return {
      stage: stage,
      status: action ? action.action : 'pending',
      comment: action ? action.comment : null,
      acted_at: action ? action.acted_at : null
    };
  });

  res.json({
    stages: stageBreakdown,
    overall_status: request.status,
    current_stage: request.current_stage
  });
});

// DELETE /clearance/:requestId — withdraw an application (only draft or pending)
router.delete('/:requestId', authenticate, isStudent, (req, res) => {
  const { requestId } = req.params;
  const studentId = req.user.id;

  const request = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.student_id !== studentId) return res.status(403).json({ error: 'Unauthorized' });
  if (request.status === 'approved') return res.status(400).json({ error: 'Approved applications cannot be withdrawn.' });

  // Delete in order: approvals, documents, then request
  db.transaction(() => {
    db.prepare('DELETE FROM approvals WHERE request_id = ?').run(requestId);
    db.prepare('DELETE FROM documents WHERE request_id = ?').run(requestId);
    db.prepare('DELETE FROM clearance_requests WHERE id = ?').run(requestId);
  })();

  res.json({ message: 'Application withdrawn successfully.' });
});

module.exports = router;
