const request = require('supertest');
const app = require('../index');
const fs = require('fs');

describe('Phase 6 — Certificates', () => {
  let studentToken, principalToken, approvedRequestId;

  beforeAll(async () => {
    const stu = await request(app).post('/auth/login').send({ email: 'student@nexus.dev', password: 'test1234' });
    studentToken = stu.body.token;
    const pri = await request(app).post('/auth/login').send({ email: 'principal@nexus.dev', password: 'test1234' });
    principalToken = pri.body.token;
    // get approved request if exists
    const mine = await request(app).get('/clearance/mine').set('Authorization', `Bearer ${studentToken}`);
    if (mine.body.status === 'approved') approvedRequestId = mine.body.id;
  });

  test('GET /certificates/verify/:id returns valid=false for unapproved request', async () => {
    const res = await request(app).get('/certificates/verify/9999');
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  test('GET /certificates/generate/:id returns 403 if not approved', async () => {
    if (approvedRequestId) return; // skip if already approved
    const mine = await request(app).get('/clearance/mine').set('Authorization', `Bearer ${studentToken}`);
    const id = mine.body.id;
    const res = await request(app)
      .get(`/certificates/generate/${id}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  test('GET /certificates/generate/:id succeeds for approved request', async () => {
    if (!approvedRequestId) {
      console.log('Skipping — no approved request available. Run full approval flow first.');
      return;
    }
    const res = await request(app)
      .get(`/certificates/generate/${approvedRequestId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('download_url');
  });

  test('GET /certificates/verify/:id returns valid=true for approved request', async () => {
    if (!approvedRequestId) return;
    const res = await request(app).get(`/certificates/verify/${approvedRequestId}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body).toHaveProperty('student_name');
  });
});
