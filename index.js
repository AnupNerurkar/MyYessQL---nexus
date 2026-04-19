require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const authRouter = require('./routes/auth');
const clearanceRouter = require('./routes/clearance');
const approvalsRouter = require('./routes/approvals');
const duesRouter = require('./routes/dues');
const paymentsRouter = require('./routes/payments');
const certificatesRouter = require('./routes/certificates');
const vaultRouter = require('./routes/vault');
const { authenticate } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────
// Must be BEFORE express.json() to handle raw body for signature verification
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook Signature Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
        const intent = event.data.object;
        const studentId = intent.metadata.student_id;
        const dueId = intent.metadata.due_id;
        const amount = intent.amount / 100;

        console.log(`✅ Payment successful: Student ${studentId}, Due ${dueId}`);

        try {
            db.transaction(() => {
                const existing = db.prepare('SELECT id FROM payments WHERE transaction_ref = ?').get(intent.id);
                if (!existing) {
                    db.prepare('INSERT INTO payments (student_id, due_id, amount, transaction_ref) VALUES (?, ?, ?, ?)')
                      .run(studentId, dueId, amount, intent.id);
                    db.prepare("UPDATE dues SET status = 'paid' WHERE id = ?").run(dueId);
                }
            })();
        } catch (err) {
            console.error('Database update failed for webhook:', err);
        }
    }

    res.json({ received: true });
});

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/auth', authRouter);
app.use('/clearance', clearanceRouter);
app.use('/approvals', approvalsRouter);
app.use('/dues', duesRouter);
app.use('/payments', paymentsRouter);
app.use('/certificates', certificatesRouter);
app.use('/vault', vaultRouter);
// UI Routes
app.get('/dashboard',  (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/receipts',   (req, res) => res.sendFile(path.join(__dirname, 'public/receipts.html')));
app.get('/staff',      (req, res) => res.sendFile(path.join(__dirname, 'public/staff.html')));
app.get('/librarian',  (req, res) => res.sendFile(path.join(__dirname, 'public/librarian.html')));
app.get('/verify/:id',  (req, res) => res.sendFile(path.join(__dirname, 'public/verify.html')));


// Seed test users
const seedUsers = async () => {
  const password_hash = await bcrypt.hash('test1234', 10);
  const usersToSeed = [
    { name: 'Hritani', email: 'student@nexus.dev', role: 'student' },
    { name: 'Dr Mehta', email: 'hod@nexus.dev', role: 'hod' },
    { name: 'Lab Incharge', email: 'lab@nexus.dev', role: 'lab_incharge' },
    { name: 'Principal Roy', email: 'principal@nexus.dev', role: 'principal' },
    { name: 'Librarian Sen', email: 'lib@nexus.dev', role: 'librarian' },
    { name: 'Accounts Dept', email: 'accounts@nexus.dev', role: 'accounts' }
  ];

  const checkUser = db.prepare('SELECT id FROM users WHERE email = ?');
  const insertUser = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)');

  for (const user of usersToSeed) {
    const existing = checkUser.get(user.email);
    if (!existing) {
      console.log(`Seeding user: ${user.name} (${user.role})...`);
      insertUser.run(user.name, user.email, password_hash, user.role);
    }
  }
  console.log('Seeding process completed.');
};

// Seed academic data for transcript generator
const seedAcademicData = () => {
  const student = db.prepare('SELECT id FROM users WHERE email = ?').get('student@nexus.dev');
  if (!student) return;

  const checkRecord = db.prepare('SELECT id FROM academic_records WHERE student_id = ? LIMIT 1').get(student.id);
  if (checkRecord) return;

  console.log('Seeding academic records for student...');
  const insertRecord = db.prepare(`
    INSERT INTO academic_records (student_id, semester, subject_code, subject_name, credits, grade, result)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const subjects = [
    { sem: 1, code: 'CS101', name: 'Introduction to Programming', cr: 4, g: 'A+', r: 'PASS' },
    { sem: 1, code: 'MA101', name: 'Engineering Mathematics I', cr: 4, g: 'A', r: 'PASS' },
    { sem: 1, code: 'PH101', name: 'Engineering Physics', cr: 3, g: 'B+', r: 'PASS' },
    { sem: 2, code: 'CS201', name: 'Data Structures & Algorithms', cr: 4, g: 'O', r: 'PASS' },
    { sem: 2, code: 'EC201', name: 'Basic Electronics', cr: 3, g: 'A', r: 'PASS' },
    { sem: 3, code: 'CS301', name: 'Database Management Systems', cr: 4, g: 'A+', r: 'PASS' },
    { sem: 3, code: 'CS302', name: 'Operating Systems', cr: 4, g: 'A', r: 'PASS' },
    { sem: 4, code: 'CS401', name: 'Computer Networks', cr: 4, g: 'A+', r: 'PASS' },
    { sem: 4, code: 'CS402', name: 'Software Engineering', cr: 3, g: 'A', r: 'PASS' }
  ];

  for (const s of subjects) {
    insertRecord.run(student.id, s.sem, s.code, s.name, s.cr, s.g, s.r);
  }
  console.log('Academic records seeded.');
};

// Execute seeding
seedUsers().then(() => {
  seedAcademicData();
}).catch(err => {
  console.error('Error seeding users:', err);
});

// Initialize Background Services
const reminderService = require('./services/reminder_service');
reminderService.start();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nexus server running on port ${PORT}`);
  });
}

module.exports = app;
