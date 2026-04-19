const request = require('supertest');
const app = require('../index');
const db = require('../db');

describe('Phase 5 — Payments', () => {
  let studentToken, dueId, sessionId;

  beforeAll(async () => {
    const stu = await request(app).post('/auth/login').send({ email: 'student@nexus.dev', password: 'test1234' });
    studentToken = stu.body.token;
    // ensure a due exists (re-upload)
    const lib = await request(app).post('/auth/login').send({ email: 'lib@nexus.dev', password: 'test1234' });
    const csv = 'student_email,department,amount,description\nstudent@nexus.dev,Hostel,300,Damage fine';
    await request(app).post('/dues/upload').set('Authorization', `Bearer ${lib.body.token}`)
      .attach('file', Buffer.from(csv), { filename: 'dues.csv', contentType: 'text/csv' });
    const dues = await request(app).get('/dues/mine').set('Authorization', `Bearer ${studentToken}`);
    dueId = dues.body.find(d => d.status === 'unpaid')?.id;
  });

  test('POST /payments/initiate returns a session', async () => {
    expect(dueId).toBeDefined();
    const res = await request(app)
      .post('/payments/initiate')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ due_id: dueId });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('session_id');
    sessionId = res.body.session_id;
  });

  test('POST /payments/confirm returns success or simulated decline', async () => {
    const res = await request(app)
      .post('/payments/confirm')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ session_id: sessionId, card_last4: '4242' });
    expect([200, 402]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body).toHaveProperty('transaction_ref');
    }
  });

  test('GET /payments/receipts returns payment history', async () => {
    const res = await request(app)
      .get('/payments/receipts')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /payments/confirm with expired/invalid session returns 400', async () => {
    const res = await request(app)
      .post('/payments/confirm')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ session_id: 'fake-session-id', card_last4: '1234' });
    expect(res.status).toBe(400);
  });
});
