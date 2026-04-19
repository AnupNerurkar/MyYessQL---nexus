/**
 * nexus.e2e.test.js
 * ─────────────────────────────────────────────────────────────────
 * Full end-to-end test suite for Nexus — every API, every role.
 * Runs the complete happy path AND every significant error/guard case.
 *
 * Run with:
 *   npx jest tests/nexus.e2e.test.js --runInBand --forceExit
 *
 * All tests are ordered and stateful — each section builds on
 * the state created by the previous one.  Do NOT run with --parallel.
 * ─────────────────────────────────────────────────────────────────
 */

const request = require('supertest');
const app     = require('../index');
const path    = require('path');
const fs      = require('fs');

// ─── Shared state (populated as tests run) ───────────────────────
const tokens   = {};   // role → JWT token
const users    = {};   // role → { id, name, email, role }
let requestId  = null; // student's active clearance request
let rejectedRequestId = null;
let resubmitRequestId = null;
let dueId      = null;
let sessionId  = null;

// ─── Tiny helpers ────────────────────────────────────────────────
const auth  = role => ({ Authorization: `Bearer ${tokens[role]}` });
const stamp = ()   => Date.now();

// Minimal valid PDF bytes (so multer's mimetype check passes)
const FAKE_PDF = Buffer.from('%PDF-1.4 1 0 obj<</Type/Catalog>>endobj\nxref\n0 0\ntrailer<</Size 1>>\nstartxref\n9\n%%EOF');
const FAKE_JPG = (() => {
  // A valid 1×1 white JPEG
  const b = Buffer.from([
    0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,0x01,0x00,0x00,0x01,
    0x00,0x01,0x00,0x00,0xFF,0xDB,0x00,0x43,0x00,0x08,0x06,0x06,0x07,0x06,0x05,0x08,
    0x07,0x07,0x07,0x09,0x09,0x08,0x0A,0x0C,0x14,0x0D,0x0C,0x0B,0x0B,0x0C,0x19,0x12,
    0x13,0x0F,0x14,0x1D,0x1A,0x1F,0x1E,0x1D,0x1A,0x1C,0x1C,0x20,0x24,0x2E,0x27,0x20,
    0x22,0x2C,0x23,0x1C,0x1C,0x28,0x37,0x29,0x2C,0x30,0x31,0x34,0x34,0x34,0x1F,0x27,
    0x39,0x3D,0x38,0x32,0x3C,0x2E,0x33,0x34,0x32,0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,
    0x00,0x01,0x01,0x01,0x11,0x00,0xFF,0xC4,0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,
    0x01,0x01,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,
    0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,0xFF,0xC4,0x00,0xB5,0x10,0x00,0x02,0x01,0x03,
    0x03,0x02,0x04,0x03,0x05,0x05,0x04,0x04,0x00,0x00,0x01,0x7D,0x01,0x02,0x03,0x00,
    0x04,0x11,0x05,0x12,0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,0x22,0x71,0x14,0x32,
    0x81,0x91,0xA1,0x08,0x23,0x42,0xB1,0xC1,0x15,0x52,0xD1,0xF0,0x24,0x33,0x62,0x72,
    0x82,0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,0x00,0x3F,0x00,0xFB,0xDB,0xFF,0xD9
  ]);
  return b;
})();


