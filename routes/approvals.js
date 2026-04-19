const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate, authorizeRoles } = require('../middleware/auth');

// GET /approvals/dashboard
// Returns all clearance_requests where current_stage matches the logged-in user's role
router.get('/dashboard', authenticate, authorizeRoles('lab_incharge', 'hod', 'principal', 'librarian', 'accounts'), (req, res) => {
  const role = req.user.role;
  
  const query = `
    SELECT 
      cr.id, 
      cr.status, 
      cr.current_stage, 
      cr.submitted_at, 
      u.name as student_name, 
      u.email as student_email
    FROM clearance_requests cr
    JOIN users u ON cr.student_id = u.id
    WHERE cr.current_stage = ? AND cr.status IN ('pending', 'in_progress')
    ORDER BY cr.submitted_at ASC
  `;
  
  const requests = db.prepare(query).all(role);
  
  // Fetch documents for each request
  const requestsWithDocs = requests.map(req => {
    const docs = db.prepare('SELECT id, file_name, file_path, file_type, document_role, uploaded_at FROM documents WHERE request_id = ?').all(req.id);
    return { ...req, documents: docs };
  });
  
  res.json(requestsWithDocs);
});

// PATCH /approvals/:requestId/action
router.patch('/:requestId/action', authenticate, authorizeRoles('lab_incharge', 'hod', 'principal', 'librarian', 'accounts'), (req, res) => {
  const { requestId } = req.params;
  const { action, comment } = req.body;
  const authorityId = req.user.id;
  const role = req.user.role;

  if (!['approved', 'flagged'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  // Get current request state
  const request = db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  
  if (!request) {
    return res.status(404).json({ error: 'Clearance request not found' });
  }

  // Validate authority stage
  if (request.current_stage !== role) {
    return res.status(403).json({ error: `You are not authorized to act on this stage. Current stage: ${request.current_stage}` });
  }

  const transaction = db.transaction(() => {
    // Insert into approvals table
    db.prepare(`
      INSERT INTO approvals (request_id, stage, authority_id, action, comment)
      VALUES (?, ?, ?, ?, ?)
    `).run(requestId, role, authorityId, action, comment || null);

    let nextStage = request.current_stage;
    let nextStatus = request.status;
    let certToken = request.certificate_token;

    if (action === 'approved') {
      if (role === 'librarian') {
        nextStage = 'accounts';
        nextStatus = 'in_progress';
      } else if (role === 'accounts') {
        nextStage = 'lab_incharge';
        nextStatus = 'in_progress';
      } else if (role === 'lab_incharge') {
        nextStage = 'hod';
        nextStatus = 'in_progress';
      } else if (role === 'hod') {
        nextStage = 'principal';
        nextStatus = 'in_progress';
      } else if (role === 'principal') {
        const crypto = require('crypto');
        nextStage = 'done';
        nextStatus = 'approved';
        certToken = crypto.randomUUID();
      }
    } else if (action === 'flagged') {
      nextStatus = 'rejected';
      db.prepare(`
        UPDATE clearance_requests 
        SET flagged_stage = ?, flagged_comment = ?
        WHERE id = ?
      `).run(role, comment || '', requestId);
    }

    db.prepare(`
      UPDATE clearance_requests 
      SET current_stage = ?, status = ?, certificate_token = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextStage, nextStatus, certToken, requestId);

    return db.prepare('SELECT * FROM clearance_requests WHERE id = ?').get(requestId);
  });

  try {
    const updatedRequest = transaction();
    res.json(updatedRequest);
  } catch (error) {
    console.error('Approval action error:', error);
    res.status(500).json({ error: 'Failed to process approval action' });
  }
});

// GET /approvals/stale
router.get('/stale', authenticate, authorizeRoles('lab_incharge', 'hod', 'principal', 'librarian', 'accounts'), (req, res) => {
  // Returns requests where updated_at is more than 2 minutes old (testing)
  // In production, this would be 2 days.
  const threshold = process.env.NODE_ENV === 'production' ? '-2 days' : '-2 minutes';
  
  const query = `
    SELECT 
      cr.id, 
      cr.status, 
      cr.current_stage, 
      cr.updated_at,
      cr.reminder_count,
      cr.last_reminder_sent_at,
      u.name as student_name, 
      u.email as student_email
    FROM clearance_requests cr
    JOIN users u ON cr.student_id = u.id
    WHERE cr.updated_at < datetime('now', '${threshold}')
    AND cr.status IN ('pending', 'in_progress')
  `;
  
  const staleRequests = db.prepare(query).all();
  res.json(staleRequests);
});

module.exports = router;
