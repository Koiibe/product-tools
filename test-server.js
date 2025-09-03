// Simple test script to verify server functionality
const app = require('./server');

// Test the health endpoint
const request = require('supertest');

describe('Server Tests', () => {
  test('Health check endpoint should return OK', async () => {
    const response = await request(app)
      .get('/health')
      .expect(200);

    expect(response.body.status).toBe('OK');
    expect(response.body.message).toBe('Server is running');
  });

  test('Webhook endpoint should handle missing epic ID', async () => {
    const response = await request(app)
      .post('/webhook/notion')
      .send({})
      .expect(400);

    expect(response.body.error).toBe('No epic ID provided in webhook');
  });
});

// Note: This test file requires supertest for testing
// Run with: npm test (after installing supertest as dev dependency)
