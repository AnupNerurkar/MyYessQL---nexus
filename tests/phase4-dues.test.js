const request = require('supertest');
const app = require('../index');
const db = require('../db');

describe('Phase 4 — Dues CSV', () => {
  let libToken, studentToken;

  beforeAll(async () => {
    // Clear dues for clean test
    db.prepare('DELETE FROM dues').run();

    const lib = await request(app).post('/auth/login').send({ email: 'lib@nexus.dev', password: 'test1234' });
    libToken = lib.body.token;
    const stu = await request(app).post('/auth/login').send({ email: 'student@nexus.dev', password: 'test1234' });
    studentToken = stu.body.token;
  });

  test('POST /dues/upload parses CSV and inserts dues', async () => {
    const csv = 'student_email,department,amount,description\nstudent@nexus.dev,Library,200,Overdue fine';
    const res = await request(app)
      .post('/dues/upload')
      .set('Authorization', `Bearer ${libToken}`)
      .attach('file', Buffer.from(csv), { filename: 'dues.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.inserted + res.body.updated).toBeGreaterThan(0);
  });

  test('POST /dues/upload skips unknown student emails', async () => {
    const csv = 'student_email,department,amount,description\nnobody@unknown.dev,Library,100,Fine';
    const res = await request(app)
      .post('/dues/upload')
      .set('Authorization', `Bearer ${libToken}`)
      .attach('file', Buffer.from(csv), { filename: 'dues.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
  });

  test('GET /dues/mine returns dues for logged-in student', async () => {
    const res = await request(app)
      .get('/dues/mine')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('GET /clearance/mine includes blocked flag', async () => {
    // Ensure student has a clearance request
    await request(app).post('/clearance/submit').set('Authorization', `Bearer ${studentToken}`);
    
    const res = await request(app)
      .get('/clearance/mine')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('blocked');
    expect(res.body.blocked).toBe(true);
  });

  test('PATCH /dues/:id/mark-paid clears the due', async () => {
    const dues = await request(app).get('/dues/mine').set('Authorization', `Bearer ${studentToken}`);
    const dueId = dues.body[0].id;
    const res = await request(app)
      .patch(`/dues/${dueId}/mark-paid`)
      .set('Authorization', `Bearer ${libToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
  });
});
