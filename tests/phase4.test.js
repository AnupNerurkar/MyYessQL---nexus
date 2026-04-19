const request = require('supertest');
const app = require('../index');
const db = require('../db');

describe('Phase 4 — Structured Data and Resubmission', () => {
  let studentToken, labToken, hodToken, principalToken;
  let requestId;

  beforeAll(async () => {
    // Rely on index.js seeding
    const login = async (email) => {
      const res = await request(app).post('/auth/login').send({ email, password: 'test1234' });
      return res.body.token;
    };

    studentToken = await login('student@nexus.dev');
    labToken = await login('lab@nexus.dev');
    hodToken = await login('hod@nexus.dev');
    principalToken = await login('principal@nexus.dev');

    // Clear previous requests for clean test
    db.prepare('DELETE FROM approvals').run();
    db.prepare('DELETE FROM documents').run();
    db.prepare('DELETE FROM clearance_requests').run();
  });

  test('Student submits a new request (status should be draft)', async () => {
    const res = await request(app)
      .post('/clearance/submit')
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    requestId = res.body.id;
  });

  test('Update request details', async () => {
    const res = await request(app)
      .patch(`/clearance/${requestId}/details`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        department: 'Computer Science',
        phone_number: '1234567890',
        address: '123 Test Street, New York'
      });
    
    expect(res.status).toBe(200);
    expect(res.body.department).toBe('Computer Science');
    expect(res.body.phone_number).toBe('1234567890');
  });

  test('Upload documents with roles', async () => {
    // We'll simulate file upload by mocking or just checking the database if we can't easily send files here
    // But since we use multer, we should try to send something
    const roles = ['library_receipt', 'lab_manual', 'grade_card'];
    for (const role of roles) {
      const res = await request(app)
        .post(`/clearance/${requestId}/documents`)
        .set('Authorization', `Bearer ${studentToken}`)
        .field('document_role', role)
        .attach('docs', Buffer.from('test content'), 'test.pdf');
      
      expect(res.status).toBe(200);
      expect(res.body[0].document_role).toBe(role);
    }
  });

  test('Ready check (should pass now)', async () => {
    const res = await request(app)
      .post(`/clearance/${requestId}/ready`)
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
  });

  test('Lab Incharge approves', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set('Authorization', `Bearer ${labToken}`)
      .send({ action: 'approved', comment: 'Lab OK' });
    
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('hod');
  });

  test('HOD flags the request', async () => {
    const res = await request(app)
      .patch(`/approvals/${requestId}/action`)
      .set('Authorization', `Bearer ${hodToken}`)
      .send({ action: 'flagged', comment: 'Incorrect manual' });
    
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.flagged_stage).toBe('hod');
    expect(res.body.flagged_comment).toBe('Incorrect manual');
  });

  test('Resubmit request', async () => {
    const res = await request(app)
      .post('/clearance/resubmit')
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.current_stage).toBe('hod'); // Should start at HOD
    expect(res.body.parent_request_id).toBe(requestId);
    expect(res.body.department).toBe('Computer Science');

    const newRequestId = res.body.id;

    // Verify approvals carried forward
    const mine = await request(app)
      .get('/clearance/mine')
      .set('Authorization', `Bearer ${studentToken}`);
    
    const labStage = mine.body.stages.find(s => s.stage === 'lab_incharge');
    expect(labStage.status).toBe('approved');
    expect(labStage.comment).toBe('Lab OK');

    // Verify documents carried forward
    expect(mine.body.documents.library_receipt.length).toBeGreaterThan(0);
    expect(mine.body.documents.lab_manual.length).toBeGreaterThan(0);
    expect(mine.body.documents.grade_card.length).toBeGreaterThan(0);
  });
});
