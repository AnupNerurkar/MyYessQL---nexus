const request = require('supertest');
const app = require('../index');

describe('Phase 1 — Auth', () => {
  let studentToken;

  test('POST /auth/register creates a new user', async () => {
    const res = await request(app).post('/auth/register').send({
      name: 'Test User',
      email: 'test_' + Date.now() + '@nexus.dev',
      password: 'pass1234',
      role: 'student'
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.role).toBe('student');
  });

  test('POST /auth/register rejects invalid role', async () => {
    const res = await request(app).post('/auth/register').send({
      name: 'Bad Role',
      email: 'bad@nexus.dev',
      password: 'pass1234',
      role: 'superadmin'
    });
    expect(res.status).toBe(400);
  });

  test('POST /auth/login returns JWT for valid credentials', async () => {
    const res = await request(app).post('/auth/login').send({
      email: 'student@nexus.dev',
      password: 'test1234'
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    studentToken = res.body.token;
  });

  test('POST /auth/login rejects wrong password', async () => {
    const res = await request(app).post('/auth/login').send({
      email: 'student@nexus.dev',
      password: 'wrongpass'
    });
    expect(res.status).toBe(401);
  });

  test('Protected route rejects request without token', async () => {
    const res = await request(app).get('/clearance/mine');
    expect(res.status).toBe(401);
  });
});
