export interface CallRecord {
  id: string;
  caller_number: string;
  caller_name: string | null;
  stated_relationship: string | null;
  stated_purpose: string | null;
  knew_recipient_name: boolean | null;
  confidence_score: number | null;
  risk_reasoning: string | null;
  outcome: 'forwarded' | 'blocked' | 'held' | 'whitelisted';
  transcript: string | null;
  created_at: string;
}

export interface WhitelistEntry {
  id: string;
  phone_number: string;
  name: string;
  relationship: string | null;
}

export interface TranscriptEntry {
  role: 'caller' | 'receptionist';
  text: string;
  timestamp: string;
}

export interface ScreeningDecision {
  action: 'ask_followup' | 'approve' | 'reject' | 'hold_for_review';
  next_question?: string;
  confidence: number;
  reasoning: string;
  red_flags: string[];
  iteration: number;
}
