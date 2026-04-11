import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, logCall, getCallHistory, getCallById, addToWhitelist, checkWhitelist } from '../src/db.js';
import type { CallRecord, WhitelistEntry } from '../src/types.js';
import Database from 'better-sqlite3';

describe('database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDb(db);
  });

  const makeCall = (overrides: Partial<CallRecord> = {}): CallRecord => ({
    id: 'call-001',
    caller_number: '+15551234567',
    caller_name: 'John Doe',
    stated_relationship: 'friend',
    stated_purpose: 'catching up',
    knew_recipient_name: true,
    confidence_score: 0.9,
    risk_reasoning: 'Known contact, reasonable purpose',
    outcome: 'forwarded',
    transcript: JSON.stringify([{ role: 'caller', text: 'Hi', timestamp: '2024-01-01T00:00:00Z' }]),
    created_at: '2024-01-01T12:00:00',
    ...overrides,
  });

  describe('initDb', () => {
    it('creates calls and whitelist tables', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const names = tables.map(t => t.name);
      expect(names).toContain('calls');
      expect(names).toContain('whitelist');
    });
  });

  describe('logCall / getCallById', () => {
    it('logs a call and retrieves it by ID', () => {
      const call = makeCall();
      logCall(db, call);
      const retrieved = getCallById(db, 'call-001');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('call-001');
      expect(retrieved!.caller_number).toBe('+15551234567');
      expect(retrieved!.caller_name).toBe('John Doe');
      expect(retrieved!.outcome).toBe('forwarded');
      expect(retrieved!.confidence_score).toBe(0.9);
    });

    it('returns null for unknown call ID', () => {
      const result = getCallById(db, 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getCallHistory', () => {
    it('returns calls in reverse chronological order', () => {
      logCall(db, makeCall({ id: 'call-001', created_at: '2024-01-01T10:00:00' }));
      logCall(db, makeCall({ id: 'call-002', created_at: '2024-01-01T11:00:00' }));
      logCall(db, makeCall({ id: 'call-003', created_at: '2024-01-01T12:00:00' }));

      const history = getCallHistory(db);
      expect(history).toHaveLength(3);
      expect(history[0].id).toBe('call-003');
      expect(history[1].id).toBe('call-002');
      expect(history[2].id).toBe('call-001');
    });

    it('respects the limit parameter', () => {
      logCall(db, makeCall({ id: 'call-001', created_at: '2024-01-01T10:00:00' }));
      logCall(db, makeCall({ id: 'call-002', created_at: '2024-01-01T11:00:00' }));
      logCall(db, makeCall({ id: 'call-003', created_at: '2024-01-01T12:00:00' }));

      const history = getCallHistory(db, 2);
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('call-003');
    });

    it('returns empty array when no calls exist', () => {
      const history = getCallHistory(db);
      expect(history).toEqual([]);
    });
  });

  describe('whitelist', () => {
    const makeEntry = (overrides: Partial<WhitelistEntry> = {}): WhitelistEntry => ({
      id: 'wl-001',
      phone_number: '+15559999999',
      name: 'Jane Smith',
      relationship: 'daughter',
      ...overrides,
    });

    it('adds a whitelist entry and checks it', () => {
      addToWhitelist(db, makeEntry());
      const found = checkWhitelist(db, '+15559999999');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Jane Smith');
      expect(found!.relationship).toBe('daughter');
    });

    it('returns null for unknown numbers', () => {
      const found = checkWhitelist(db, '+15550000000');
      expect(found).toBeNull();
    });

    it('handles duplicate phone numbers gracefully', () => {
      addToWhitelist(db, makeEntry());
      // Second insert with same number should update or be ignored
      expect(() => {
        addToWhitelist(db, makeEntry({ id: 'wl-002', name: 'Updated Name' }));
      }).not.toThrow();
    });
  });
});
