import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, addToWhitelist, getCallById, checkWhitelist } from '../src/db.js';
import { handleIncomingCall, handleCallStatus } from '../src/twilio.js';
import type { CallRecord } from '../src/types.js';

// Minimal mock for Express req/res
function mockReq(body: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return {
    body,
    headers,
    protocol: 'https',
    get(name: string) { return headers[name.toLowerCase()] ?? ''; },
    originalUrl: '/voice/incoming',
  } as any;
}

function mockRes() {
  let statusCode = 200;
  let body = '';
  const headerMap: Record<string, string> = {};
  return {
    status(code: number) { statusCode = code; return this; },
    set(key: string, val: string) { headerMap[key] = val; return this; },
    type(t: string) { headerMap['content-type'] = t; return this; },
    send(data: string) { body = data; return this; },
    end() { return this; },
    getStatus: () => statusCode,
    getBody: () => body,
    getHeaders: () => headerMap,
  } as any;
}

describe('twilio webhook handlers', () => {
  let db: Database.Database;

  const config = {
    twilioAccountSid: 'AC_test',
    twilioAuthToken: 'test_token',
    twilioPhoneNumber: '+15550001111',
    recipientPhoneNumber: '+15559876543',
    emergencyContactPhone: '+15551112222',
    openaiApiKey: 'sk-test',
    anthropicApiKey: 'sk-ant-test',
    recipientName: 'Margaret',
    whitelistNumbers: [] as string[],
    port: 3000,
  };

  beforeEach(() => {
    db = new Database(':memory:');
    initDb(db);
  });

  describe('handleIncomingCall', () => {
    it('forwards whitelisted caller with <Dial>', () => {
      addToWhitelist(db, {
        id: 'wl-1',
        phone_number: '+15559999999',
        name: 'Jane',
        relationship: 'daughter',
      });

      const req = mockReq({ From: '+15559999999', CallSid: 'CA_test_123' });
      const res = mockRes();

      handleIncomingCall(req, res, db, config);

      const body = res.getBody();
      expect(body).toContain('<Dial');
      expect(body).toContain(config.recipientPhoneNumber);
    });

    it('screens unknown caller with <Say> greeting and <Connect><Stream>', () => {
      const req = mockReq({
        From: '+15551234567',
        CallSid: 'CA_test_456',
      }, {
        host: 'abc123.ngrok.io',
      });
      const res = mockRes();

      handleIncomingCall(req, res, db, config);

      const body = res.getBody();
      expect(body).toContain('<Say');
      expect(body).toContain('<Connect');
      expect(body).toContain('<Stream');
    });

    it('greeting uses the correct recipient name phrasing without revealing the name', () => {
      const req = mockReq({
        From: '+15551234567',
        CallSid: 'CA_test_789',
      }, {
        host: 'abc123.ngrok.io',
      });
      const res = mockRes();

      handleIncomingCall(req, res, db, config);

      const body = res.getBody();
      // Should NOT contain the actual recipient name in the TwiML greeting
      expect(body).not.toContain('Margaret');
      // Should contain a generic greeting
      expect(body).toContain('<Say');
    });

    it('logs whitelisted call with outcome "whitelisted"', () => {
      addToWhitelist(db, {
        id: 'wl-1',
        phone_number: '+15559999999',
        name: 'Jane',
        relationship: 'daughter',
      });

      const req = mockReq({ From: '+15559999999', CallSid: 'CA_wl_log' });
      const res = mockRes();

      handleIncomingCall(req, res, db, config);

      const call = getCallById(db, 'CA_wl_log');
      expect(call).not.toBeNull();
      expect(call!.outcome).toBe('whitelisted');
      expect(call!.caller_number).toBe('+15559999999');
    });

    it('sets Content-Type to text/xml', () => {
      const req = mockReq({ From: '+15551234567', CallSid: 'CA_ct' }, { host: 'test.ngrok.io' });
      const res = mockRes();

      handleIncomingCall(req, res, db, config);

      expect(res.getHeaders()['content-type']).toContain('xml');
    });
  });

  describe('handleCallStatus', () => {
    it('returns 200 for status callbacks', () => {
      const req = mockReq({ CallSid: 'CA_status', CallStatus: 'completed' });
      const res = mockRes();

      handleCallStatus(req, res);

      expect(res.getStatus()).toBe(200);
    });
  });
});
