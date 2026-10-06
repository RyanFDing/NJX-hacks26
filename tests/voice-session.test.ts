import { describe, it, expect } from 'vitest';
import { VoiceSession, buildSystemPrompt } from '../src/voice-session.js';

describe('VoiceSession', () => {
  const callConfig = {
    callSid: 'CA_test_001',
    callerNumber: '+15551234567',
    recipientName: 'Margaret',
    streamSid: 'MZ_test_001',
  };

  it('initializes with screening state', () => {
    const session = new VoiceSession(callConfig);
    expect(session.state).toBe('screening');
    expect(session.callSid).toBe('CA_test_001');
    expect(session.callerNumber).toBe('+15551234567');
  });

  it('starts with empty transcript', () => {
    const session = new VoiceSession(callConfig);
    expect(session.transcript).toEqual([]);
  });

  it('accumulates transcript entries with correct structure', () => {
    const session = new VoiceSession(callConfig);
    session.addTranscriptEntry('receptionist', 'Hi, who are you trying to reach?');
    session.addTranscriptEntry('caller', 'I am looking for Margaret.');

    expect(session.transcript).toHaveLength(2);
    expect(session.transcript[0].role).toBe('receptionist');
    expect(session.transcript[0].text).toBe('Hi, who are you trying to reach?');
    expect(session.transcript[0].timestamp).toBeDefined();
    expect(session.transcript[1].role).toBe('caller');
    expect(session.transcript[1].text).toBe('I am looking for Margaret.');
  });

  it('transitions state correctly', () => {
    const session = new VoiceSession(callConfig);
    expect(session.state).toBe('screening');

    session.setState('analyzing');
    expect(session.state).toBe('analyzing');

    session.setState('follow_up');
    expect(session.state).toBe('follow_up');

    session.setState('completed');
    expect(session.state).toBe('completed');
  });

  it('tracks screening iteration count', () => {
    const session = new VoiceSession(callConfig);
    expect(session.screeningIteration).toBe(0);

    session.incrementIteration();
    expect(session.screeningIteration).toBe(1);

    session.incrementIteration();
    expect(session.screeningIteration).toBe(2);
  });

  it('detects max iterations reached', () => {
    const session = new VoiceSession(callConfig);
    for (let i = 0; i < 5; i++) {
      expect(session.maxIterationsReached()).toBe(false);
      session.incrementIteration();
    }
    expect(session.maxIterationsReached()).toBe(true);
  });
});

describe('buildSystemPrompt', () => {
  it('includes recipient name instruction without revealing it', () => {
    const prompt = buildSystemPrompt('Margaret');
    // Prompt should instruct AI to never reveal the name
    expect(prompt).toContain('NEVER reveal');
    // Prompt should reference the name for internal use
    expect(prompt).toContain('Margaret');
  });

  it('includes the screening flow steps', () => {
    const prompt = buildSystemPrompt('Margaret');
    expect(prompt).toContain('Who were you trying to reach today?');
    expect(prompt).toContain('who am I speaking with?');
    expect(prompt).toContain('You do NOT decide whether to connect the call');
    expect(prompt).toContain("What's this call about today?");
  });

  it('instructs short responses', () => {
    const prompt = buildSystemPrompt('Robert');
    expect(prompt).toContain('1 to 2 sentences maximum');
  });
});
