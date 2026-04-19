const request = require('supertest');
const app = require('../index');
const path = require('path');

describe('Phase 2 — Student submission', () => {
  let token, requestId;

  beforeAll(async () => {
    const res = await request(app).post('/auth/login').send({
      email: 'student@nexus.dev', password: 'test1234'
    });
    token = res.body.token;
  });

  test('POST /clearance/submit creates a request', async () => {
    const res = await request(app)
      .post('/clearance/submit')
      .set('Authorization', `Bearer ${token}`);
    expect([201, 409]).toContain(res.status);
    if (res.status === 201) {
      expect(res.body).toHaveProperty('id');
      requestId = res.body.id;
    }
  });

  test('POST /clearance/submit returns 409 if request already exists', async () => {
    const res = await request(app)
      .post('/clearance/submit')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  test('GET /clearance/mine returns request with stages', async () => {
    const res = await request(app)
      .get('/clearance/mine')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stages');
    expect(res.body.stages).toHaveLength(3);
  });

  test('GET /clearance/status/:id returns heatmap data', async () => {
    const mine = await request(app)
      .get('/clearance/mine')
      .set('Authorization', `Bearer ${token}`);
    const id = mine.body.id;
    const res = await request(app)
      .get(`/clearance/status/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.stages[0]).toHaveProperty('stage', 'lab_incharge');
    expect(['pending','approved','flagged']).toContain(res.body.stages[0].status);
  });
});
