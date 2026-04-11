import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.TWILIO_ACCOUNT_SID = 'AC_test_sid';
    process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
    process.env.TWILIO_PHONE_NUMBER = '+15551234567';
    process.env.RECIPIENT_PHONE_NUMBER = '+15559876543';
    process.env.EMERGENCY_CONTACT_PHONE = '+15551112222';
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.RECIPIENT_NAME = 'Margaret';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads all required env vars when present', async () => {
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.twilioAccountSid).toBe('AC_test_sid');
    expect(config.twilioAuthToken).toBe('test_auth_token');
    expect(config.twilioPhoneNumber).toBe('+15551234567');
    expect(config.recipientPhoneNumber).toBe('+15559876543');
    expect(config.emergencyContactPhone).toBe('+15551112222');
    expect(config.openaiApiKey).toBe('sk-test-openai');
    expect(config.anthropicApiKey).toBe('sk-ant-test');
    expect(config.recipientName).toBe('Margaret');
  });

  it('defaults PORT to 3000', async () => {
    delete process.env.PORT;
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.port).toBe(3000);
  });

  it('uses PORT from env when set', async () => {
    process.env.PORT = '4000';
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.port).toBe(4000);
  });

  it('throws when a required env var is missing', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('TWILIO_ACCOUNT_SID');
  });

  it('throws when RECIPIENT_NAME is missing', async () => {
    delete process.env.RECIPIENT_NAME;
    const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('RECIPIENT_NAME');
  });

  it('parses WHITELIST_NUMBERS as comma-separated list', async () => {
    process.env.WHITELIST_NUMBERS = '+15551111111,+15552222222,+15553333333';
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.whitelistNumbers).toEqual(['+15551111111', '+15552222222', '+15553333333']);
  });

  it('returns empty array when WHITELIST_NUMBERS is not set', async () => {
    delete process.env.WHITELIST_NUMBERS;
    const { loadConfig } = await import('../src/config.js');
    const config = loadConfig();
    expect(config.whitelistNumbers).toEqual([]);
  });
});
