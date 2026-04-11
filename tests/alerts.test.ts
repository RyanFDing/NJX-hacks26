import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendAlert, formatAlertMessage } from '../src/alerts.js';
import type { CallRecord } from '../src/types.js';

// Mock the Twilio SDK
const mockCreate = vi.fn();
vi.mock('twilio', () => {
  return {
    default: () => ({
      messages: { create: mockCreate },
    }),
  };
});

function makeCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'CA-test-123',
    caller_number: '+15551234567',
    caller_name: 'Agent Williams',
    stated_relationship: 'IRS',
    stated_purpose: 'Back taxes',
    knew_recipient_name: true,
    confidence_score: 0.1,
    risk_reasoning: 'Government impersonation scam — caller claimed to be from IRS with threats of arrest.',
    outcome: 'blocked',
    transcript: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('alerts', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ sid: 'SM-mock-sid' });
  });

  it('sends SMS when a call is blocked', async () => {
    const record = makeCallRecord({ outcome: 'blocked', confidence_score: 0.1 });

    await sendAlert(record, {
      twilioAccountSid: 'AC-test',
      twilioAuthToken: 'auth-test',
      twilioPhoneNumber: '+15550001111',
      emergencyContactPhone: '+15559998888',
      recipientName: 'Margaret',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.to).toBe('+15559998888');
    expect(callArgs.from).toBe('+15550001111');
    expect(callArgs.body).toContain('BLOCKED');
    expect(callArgs.body).toContain('+15551234567');
  });

  it('sends SMS when a call is held for review', async () => {
    const record = makeCallRecord({
      outcome: 'held',
      confidence_score: 0.5,
      risk_reasoning: 'Uncertain caller — held for manual review.',
    });

    await sendAlert(record, {
      twilioAccountSid: 'AC-test',
      twilioAuthToken: 'auth-test',
      twilioPhoneNumber: '+15550001111',
      emergencyContactPhone: '+15559998888',
      recipientName: 'Margaret',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.body).toContain('HELD FOR REVIEW');
  });

  it('does NOT send SMS for approved calls', async () => {
    const record = makeCallRecord({ outcome: 'forwarded', confidence_score: 0.95 });

    await sendAlert(record, {
      twilioAccountSid: 'AC-test',
      twilioAuthToken: 'auth-test',
      twilioPhoneNumber: '+15550001111',
      emergencyContactPhone: '+15559998888',
      recipientName: 'Margaret',
    });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does NOT send SMS for whitelisted calls', async () => {
    const record = makeCallRecord({ outcome: 'whitelisted', confidence_score: 1.0 });

    await sendAlert(record, {
      twilioAccountSid: 'AC-test',
      twilioAuthToken: 'auth-test',
      twilioPhoneNumber: '+15550001111',
      emergencyContactPhone: '+15559998888',
      recipientName: 'Margaret',
    });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('includes risk reasoning in SMS body', async () => {
    const record = makeCallRecord({
      outcome: 'blocked',
      risk_reasoning: 'Caller impersonated IRS agent with threats.',
    });

    await sendAlert(record, {
      twilioAccountSid: 'AC-test',
      twilioAuthToken: 'auth-test',
      twilioPhoneNumber: '+15550001111',
      emergencyContactPhone: '+15559998888',
      recipientName: 'Margaret',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.body).toContain('Caller impersonated IRS agent with threats.');
  });

  it('includes confidence score in SMS body', async () => {
    const record = makeCallRecord({ outcome: 'blocked', confidence_score: 0.15 });

    await sendAlert(record, {
      twilioAccountSid: 'AC-test',
      twilioAuthToken: 'auth-test',
      twilioPhoneNumber: '+15550001111',
      emergencyContactPhone: '+15559998888',
      recipientName: 'Margaret',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.body).toContain('15%');
  });

  it('does not throw on Twilio API failure', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Twilio API down'));
    const record = makeCallRecord({ outcome: 'blocked' });

    // Should not throw
    await expect(
      sendAlert(record, {
        twilioAccountSid: 'AC-test',
        twilioAuthToken: 'auth-test',
        twilioPhoneNumber: '+15550001111',
        emergencyContactPhone: '+15559998888',
        recipientName: 'Margaret',
      })
    ).resolves.not.toThrow();
  });

  it('includes recipient name in SMS body', async () => {
    const record = makeCallRecord({ outcome: 'held' });

    await sendAlert(record, {
      twilioAccountSid: 'AC-test',
      twilioAuthToken: 'auth-test',
      twilioPhoneNumber: '+15550001111',
      emergencyContactPhone: '+15559998888',
      recipientName: 'Margaret',
    });

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.body).toContain('Margaret');
  });
});

describe('formatAlertMessage', () => {
  it('formats blocked call message correctly', () => {
    const record = makeCallRecord({
      outcome: 'blocked',
      caller_number: '+15551234567',
      confidence_score: 0.1,
      risk_reasoning: 'IRS impersonation scam detected.',
    });

    const msg = formatAlertMessage(record, 'Margaret');
    expect(msg).toContain('BLOCKED');
    expect(msg).toContain('+15551234567');
    expect(msg).toContain('10%');
    expect(msg).toContain('IRS impersonation scam detected.');
    expect(msg).toContain('Margaret');
  });

  it('formats held call message correctly', () => {
    const record = makeCallRecord({
      outcome: 'held',
      confidence_score: 0.5,
      risk_reasoning: 'Uncertain — needs human review.',
    });

    const msg = formatAlertMessage(record, 'Margaret');
    expect(msg).toContain('HELD FOR REVIEW');
    expect(msg).toContain('50%');
  });

  it('handles null confidence score', () => {
    const record = makeCallRecord({
      outcome: 'blocked',
      confidence_score: null,
    });

    const msg = formatAlertMessage(record, 'Margaret');
    expect(msg).toContain('N/A');
  });
});
