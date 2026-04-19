const request = require('supertest');
const app = require('../index');

describe('Phase 3 — Approvals', () => {
  let labToken, hodToken, studentRequestId;

  beforeAll(async () => {
    const db = require('../db');
    db.prepare('DELETE FROM approvals').run();
    db.prepare('DELETE FROM documents').run();
    db.prepare('DELETE FROM clearance_requests').run();

    const lab = await request(app).post('/auth/login').send({ email: 'lab@nexus.dev', password: 'test1234' });
    labToken = lab.body.token;
    const hod = await request(app).post('/auth/login').send({ email: 'hod@nexus.dev', password: 'test1234' });
    hodToken = hod.body.token;
    
    // Ensure student has a request
    const student = await request(app).post('/auth/login').send({ email: 'student@nexus.dev', password: 'test1234' });
    const studentToken = student.body.token;
    
    // Submit a fresh request
    await request(app).post('/clearance/submit').set('Authorization', `Bearer ${studentToken}`);
    
    // get student's request id
    const mine = await request(app).get('/clearance/mine').set('Authorization', `Bearer ${studentToken}`);
    studentRequestId = mine.body.id;
  });

  test('GET /approvals/dashboard returns pending requests for lab_incharge', async () => {
    const res = await request(app)
      .get('/approvals/dashboard')
      .set('Authorization', `Bearer ${labToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('PATCH /approvals/:id/action — lab approves a request', async () => {
    const res = await request(app)
      .patch(`/approvals/${studentRequestId}/action`)
      .set('Authorization', `Bearer ${labToken}`)
      .send({ action: 'approved', comment: 'All good' });
    expect(res.status).toBe(200);
    expect(res.body.current_stage).toBe('hod');
  });

  test('PATCH /approvals/:id/action — lab cannot act again after approving', async () => {
    const res = await request(app)
      .patch(`/approvals/${studentRequestId}/action`)
      .set('Authorization', `Bearer ${labToken}`)
      .send({ action: 'approved' });
    expect(res.status).toBe(403);
  });

  test('PATCH /approvals/:id/action — HOD can flag with comment', async () => {
    const res = await request(app)
      .patch(`/approvals/${studentRequestId}/action`)
      .set('Authorization', `Bearer ${hodToken}`)
      .send({ action: 'flagged', comment: 'Missing lab manual' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('GET /approvals/stale returns requests older than 2 days', async () => {
    const res = await request(app)
      .get('/approvals/stale')
      .set('Authorization', `Bearer ${labToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
