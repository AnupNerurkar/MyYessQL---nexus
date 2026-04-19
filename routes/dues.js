const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');
const { authenticate, authorizeRoles } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage() });

// POST /dues/upload
router.post('/upload', authenticate, authorizeRoles('librarian', 'accounts'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Basic validation: must be CSV
  if (req.file.mimetype !== 'text/csv' && !req.file.originalname.endsWith('.csv')) {
    return res.status(400).json({ error: 'Only CSV files are allowed' });
  }

  try {
    const records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    const findUser = db.prepare('SELECT id FROM users WHERE email = ?');
    const findDue = db.prepare("SELECT id FROM dues WHERE student_id = ? AND department = ? AND status = 'unpaid'");
    const updateDue = db.prepare('UPDATE dues SET amount = ? WHERE id = ?');
    const insertDue = db.prepare('INSERT INTO dues (student_id, department, amount, description) VALUES (?, ?, ?, ?)');

    const transaction = db.transaction((rows) => {
      for (const row of rows) {
        const student_email = (row.student_email || '').trim();
        const amount        = parseFloat(row.amount);
        const department    = (row.department    || 'Library').trim();
        const description   = (row.description   || 'Due').trim();

        if (!student_email || isNaN(amount) || amount <= 0) {
          skipped++;
          errors.push(`Invalid row — email: "${student_email}", amount: "${row.amount}"`);
          continue;
        }

        const user = findUser.get(student_email);
        if (!user) {
          skipped++;
          errors.push(`Student not found: ${student_email}`);
          continue;
        }

        const existingDue = findDue.get(user.id, department);
        if (existingDue) {
          updateDue.run(amount, existingDue.id);
          updated++;
        } else {
          insertDue.run(user.id, department, amount, description);
          inserted++;
        }
      }
    });

    transaction(records);

    res.json({ inserted, updated, skipped, errors });
  } catch (error) {
    console.error('CSV parse error:', error);
    res.status(400).json({ error: 'Failed to parse CSV: ' + error.message });
  }
});

// GET /dues/mine
router.get('/mine', authenticate, authorizeRoles('student'), (req, res) => {
  const studentId = req.user.id;
  const dues = db.prepare('SELECT * FROM dues WHERE student_id = ?').all(studentId);
  res.json(dues);
});

// PATCH /dues/:dueId/mark-paid
router.patch('/:dueId/mark-paid', authenticate, authorizeRoles('librarian', 'accounts'), (req, res) => {
  const { dueId } = req.params;
  
  const result = db.prepare("UPDATE dues SET status = 'paid' WHERE id = ?").run(dueId);
  
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Due not found' });
  }

  const updatedDue = db.prepare('SELECT * FROM dues WHERE id = ?').get(dueId);
  res.json(updatedDue);
});

// GET /dues/blocked
router.get('/blocked', authenticate, authorizeRoles('lab_incharge', 'hod', 'principal', 'librarian', 'accounts'), (req, res) => {
  const query = `
    SELECT 
      u.name as student_name, 
      u.email as student_email,
      d.id as due_id,
      d.department,
      d.amount,
      d.description,
      d.status
    FROM users u
    JOIN dues d ON u.id = d.student_id
    WHERE d.status = 'unpaid'
  `;
  
  const blockedStudents = db.prepare(query).all();
  res.json(blockedStudents);
});

// GET /dues/all — librarian sees every due
router.get('/all', authenticate, authorizeRoles('librarian', 'accounts'), (req, res) => {
  const rows = db.prepare(`
    SELECT d.id, d.department, d.amount, d.description, d.status,
           u.name as student_name, u.email as student_email
    FROM dues d JOIN users u ON d.student_id = u.id
    ORDER BY d.status ASC, u.name ASC
  `).all();
  res.json(rows);
});

// GET /dues/students — per-student totals (for librarian overview)
router.get('/students', authenticate, authorizeRoles('librarian', 'accounts'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.email,
           SUM(CASE WHEN d.status='unpaid' THEN d.amount ELSE 0 END) as unpaid_total,
           COUNT(CASE WHEN d.status='unpaid' THEN 1 END) as unpaid_count
    FROM users u
    LEFT JOIN dues d ON u.id = d.student_id
    WHERE u.role = 'student'
    GROUP BY u.id ORDER BY unpaid_total DESC
  `).all();
  res.json(rows);
});

module.exports = router;
