import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screenCall, buildScreeningPrompt } from '../src/screener.js';
import type { TranscriptEntry, ScreeningDecision } from '../src/types.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: class {
      messages = { create: mockCreate };
    },
    __mockCreate: mockCreate,
  };
});

async function getMockCreate() {
  const mod = await import('@anthropic-ai/sdk') as any;
  return mod.__mockCreate as ReturnType<typeof vi.fn>;
}

function makeTranscript(exchanges: [string, string][]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const [receptionist, caller] of exchanges) {
    entries.push({ role: 'receptionist', text: receptionist, timestamp: new Date().toISOString() });
    entries.push({ role: 'caller', text: caller, timestamp: new Date().toISOString() });
  }
  return entries;
}

function mockClaudeResponse(decision: ScreeningDecision) {
  return {
    content: [{ type: 'text', text: JSON.stringify(decision) }],
  };
}

describe('screener', () => {
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
  });

  it('rejects when caller does not know recipient name', async () => {
    const decision: ScreeningDecision = {
      action: 'reject',
      confidence: 0.1,
      reasoning: 'Caller could not name the person they are trying to reach.',
      red_flags: ['Failed identity verification'],
      iteration: 1,
    };
    mockCreate.mockResolvedValueOnce(mockClaudeResponse(decision));

    const transcript = makeTranscript([
      ["Hi, you've reached this number. Who are you trying to reach?", "Uh, I'm not sure of the name."],
    ]);

    const result = await screenCall(transcript, '+15551234567', 'test-key', 'Margaret', 1);
    expect(result.action).toBe('reject');
    expect(result.confidence).toBeLessThan(0.25);
    expect(result.red_flags).toContain('Failed identity verification');
  });

  it('rejects IRS scam with government impersonation flag', async () => {
    const decision: ScreeningDecision = {
      action: 'reject',
      confidence: 0.05,
      reasoning: 'Caller is impersonating the IRS and making threats of arrest. Classic government impersonation scam.',
      red_flags: ['Government impersonation', 'Threats of arrest', 'Urgency tactics'],
      iteration: 1,
    };
    mockCreate.mockResolvedValueOnce(mockClaudeResponse(decision));

    const transcript = makeTranscript([
      ["Hi, you've reached this number. Who are you trying to reach?", "Margaret"],
      ["And who am I speaking with?", "Agent Williams from the IRS"],
      ["How do you know Margaret?", "This is official IRS business"],
      ["What is this call regarding?", "Margaret owes back taxes and there is a warrant for her arrest unless she pays immediately"],
    ]);

    const result = await screenCall(transcript, '+15551234567', 'test-key', 'Margaret', 1);
    expect(result.action).toBe('reject');
    expect(result.confidence).toBeLessThan(0.25);
    expect(result.red_flags).toEqual(expect.arrayContaining(['Government impersonation']));
  });

  it('approves legitimate caller with high confidence', async () => {
    const decision: ScreeningDecision = {
      action: 'approve',
      confidence: 0.92,
      reasoning: 'Caller correctly named recipient, identified as doctor with specific appointment details.',
      red_flags: [],
      iteration: 1,
    };
    mockCreate.mockResolvedValueOnce(mockClaudeResponse(decision));

    const transcript = makeTranscript([
      ["Hi, you've reached this number. Who are you trying to reach?", "Margaret"],
      ["And who am I speaking with?", "Dr. Sarah Chen from Riverside Medical"],
      ["How do you know Margaret?", "She's my patient"],
      ["What is this call regarding?", "I'm calling about her appointment next Tuesday to go over her lab results"],
    ]);

    const result = await screenCall(transcript, '+15551234567', 'test-key', 'Margaret', 1);
    expect(result.action).toBe('approve');
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('returns ask_followup with a next_question for ambiguous calls', async () => {
    const decision: ScreeningDecision = {
      action: 'ask_followup',
      next_question: 'Can you tell me which doctor Margaret sees at your practice?',
      confidence: 0.5,
      reasoning: 'Caller claims to be from a medical office but provided vague details.',
      red_flags: ['Vague details'],
      iteration: 1,
    };
    mockCreate.mockResolvedValueOnce(mockClaudeResponse(decision));

    const transcript = makeTranscript([
      ["Hi, you've reached this number. Who are you trying to reach?", "Margaret"],
      ["And who am I speaking with?", "This is the medical office"],
      ["How do you know Margaret?", "She's a patient here"],
      ["What is this call regarding?", "We need to discuss something with her"],
    ]);

    const result = await screenCall(transcript, '+15551234567', 'test-key', 'Margaret', 1);
    expect(result.action).toBe('ask_followup');
    expect(result.next_question).toBeDefined();
    expect(result.next_question!.length).toBeGreaterThan(0);
  });

  it('defaults to hold_for_review on malformed API response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'This is not valid JSON at all' }],
    });

    const transcript = makeTranscript([
      ["Hi, who are you trying to reach?", "Margaret"],
    ]);

    const result = await screenCall(transcript, '+15551234567', 'test-key', 'Margaret', 1);
    expect(result.action).toBe('hold_for_review');
  });

  it('defaults to hold_for_review on API failure after retry', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API error'));
    mockCreate.mockRejectedValueOnce(new Error('API error again'));

    const transcript = makeTranscript([
      ["Hi, who are you trying to reach?", "Margaret"],
    ]);

    const result = await screenCall(transcript, '+15551234567', 'test-key', 'Margaret', 1);
    expect(result.action).toBe('hold_for_review');
    expect(mockCreate).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('passes correct iteration number', async () => {
    const decision: ScreeningDecision = {
      action: 'hold_for_review',
      confidence: 0.5,
      reasoning: 'Uncertain after multiple rounds.',
      red_flags: [],
      iteration: 3,
    };
    mockCreate.mockResolvedValueOnce(mockClaudeResponse(decision));

    const transcript = makeTranscript([
      ["Who are you trying to reach?", "Margaret"],
    ]);

    const result = await screenCall(transcript, '+15551234567', 'test-key', 'Margaret', 3);
    expect(result.iteration).toBe(3);
  });
});

describe('buildScreeningPrompt', () => {
  it('includes recipient name', () => {
    const prompt = buildScreeningPrompt('Margaret', []);
    expect(prompt).toContain('Margaret');
  });

  it('includes scam pattern categories', () => {
    const prompt = buildScreeningPrompt('Margaret', []);
    expect(prompt).toContain('Government impersonation');
    expect(prompt).toContain('Grandparent scam');
    expect(prompt).toContain('Tech support');
  });

  it('includes the JSON response format', () => {
    const prompt = buildScreeningPrompt('Margaret', []);
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"confidence"');
    expect(prompt).toContain('"red_flags"');
  });

  it('includes security context facts when provided', () => {
    const prompt = buildScreeningPrompt('Margaret', ['My doctor is Dr. Smith', 'My daughter is Sarah']);
    expect(prompt).toContain('Dr. Smith');
    expect(prompt).toContain('Sarah');
    expect(prompt).toContain('VERIFIED FACTS');
  });

  it('omits security context section when no facts provided', () => {
    const prompt = buildScreeningPrompt('Margaret', []);
    expect(prompt).not.toContain('VERIFIED FACTS');
  });
});
