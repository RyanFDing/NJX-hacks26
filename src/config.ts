import dotenv from 'dotenv';

// Only load .env in non-test environments
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

export interface Config {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  recipientPhoneNumber: string;
  emergencyContactPhone: string;
  openaiApiKey: string;
  anthropicApiKey: string;
  recipientName: string;
  whitelistNumbers: string[];
  port: number;
}

const REQUIRED_VARS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'RECIPIENT_PHONE_NUMBER',
  'EMERGENCY_CONTACT_PHONE',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'RECIPIENT_NAME',
] as const;

export function loadConfig(): Config {
  for (const varName of REQUIRED_VARS) {
    if (!process.env[varName]) {
      throw new Error(`Missing required environment variable: ${varName}`);
    }
  }

  const whitelistRaw = process.env.WHITELIST_NUMBERS?.trim();

  return {
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER!,
    recipientPhoneNumber: process.env.RECIPIENT_PHONE_NUMBER!,
    emergencyContactPhone: process.env.EMERGENCY_CONTACT_PHONE!,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    recipientName: process.env.RECIPIENT_NAME!,
    whitelistNumbers: whitelistRaw ? whitelistRaw.split(',').map(n => n.trim()) : [],
    port: parseInt(process.env.PORT || '3000', 10),
  };
}
