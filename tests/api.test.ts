import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initDb, logCall, addToWhitelist } from '../src/db.js';
import { createApp } from '../src/index.js';
import type { CallRecord } from '../src/types.js';

function makeConfig() {
  return {
    twilioAccountSid: 'AC-test',
    twilioAuthToken: 'auth-test',
    twilioPhoneNumber: '+15550001111',
    recipientPhoneNumber: '+15559990000',
    recipientName: 'Margaret',
    emergencyContactPhone: '+15559998888',
    openaiApiKey: 'sk-test',
    anthropicApiKey: 'ant-test',
    whitelistNumbers: [],
    port: 3000,
  };
}

function seedCall(db: Database.Database, overrides: Partial<CallRecord> & { id: string }): void {
  const record: CallRecord = {
    caller_number: '+15551234567',
    caller_name: null,
    stated_relationship: null,
    stated_purpose: null,
    knew_recipient_name: null,
    confidence_score: null,
    risk_reasoning: null,
    outcome: 'forwarded',
    transcript: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  logCall(db, record);
}

describe('API routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new Database(':memory:');
    initDb(db);
    app = createApp(db, makeConfig());
  });

  afterEach(() => {
    db.close();
  });

  // --- GET /api/calls ---

  describe('GET /api/calls', () => {
    it('returns empty array when no calls exist', async () => {
      const res = await request(app).get('/api/calls');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns calls in newest-first order', async () => {
      seedCall(db, { id: 'call-1', created_at: '2025-01-01T10:00:00Z', outcome: 'forwarded' });
      seedCall(db, { id: 'call-2', created_at: '2025-01-02T10:00:00Z', outcome: 'blocked' });
      seedCall(db, { id: 'call-3', created_at: '2025-01-03T10:00:00Z', outcome: 'held' });

      const res = await request(app).get('/api/calls');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect(res.body[0].id).toBe('call-3');
      expect(res.body[1].id).toBe('call-2');
      expect(res.body[2].id).toBe('call-1');
    });

    it('supports ?limit query parameter', async () => {
      seedCall(db, { id: 'call-1', created_at: '2025-01-01T10:00:00Z' });
      seedCall(db, { id: 'call-2', created_at: '2025-01-02T10:00:00Z' });
      seedCall(db, { id: 'call-3', created_at: '2025-01-03T10:00:00Z' });

      const res = await request(app).get('/api/calls?limit=2');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].id).toBe('call-3');
    });
  });

  // --- GET /api/calls/:id ---

  describe('GET /api/calls/:id', () => {
    it('returns a single call by ID', async () => {
      seedCall(db, {
        id: 'call-42',
        caller_number: '+15559876543',
        outcome: 'blocked',
        confidence_score: 0.1,
        risk_reasoning: 'IRS scam detected',
      });

      const res = await request(app).get('/api/calls/call-42');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('call-42');
      expect(res.body.caller_number).toBe('+15559876543');
      expect(res.body.outcome).toBe('blocked');
      expect(res.body.confidence_score).toBe(0.1);
    });

    it('returns 404 for non-existent call', async () => {
      const res = await request(app).get('/api/calls/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  // --- GET /api/stats ---

  describe('GET /api/stats', () => {
    it('returns zero counts when no calls exist', async () => {
      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        total: 0,
        forwarded: 0,
        blocked: 0,
        held: 0,
        whitelisted: 0,
      });
    });

    it('returns correct counts by outcome', async () => {
      seedCall(db, { id: 'c1', outcome: 'forwarded' });
      seedCall(db, { id: 'c2', outcome: 'blocked' });
      seedCall(db, { id: 'c3', outcome: 'blocked' });
      seedCall(db, { id: 'c4', outcome: 'held' });
      seedCall(db, { id: 'c5', outcome: 'whitelisted' });

      const res = await request(app).get('/api/stats');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(5);
      expect(res.body.forwarded).toBe(1);
      expect(res.body.blocked).toBe(2);
      expect(res.body.held).toBe(1);
      expect(res.body.whitelisted).toBe(1);
    });
  });

  // --- GET /api/whitelist ---

  describe('GET /api/whitelist', () => {
    it('returns empty array when no whitelist entries', async () => {
      const res = await request(app).get('/api/whitelist');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('returns all whitelist entries', async () => {
      addToWhitelist(db, { id: 'w1', phone_number: '+15551111111', name: 'Dr. Chen', relationship: 'doctor' });
      addToWhitelist(db, { id: 'w2', phone_number: '+15552222222', name: 'Son Bob', relationship: 'family' });

      const res = await request(app).get('/api/whitelist');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });
  });

  // --- POST /api/whitelist ---

  describe('POST /api/whitelist', () => {
    it('adds a new whitelist entry', async () => {
      const res = await request(app)
        .post('/api/whitelist')
        .send({ phone_number: '+15553333333', name: 'Nurse Amy', relationship: 'caregiver' });

      expect(res.status).toBe(201);
      expect(res.body.phone_number).toBe('+15553333333');
      expect(res.body.name).toBe('Nurse Amy');
      expect(res.body.id).toBeDefined();
    });

    it('returns 400 if phone_number is missing', async () => {
      const res = await request(app)
        .post('/api/whitelist')
        .send({ name: 'Nurse Amy' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 400 if name is missing', async () => {
      const res = await request(app)
        .post('/api/whitelist')
        .send({ phone_number: '+15553333333' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  // --- DELETE /api/whitelist/:id ---

  describe('DELETE /api/whitelist/:id', () => {
    it('deletes an existing whitelist entry', async () => {
      addToWhitelist(db, { id: 'w-del', phone_number: '+15554444444', name: 'Old Entry', relationship: null });

      const res = await request(app).delete('/api/whitelist/w-del');
      expect(res.status).toBe(200);

      // Verify it's gone
      const listRes = await request(app).get('/api/whitelist');
      expect(listRes.body).toHaveLength(0);
    });

    it('returns 404 for non-existent whitelist entry', async () => {
      const res = await request(app).delete('/api/whitelist/no-such-id');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });
});
