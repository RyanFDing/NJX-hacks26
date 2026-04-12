import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendAlert } from '../src/alerts.js';
import type { CallRecord } from '../src/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

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

const baseConfig = { ntfyTopic: 'guardline-test', recipientName: 'Margaret' };

describe('alerts', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends ntfy notification when a call is blocked', async () => {
    const record = makeCallRecord({ outcome: 'blocked', confidence_score: 0.1 });
    await sendAlert(record, baseConfig);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('ntfy.sh/guardline-test');
    expect(opts.headers['Title']).toContain('BLOCKED');
    expect(opts.headers['Priority']).toBe('urgent');
    expect(opts.body).toContain('+15551234567');
  });

  it('sends ntfy notification when a call is held for review', async () => {
    const record = makeCallRecord({ outcome: 'held', confidence_score: 0.5 });
    await sendAlert(record, baseConfig);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Title']).toContain('Suspicious');
    expect(opts.headers['Title']).toContain('Margaret');
    expect(opts.headers['Priority']).toBe('high');
  });

  it('sends a low-priority ntfy notification for cleared (forwarded) calls', async () => {
    const record = makeCallRecord({ outcome: 'forwarded', confidence_score: 0.95 });
    await sendAlert(record, baseConfig);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Title']).toContain('Cleared');
    expect(opts.headers['Priority']).toBe('default');
  });

  it('does NOT send notification for whitelisted calls', async () => {
    const record = makeCallRecord({ outcome: 'whitelisted', confidence_score: 1.0 });
    await sendAlert(record, baseConfig);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('includes risk reasoning in body', async () => {
    const record = makeCallRecord({ outcome: 'blocked', risk_reasoning: 'Caller impersonated IRS agent.' });
    await sendAlert(record, baseConfig);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain('Caller impersonated IRS agent.');
  });

  it('includes confidence score in body', async () => {
    const record = makeCallRecord({ outcome: 'blocked', confidence_score: 0.15 });
    await sendAlert(record, baseConfig);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toContain('15%');
  });

  it('includes recipient name in title', async () => {
    const record = makeCallRecord({ outcome: 'held' });
    await sendAlert(record, baseConfig);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Title']).toContain('Margaret');
  });

  it('does not throw on fetch failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const record = makeCallRecord({ outcome: 'blocked' });
    await expect(sendAlert(record, baseConfig)).resolves.not.toThrow();
  });
});
