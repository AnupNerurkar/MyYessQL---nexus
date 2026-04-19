const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'nexus.db');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student','lab_incharge','hod','principal','librarian','accounts')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS clearance_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES users(id),
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pending','in_progress','approved','rejected')),
    current_stage TEXT DEFAULT 'librarian' CHECK(current_stage IN ('librarian','accounts','lab_incharge','hod','principal','done')),
    department TEXT,
    phone_number TEXT,
    address TEXT,
    flagged_stage TEXT,
    flagged_comment TEXT,
    parent_request_id INTEGER REFERENCES clearance_requests(id),
    certificate_token TEXT,
    reminder_sent_flag INTEGER DEFAULT 0,
    reminder_count INTEGER DEFAULT 0,
    last_reminder_sent_at DATETIME,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER REFERENCES clearance_requests(id),
    stage TEXT NOT NULL,
    authority_id INTEGER REFERENCES users(id),
    action TEXT CHECK(action IN ('approved','flagged')),
    comment TEXT,
    acted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS dues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES users(id),
    department TEXT NOT NULL DEFAULT 'Library',
    amount REAL NOT NULL,
    description TEXT DEFAULT 'Due',
    status TEXT DEFAULT 'unpaid' CHECK(status IN ('unpaid','paid')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES users(id),
    due_id INTEGER REFERENCES dues(id),
    amount REAL NOT NULL,
    transaction_ref TEXT UNIQUE NOT NULL,
    paid_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER REFERENCES clearance_requests(id),
    student_id INTEGER REFERENCES users(id),
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    document_role TEXT NOT NULL DEFAULT 'other' CHECK(document_role IN ('library_receipt','lab_manual','grade_card','id_card','other')),
    verification_status TEXT DEFAULT 'pending' CHECK(verification_status IN ('pending','approved','rejected')),
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS academic_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER REFERENCES users(id),
    semester INTEGER NOT NULL,
    subject_code TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    credits INTEGER NOT NULL,
    grade TEXT NOT NULL,
    result TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER REFERENCES clearance_requests(id),
    student_id INTEGER REFERENCES users(id),
    certificate_id TEXT UNIQUE NOT NULL,
    type TEXT CHECK(type IN ('clearance','transcript')),
    file_path TEXT NOT NULL,
    issued_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration for existing databases
const migrate = () => {
  const columns = {
    clearance_requests: [
      { name: 'department', type: 'TEXT' },
      { name: 'phone_number', type: 'TEXT' },
      { name: 'address', type: 'TEXT' },
      { name: 'flagged_stage', type: 'TEXT' },
      { name: 'flagged_comment', type: 'TEXT' },
      { name: 'parent_request_id', type: 'INTEGER' },
      { name: 'certificate_token', type: 'TEXT' },
      { name: 'reminder_sent_flag', type: 'INTEGER DEFAULT 0' },
      { name: 'reminder_count', type: 'INTEGER DEFAULT 0' },
      { name: 'last_reminder_sent_at', type: 'DATETIME' }
    ],
    documents: [
      { name: 'student_id', type: 'INTEGER' },
      { name: 'verification_status', type: 'TEXT DEFAULT "pending"' }
    ]
  };

  for (const [table, cols] of Object.entries(columns)) {
    const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all();
    const existingCols = tableInfo.map(c => c.name);

    if (table === 'clearance_requests') {
      // Re-create table if current_stage check needs update OR new columns missing
      if (!existingCols.includes('reminder_sent_flag')) {
        console.log(`Migrating ${table}: recreating table for Reminder System and Expanded Stages`);
        db.exec('PRAGMA foreign_keys = OFF;');
        db.transaction(() => {
          db.exec(`ALTER TABLE clearance_requests RENAME TO clearance_requests_old`);
          db.exec(`
            CREATE TABLE clearance_requests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              student_id INTEGER REFERENCES users(id),
              status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pending','in_progress','approved','rejected')),
              current_stage TEXT DEFAULT 'librarian' CHECK(current_stage IN ('librarian','accounts','lab_incharge','hod','principal','done')),
              department TEXT,
              phone_number TEXT,
              address TEXT,
              flagged_stage TEXT,
              flagged_comment TEXT,
              parent_request_id INTEGER REFERENCES clearance_requests(id),
              certificate_token TEXT,
              reminder_sent_flag INTEGER DEFAULT 0,
              reminder_count INTEGER DEFAULT 0,
              last_reminder_sent_at DATETIME,
              submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `);
          
          // Mapping existing stages to preserve data as much as possible
          db.exec(`
            INSERT INTO clearance_requests (
              id, student_id, status, current_stage, department, phone_number, address, 
              flagged_stage, flagged_comment, parent_request_id, certificate_token, 
              submitted_at, updated_at
            )
            SELECT 
              id, student_id, status, 
              CASE WHEN current_stage = 'done' THEN 'done' ELSE current_stage END, 
              department, phone_number, address, 
              flagged_stage, flagged_comment, parent_request_id, certificate_token,
              submitted_at, updated_at 
            FROM clearance_requests_old
          `);
          db.exec(`DROP TABLE clearance_requests_old`);
        })();
        db.exec('PRAGMA foreign_keys = ON;');
        continue; 
      }
    }

    if (table === 'documents') {
      if (!existingCols.includes('student_id') || !existingCols.includes('verification_status')) {
        console.log(`Migrating ${table}: recreating table for Vault features`);
        db.transaction(() => {
          db.exec(`ALTER TABLE documents RENAME TO documents_old`);
          db.exec(`
              CREATE TABLE documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_id INTEGER REFERENCES clearance_requests(id),
                student_id INTEGER REFERENCES users(id),
                file_name TEXT NOT NULL,
                file_path TEXT NOT NULL,
                file_type TEXT NOT NULL,
                document_role TEXT NOT NULL DEFAULT 'other' CHECK(document_role IN ('library_receipt','lab_manual','grade_card','id_card','other')),
                verification_status TEXT DEFAULT 'pending' CHECK(verification_status IN ('pending','approved','rejected')),
                uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
              )
            `);
          db.exec(`
              INSERT INTO documents (id, request_id, file_name, file_path, file_type, document_role, uploaded_at)
              SELECT id, request_id, file_name, file_path, file_type, document_role, uploaded_at FROM documents_old
            `);
          db.exec(`
              UPDATE documents SET student_id = (SELECT student_id FROM clearance_requests WHERE id = documents.request_id)
              WHERE request_id IS NOT NULL
            `);
          db.exec(`
              UPDATE documents SET verification_status = 'approved'
              WHERE request_id IN (SELECT id FROM clearance_requests WHERE status = 'approved')
            `);
          db.exec(`DROP TABLE documents_old`);
        })();
        continue; // Recreated with all columns, skip ALTER loop
      }
    }

    for (const col of cols) {
      if (!existingCols.includes(col.name)) {
        console.log(`Migrating ${table}: adding column ${col.name}`);
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`);
      }
    }
  }
};

migrate();

module.exports = db;