// ═══════════════════════════════════════════════════════════════════
// SECTION 1 — AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════
describe('1 · Authentication', () => {

  test('1.1  POST /auth/register — creates a new student account', async () => {
    const res = await request(app).post('/auth/register').send({
      name: 'New Student',
      email: `newstu_${stamp()}@nexus.dev`,
      password: 'pass1234',
      role: 'student'
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.role).toBe('student');
  });

  test('1.2  POST /auth/register — rejects invalid role', async () => {
    const res = await request(app).post('/auth/register').send({
      name: 'Hacker',
      email: `hacker_${stamp()}@nexus.dev`,
      password: 'pass1234',
      role: 'superadmin'
    });
    expect(res.status).toBe(400);
  });

  test('1.3  POST /auth/register — rejects duplicate email', async () => {
    const email = `dup_${stamp()}@nexus.dev`;
    await request(app).post('/auth/register').send({ name: 'First', email, password: 'pass1234', role: 'student' });
    const res = await request(app).post('/auth/register').send({ name: 'Second', email, password: 'pass1234', role: 'student' });
    expect(res.status).toBe(409);
  });

  // Login all six seed/known roles and store tokens
  const loginCases = [
    { role: 'student',     email: 'student@nexus.dev',   password: 'test1234' },
    { role: 'hod',         email: 'hod@nexus.dev',        password: 'test1234' },
    { role: 'lab_incharge',email: 'lab@nexus.dev',         password: 'test1234' },
    { role: 'principal',   email: 'principal@nexus.dev',  password: 'test1234' },
    { role: 'librarian',   email: 'lib@nexus.dev',         password: 'test1234' },
    { role: 'accounts',    email: 'accounts@nexus.dev',   password: 'test1234' },
  ];

  loginCases.forEach(({ role, email, password }) => {
    test(`1.4  POST /auth/login — ${role} gets JWT`, async () => {
      const res = await request(app).post('/auth/login').send({ email, password });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('token');
      tokens[role] = res.body.token;
      users[role]  = res.body.user;
    });
  });

  test('1.5  POST /auth/login — wrong password returns 401', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'student@nexus.dev', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('1.6  POST /auth/login — unknown email returns 401', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'ghost@nexus.dev', password: 'test1234' });
    expect(res.status).toBe(401);
  });

  test('1.7  Protected route — rejects request with no token', async () => {
    const res = await request(app).get('/clearance/mine');
    expect(res.status).toBe(401);
  });

  test('1.8  Protected route — rejects request with malformed token', async () => {
    const res = await request(app).get('/clearance/mine').set('Authorization', 'Bearer not.a.token');
    expect(res.status).toBe(401);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 2 — CLEARANCE SUBMISSION
// ═══════════════════════════════════════════════════════════════════
describe('2 · Clearance submission', () => {

  test('2.1  POST /clearance/submit — student creates a request', async () => {
    const res = await request(app)
      .post('/clearance/submit')
      .set(auth('student'));
    expect([201, 409]).toContain(res.status);
    if (res.status === 201) {
      expect(res.body).toHaveProperty('id');
      requestId = res.body.id;
    }
  });

  test('2.2  POST /clearance/submit — 409 if active request already exists', async () => {
    const res = await request(app)
      .post('/clearance/submit')
      .set(auth('student'));
    expect(res.status).toBe(409);
  });

  test('2.3  POST /clearance/submit — non-student gets 403', async () => {
    const res = await request(app)
      .post('/clearance/submit')
      .set(auth('hod'));
    expect(res.status).toBe(403);
  });

  test('2.4  GET /clearance/mine — returns request with stages array', async () => {
    const res = await request(app)
      .get('/clearance/mine')
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stages');
    expect(res.body.stages).toHaveLength(3);
    // Capture requestId if submit returned 409 (already existed)
    if (!requestId) requestId = res.body.id;
  });

  test('2.5  GET /clearance/mine — all stages start as pending', async () => {
    const res = await request(app)
      .get('/clearance/mine')
      .set(auth('student'));
    res.body.stages.forEach(s => expect(s.status).toBe('pending'));
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 3 — DOCUMENT UPLOAD
// ═══════════════════════════════════════════════════════════════════
describe('3 · Document upload', () => {

  test('3.1  POST /clearance/:id/documents — uploads a PDF', async () => {
    expect(requestId).toBeDefined();
    const res = await request(app)
      .post(`/clearance/${requestId}/documents`)
      .set(auth('student'))
      .attach('docs', FAKE_PDF, { filename: 'library_receipt.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('file_name');
  });

  test('3.2  POST /clearance/:id/documents — uploads a JPEG', async () => {
    const res = await request(app)
      .post(`/clearance/${requestId}/documents`)
      .set(auth('student'))
      .attach('docs', FAKE_JPG, { filename: 'grade_card.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
  });

  test('3.3  POST /clearance/:id/documents — rejects unsupported mime type (PNG)', async () => {
    const res = await request(app)
      .post(`/clearance/${requestId}/documents`)
      .set(auth('student'))
      .attach('docs', Buffer.from('fake png'), { filename: 'bad.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  test('3.4  POST /clearance/:id/documents — non-owner student gets 403', async () => {
    // register a second student and try to upload to the first student's request
    const reg = await request(app).post('/auth/register').send({
      name: 'Other Student', email: `other_${stamp()}@nexus.dev`, password: 'pass1234', role: 'student'
    });
    const login = await request(app).post('/auth/login').send({ email: reg.body.email, password: 'pass1234' });
    const res = await request(app)
      .post(`/clearance/${requestId}/documents`)
      .set('Authorization', `Bearer ${login.body.token}`)
      .attach('docs', FAKE_PDF, { filename: 'impostor.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(403);
  });

  test('3.5  GET /clearance/mine — response now includes documents array', async () => {
    const res = await request(app)
      .get('/clearance/mine')
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('documents');
    expect(res.body.documents.length).toBeGreaterThan(0);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 4 — CLEARANCE STATUS ENDPOINT
// ═══════════════════════════════════════════════════════════════════
describe('4 · Clearance status', () => {

  test('4.1  GET /clearance/status/:id — returns three-stage heatmap shape', async () => {
    const res = await request(app)
      .get(`/clearance/status/${requestId}`)
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stages');
    expect(res.body).toHaveProperty('overall_status');
    expect(res.body).toHaveProperty('current_stage');
    expect(res.body.stages[0]).toHaveProperty('stage', 'lab_incharge');
    expect(['pending','approved','flagged']).toContain(res.body.stages[0].status);
  });

  test('4.2  GET /clearance/status/:id — 404 for nonexistent request', async () => {
    const res = await request(app)
      .get('/clearance/status/99999')
      .set(auth('student'));
    expect(res.status).toBe(404);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 5 — APPROVAL DASHBOARD
// ═══════════════════════════════════════════════════════════════════
describe('5 · Approval dashboard', () => {

  test('5.1  GET /approvals/dashboard — lab_incharge sees requests at their stage', async () => {
    const res = await request(app)
      .get('/approvals/dashboard')
      .set(auth('lab_incharge'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('5.2  GET /approvals/dashboard — student gets 403', async () => {
    const res = await request(app)
      .get('/approvals/dashboard')
      .set(auth('student'));
    expect(res.status).toBe(403);
  });

  test('5.3  GET /approvals/dashboard — response includes student name and documents', async () => {
    const res = await request(app)
      .get('/approvals/dashboard')
      .set(auth('lab_incharge'));
    expect(res.status).toBe(200);
    if (res.body.length > 0) {
      expect(res.body[0]).toHaveProperty('student_name');
      expect(res.body[0]).toHaveProperty('documents');
    }
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 6 — APPROVAL ACTIONS (happy path: all three stages approve)
// ═══════════════════════════════════════════════════════════════════
describe('6 · Approval actions — happy path', () => {

  test('6.1  PATCH /approvals/:id/action — lab_incharge approves → stage advances to hod', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set(auth('lab_incharge'))
      .send({ action: 'approved', comment: 'Lab cleared' });
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('hod');
  });

  test('6.2  PATCH /approvals/:id/action — lab_incharge cannot act again (403)', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set(auth('lab_incharge'))
      .send({ action: 'approved' });
    expect(res.status).toBe(403);
  });

  test('6.3  PATCH /approvals/:id/action — wrong-stage authority gets 403 (lab acting on HOD stage)', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set(auth('lab_incharge'))
      .send({ action: 'approved' });
    expect(res.status).toBe(403);
  });

  test('6.4  PATCH /approvals/:id/action — student cannot act (403)', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set(auth('student'))
      .send({ action: 'approved' });
    expect(res.status).toBe(403);
  });

  test('6.5  PATCH /approvals/:id/action — hod approves → stage advances to principal', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set(auth('hod'))
      .send({ action: 'approved', comment: 'All good' });
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('principal');
  });

  test('6.6  PATCH /approvals/:id/action — principal approves → status = approved, stage = done', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set(auth('principal'))
      .send({ action: 'approved', comment: 'Final sign-off' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.current_stage).toBe('done');
  });

  test('6.7  GET /clearance/status/:id — all three stages show approved', async () => {
    const res = await request(app)
      .get(`/clearance/status/${requestId}`)
      .set(auth('student'));
    expect(res.status).toBe(200);
    res.body.stages.forEach(s => expect(s.status).toBe('approved'));
    expect(res.body.overall_status).toBe('approved');
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 7 — REJECTION + RESUBMISSION FLOW
// ═══════════════════════════════════════════════════════════════════
describe('7 · Rejection and resubmission', () => {
  // We need a fresh student with a pending request for this section
  let freshToken, freshRequestId;

  beforeAll(async () => {
    const email = `fresh_${stamp()}@nexus.dev`;
    await request(app).post('/auth/register').send({ name: 'Fresh Student', email, password: 'pass1234', role: 'student' });
    const login = await request(app).post('/auth/login').send({ email, password: 'pass1234' });
    freshToken = login.body.token;

    const submit = await request(app)
      .post('/clearance/submit')
      .set('Authorization', `Bearer ${freshToken}`);
    freshRequestId = submit.body.id;

    // Lab approves
    await request(app)
      .patch(`/approvals/${freshRequestId}/action`)
      .set(auth('lab_incharge'))
      .send({ action: 'approved', comment: 'OK' });
  });

  test('7.1  PATCH /approvals/:id/action — hod flags with comment → status = rejected', async () => {
    const res = await request(app)
      .patch(`/approvals/${freshRequestId}/action`)
      .set(auth('hod'))
      .send({ action: 'flagged', comment: 'Missing lab manual' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('7.2  GET /clearance/mine — flagged_stage and flagged_comment are populated', async () => {
    const res = await request(app)
      .get('/clearance/mine')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body).toHaveProperty('flagged_stage', 'hod');
    expect(res.body).toHaveProperty('flagged_comment');
  });

  test('7.3  POST /clearance/resubmit — creates new request entering at flagged stage (hod)', async () => {
    const res = await request(app)
      .post('/clearance/resubmit')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.current_stage).toBe('hod');              // skips lab_incharge
    expect(res.body).toHaveProperty('parent_request_id', freshRequestId);
    rejectedRequestId  = freshRequestId;
    resubmitRequestId  = res.body.id;
  });

  test('7.4  POST /clearance/resubmit — 409 if an active request already exists', async () => {
    const res = await request(app)
      .post('/clearance/resubmit')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(res.status).toBe(409);
  });

  test('7.5  GET /clearance/status — resubmission carries forward lab approval', async () => {
    const res = await request(app)
      .get(`/clearance/status/${resubmitRequestId}`)
      .set('Authorization', `Bearer ${freshToken}`);
    expect(res.status).toBe(200);
    const lab = res.body.stages.find(s => s.stage === 'lab_incharge');
    expect(lab.status).toBe('approved');   // carried forward from parent
  });

  test('7.6  Previous rejected request is still accessible by id', async () => {
    const res = await request(app)
      .get(`/clearance/status/${rejectedRequestId}`)
      .set('Authorization', `Bearer ${freshToken}`);
    expect(res.status).toBe(200);
    expect(res.body.overall_status).toBe('rejected');
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 8 — STALE REQUESTS
// ═══════════════════════════════════════════════════════════════════
describe('8 · Stale requests', () => {

  test('8.1  GET /approvals/stale — admin gets 200 with an array', async () => {
    const res = await request(app)
      .get('/approvals/stale')
      .set(auth('lab_incharge'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('8.2  GET /approvals/stale — student is denied (403)', async () => {
    const res = await request(app)
      .get('/approvals/stale')
      .set(auth('student'));
    expect(res.status).toBe(403);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 9 — DUES: CSV UPLOAD
// ═══════════════════════════════════════════════════════════════════
describe('9 · Dues — CSV upload', () => {

  const goodCsv = [
    'student_email,department,amount,description',
    'student@nexus.dev,Library,200,Overdue book fine',
    'student@nexus.dev,Hostel,350,Room damage deposit'
  ].join('\n');

  const skippedCsv = [
    'student_email,department,amount,description',
    'nobody@unknown.dev,Library,100,Fine'
  ].join('\n');

  const badFormatCsv = 'garbage,no,headers\nfoo,bar,baz';

  test('9.1  POST /dues/upload — librarian uploads valid CSV', async () => {
    const res = await request(app)
      .post('/dues/upload')
      .set(auth('librarian'))
      .attach('file', Buffer.from(goodCsv), { filename: 'dues.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.inserted + res.body.updated).toBeGreaterThan(0);
  });

  test('9.2  POST /dues/upload — skips rows with unknown student email', async () => {
    const res = await request(app)
      .post('/dues/upload')
      .set(auth('librarian'))
      .attach('file', Buffer.from(skippedCsv), { filename: 'dues.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBeGreaterThan(0);
  });

  test('9.3  POST /dues/upload — upserts: re-uploading same department updates, not duplicates', async () => {
    const csv = 'student_email,department,amount,description\nstudent@nexus.dev,Library,999,Updated fine';
    const res = await request(app)
      .post('/dues/upload')
      .set(auth('librarian'))
      .attach('file', Buffer.from(csv), { filename: 'dues.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(1);
    expect(res.body.inserted).toBe(0);
  });

  test('9.4  POST /dues/upload — accounts role can also upload', async () => {
    const csv = 'student_email,department,amount,description\nstudent@nexus.dev,Accounts,100,Misc fee';
    const res = await request(app)
      .post('/dues/upload')
      .set(auth('accounts'))
      .attach('file', Buffer.from(csv), { filename: 'dues.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
  });

  test('9.5  POST /dues/upload — student gets 403', async () => {
    const res = await request(app)
      .post('/dues/upload')
      .set(auth('student'))
      .attach('file', Buffer.from(goodCsv), { filename: 'dues.csv', contentType: 'text/csv' });
    expect(res.status).toBe(403);
  });

  test('9.6  POST /dues/upload — non-CSV file is rejected', async () => {
    const res = await request(app)
      .post('/dues/upload')
      .set(auth('librarian'))
      .attach('file', FAKE_PDF, { filename: 'notcsv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 10 — DUES: STUDENT VIEW + BLOCKED FLAG
// ═══════════════════════════════════════════════════════════════════
describe('10 · Dues — student view and blocked flag', () => {

  test('10.1  GET /dues/mine — student sees their dues', async () => {
    const res = await request(app)
      .get('/dues/mine')
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    dueId = res.body.find(d => d.status === 'unpaid')?.id;
  });

  test('10.2  GET /dues/mine — non-student gets 403', async () => {
    const res = await request(app)
      .get('/dues/mine')
      .set(auth('hod'));
    expect(res.status).toBe(403);
  });

  test('10.3  GET /clearance/mine — blocked = true when unpaid dues exist', async () => {
    const res = await request(app)
      .get('/clearance/mine')
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('blocked', true);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 11 — DUES: ADMIN VIEWS + MARK PAID
// ═══════════════════════════════════════════════════════════════════
describe('11 · Dues — admin mark-paid and blocked list', () => {

  test('11.1  GET /dues/blocked — admin sees blocked students', async () => {
    const res = await request(app)
      .get('/dues/blocked')
      .set(auth('librarian'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('student_name');
  });

  test('11.2  GET /dues/blocked — student is denied (403)', async () => {
    const res = await request(app)
      .get('/dues/blocked')
      .set(auth('student'));
    expect(res.status).toBe(403);
  });

  test('11.3  PATCH /dues/:id/mark-paid — librarian marks a due as paid', async () => {
    expect(dueId).toBeDefined();
    const res = await request(app)
      .patch(`/dues/${dueId}/mark-paid`)
      .set(auth('librarian'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
  });

  test('11.4  PATCH /dues/:id/mark-paid — student cannot mark paid (403)', async () => {
    const res = await request(app)
      .patch(`/dues/${dueId}/mark-paid`)
      .set(auth('student'));
    expect(res.status).toBe(403);
  });

  test('11.5  PATCH /dues/:id/mark-paid — 404 for nonexistent due', async () => {
    const res = await request(app)
      .patch('/dues/99999/mark-paid')
      .set(auth('librarian'));
    expect(res.status).toBe(404);
  });

  test('11.6  GET /clearance/mine — blocked = false after all dues paid', async () => {
    // Mark remaining unpaid dues paid so blocked clears
    const dues = await request(app).get('/dues/mine').set(auth('student'));
    for (const d of dues.body.filter(d => d.status === 'unpaid')) {
      await request(app).patch(`/dues/${d.id}/mark-paid`).set(auth('librarian'));
    }
    const res = await request(app).get('/clearance/mine').set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.body.blocked).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 12 — PAYMENT SANDBOX
// ═══════════════════════════════════════════════════════════════════
describe('12 · Payment sandbox', () => {
  let payDueId, paySessionId;

  beforeAll(async () => {
    // Ensure a fresh unpaid due exists for the student
    const csv = 'student_email,department,amount,description\nstudent@nexus.dev,Canteen,50,Meal plan';
    await request(app)
      .post('/dues/upload')
      .set(auth('librarian'))
      .attach('file', Buffer.from(csv), { filename: 'dues.csv', contentType: 'text/csv' });
    const dues = await request(app).get('/dues/mine').set(auth('student'));
    payDueId = dues.body.find(d => d.status === 'unpaid')?.id;
  });

  test('12.1  POST /payments/initiate — returns a session with expiry', async () => {
    expect(payDueId).toBeDefined();
    const res = await request(app)
      .post('/payments/initiate')
      .set(auth('student'))
      .send({ due_id: payDueId });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('session_id');
    expect(res.body).toHaveProperty('expires_at');
    expect(res.body.due_id).toBe(payDueId);
    paySessionId = res.body.session_id;
  });

  test('12.2  POST /payments/initiate — non-student gets 403', async () => {
    const res = await request(app)
      .post('/payments/initiate')
      .set(auth('librarian'))
      .send({ due_id: payDueId });
    expect(res.status).toBe(403);
  });

  test('12.3  POST /payments/initiate — 404 for due belonging to another student', async () => {
    // Use a due ID that exists but belongs to a different student (or doesn't exist)
    const res = await request(app)
      .post('/payments/initiate')
      .set(auth('student'))
      .send({ due_id: 99999 });
    expect([404, 400]).toContain(res.status);
  });

  test('12.4  POST /payments/confirm — returns 200 (success) or 402 (simulated decline)', async () => {
    const res = await request(app)
      .post('/payments/confirm')
      .set(auth('student'))
      .send({ session_id: paySessionId, card_last4: '4242' });
    expect([200, 402]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('transaction_ref');
      expect(res.body).toHaveProperty('receipt');
    } else {
      expect(res.body.success).toBe(false);
    }
  });

  test('12.5  POST /payments/confirm — invalid session returns 400', async () => {
    const res = await request(app)
      .post('/payments/confirm')
      .set(auth('student'))
      .send({ session_id: 'totally-fake-session', card_last4: '0000' });
    expect(res.status).toBe(400);
  });

  test('12.6  POST /payments/confirm — cannot reuse a consumed session', async () => {
    // paySessionId was already used in 12.4 — regardless of success/decline it's consumed
    const res = await request(app)
      .post('/payments/confirm')
      .set(auth('student'))
      .send({ session_id: paySessionId, card_last4: '4242' });
    expect(res.status).toBe(400);
  });

  test('12.7  GET /payments/receipts — student sees payment history', async () => {
    const res = await request(app)
      .get('/payments/receipts')
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('12.8  GET /payments/receipts — non-student gets 403', async () => {
    const res = await request(app)
      .get('/payments/receipts')
      .set(auth('librarian'));
    expect(res.status).toBe(403);
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 13 — CERTIFICATES
// ═══════════════════════════════════════════════════════════════════
describe('13 · Certificates', () => {

  test('13.1  GET /certificates/verify/:id — returns valid=false for nonexistent id', async () => {
    const res = await request(app).get('/certificates/verify/99999');
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  test('13.2  GET /certificates/generate/:id — 403 if request not yet approved', async () => {
    // Use the resubmit request which is still in progress
    if (!resubmitRequestId) return;
    const res = await request(app)
      .get(`/certificates/generate/${resubmitRequestId}`)
      .set(auth('student'));
    expect(res.status).toBe(403);
  });

  test('13.3  GET /certificates/generate/:id — succeeds for fully approved request', async () => {
    // requestId was fully approved in Section 6
    const res = await request(app)
      .get(`/certificates/generate/${requestId}`)
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('download_url');
    expect(res.body).toHaveProperty('file_path');
  });

  test('13.4  GET /certificates/generate/:id — second call returns same file (idempotent)', async () => {
    const res1 = await request(app).get(`/certificates/generate/${requestId}`).set(auth('student'));
    const res2 = await request(app).get(`/certificates/generate/${requestId}`).set(auth('student'));
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.file_path).toBe(res2.body.file_path);
  });

  test('13.5  GET /certificates/verify/:id — returns valid=true for approved request', async () => {
    const res = await request(app).get(`/certificates/verify/${requestId}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body).toHaveProperty('student_name');
    expect(res.body).toHaveProperty('student_email');
    expect(res.body).toHaveProperty('issued_by', 'Nexus University');
  });

  test('13.6  GET /certificates/download/:id — streams PDF with correct content-type', async () => {
    const res = await request(app)
      .get(`/certificates/download/${requestId}`)
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  test('13.7  GET /certificates/download/:id — non-owner student gets 403', async () => {
    const reg   = await request(app).post('/auth/register').send({ name: 'Stranger', email: `str_${stamp()}@nexus.dev`, password: 'pass1234', role: 'student' });
    const login = await request(app).post('/auth/login').send({ email: reg.body.email, password: 'pass1234' });
    const res   = await request(app)
      .get(`/certificates/download/${requestId}`)
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(403);
  });

  test('13.8  GET /certificates/generate/:id — unpaid dues block generation (403)', async () => {
    // Introduce a new due for the student and try to regenerate
    const csv = 'student_email,department,amount,description\nstudent@nexus.dev,Library,10,New fine';
    await request(app).post('/dues/upload').set(auth('librarian'))
      .attach('file', Buffer.from(csv), { filename: 'dues.csv', contentType: 'text/csv' });

    // Delete the cert file so the server doesn't serve the cached copy
    const certPath = path.join(__dirname, '..', 'certificates', `cert_${requestId}.pdf`);
    if (fs.existsSync(certPath)) fs.unlinkSync(certPath);

    const res = await request(app)
      .get(`/certificates/generate/${requestId}`)
      .set(auth('student'));
    expect(res.status).toBe(403);

    // Clean up: mark that due paid so later tests are unaffected
    const dues = await request(app).get('/dues/mine').set('Authorization', `Bearer ${tokens['student']}`);
    for (const d of dues.body.filter(d => d.status === 'unpaid')) {
      await request(app).patch(`/dues/${d.id}/mark-paid`).set(auth('librarian'));
    }
  });

  test('13.9  POST /certificates/export-zip/:studentId — returns a ZIP download', async () => {
    const studentId = users['student']?.id;
    if (!studentId) return;
    const res = await request(app)
      .post(`/certificates/export-zip/${studentId}`)
      .set(auth('student'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/zip/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  test('13.10  GET /certificates/verify/:id — public endpoint needs no token', async () => {
    // No Authorization header at all
    const res = await request(app).get(`/certificates/verify/${requestId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('valid');
  });
});


// ═══════════════════════════════════════════════════════════════════
// SECTION 14 — CROSS-CUTTING GUARD TESTS
// ═══════════════════════════════════════════════════════════════════
describe('14 · Cross-cutting guards', () => {

  test('14.1  Any route — expired / tampered token returns 401', async () => {
    const fakeToken = tokens['student'].slice(0, -5) + 'XXXXX';
    const res = await request(app)
      .get('/clearance/mine')
      .set('Authorization', `Bearer ${fakeToken}`);
    expect(res.status).toBe(401);
  });

  test('14.2  POST /dues/upload — missing file field returns 400', async () => {
    const res = await request(app)
      .post('/dues/upload')
      .set(auth('librarian'));
    expect(res.status).toBe(400);
  });

  test('14.3  PATCH /approvals/:id/action — invalid action value returns 400', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set(auth('principal'))
      .send({ action: 'maybe' });
    expect(res.status).toBe(400);
  });

  test('14.4  POST /clearance/:id/documents — no files attached returns 400', async () => {
    const res = await request(app)
      .post(`/clearance/${requestId}/documents`)
      .set(auth('student'));
    expect(res.status).toBe(400);
  });

  test('14.5  POST /payments/initiate — missing due_id returns 400', async () => {
    const res = await request(app)
      .post('/payments/initiate')
      .set(auth('student'))
      .send({});
    expect(res.status).toBe(400);
  });

  test('14.6  POST /payments/confirm — missing card_last4 returns 400', async () => {
    const res = await request(app)
      .post('/payments/confirm')
      .set(auth('student'))
      .send({ session_id: 'anything' });
    expect(res.status).toBe(400);
  });
});
