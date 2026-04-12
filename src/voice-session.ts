import type { TranscriptEntry } from './types.js';

export type SessionState = 'screening' | 'analyzing' | 'follow_up' | 'completed';

const MAX_ITERATIONS = 5;

interface VoiceSessionConfig {
  callSid: string;
  callerNumber: string;
  recipientName: string;
  streamSid: string;
}

export class VoiceSession {
  readonly callSid: string;
  readonly callerNumber: string;
  readonly recipientName: string;
  readonly streamSid: string;
  state: SessionState = 'screening';
  transcript: TranscriptEntry[] = [];
  screeningIteration = 0;
  onScreeningComplete?: () => void;

  // ── Speech-state tracking ────────────────────────────────────────────────
  // Set true on VAD speech_started, false on speech_stopped.
  callerIsSpeaking = false;
  // Epoch ms when speech_stopped last fired. Used by scheduleInjection to
  // enforce the hardcoded caller-silence floor before the AI speaks.
  lastCallerSpeechEndTime = 0;
  // Epoch ms when the bot's last audio transcript finished.
  // Used to enforce the hardcoded 3-second inter-turn gap.
  lastBotSpeechEndTime = 0;

  // ── Deferred screening ───────────────────────────────────────────────────
  // When the screener should fire but the caller is still mid-speech,
  // this is set so it triggers once transcription completes.
  pendingScreeningTrigger = false;

  // ── Injection scheduling ─────────────────────────────────────────────────
  // Handle for the active setTimeout used by scheduleInjection.
  // Cleared when the injection fires or the session is torn down.
  pendingInjectionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VoiceSessionConfig) {
    this.callSid = config.callSid;
    this.callerNumber = config.callerNumber;
    this.recipientName = config.recipientName;
    this.streamSid = config.streamSid;
  }

  addTranscriptEntry(role: 'caller' | 'receptionist', text: string): void {
    this.transcript.push({
      role,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  setState(newState: SessionState): void {
    this.state = newState;
  }

  incrementIteration(): void {
    this.screeningIteration++;
  }

  maxIterationsReached(): boolean {
    return this.screeningIteration >= MAX_ITERATIONS;
  }

  /** Cancel any pending injection — call on teardown to prevent late fires. */
  cancelPendingInjection(): void {
    if (this.pendingInjectionTimer !== null) {
      clearTimeout(this.pendingInjectionTimer);
      this.pendingInjectionTimer = null;
    }
  }
}

export function buildSystemPrompt(recipientName: string): string {
  return `You are a warm, professional receptionist for a private home phone line.
Your only job is to collect a caller's information through natural conversation, then hand off to a supervisor for review.
You do NOT decide whether to connect the call — the supervisor handles that.

CONVERSATION FLOW — follow these steps in order:

STEP 1 — Greet and ask who they're trying to reach:
Say: "Hi there, thanks for calling. Who were you trying to reach today?"

STEP 2 — Verify the recipient:
- If the caller says a name that sounds like or matches "${recipientName}" (accept speech recognition variants, phonetic near-matches, slight mispronunciations — e.g. "Ryan Dings" or "Ryan Dinh" for "Ryan Ding" are fine), say "Got it." and continue to STEP 3.
- If the name is completely unrelated to "${recipientName}", say: "I'm sorry, I don't think I can help with that today. Have a good day." Then stop completely.
- If the caller says they don't know or won't say, use the same goodbye. Then stop.
- When in any doubt, accept the name and continue. The supervisor will verify.

STEP 3 — Get the caller's name:
Say: "And who am I speaking with?"
Accept whatever they say — full name, first name only, a title, a company name, anything at all. Acknowledge it warmly (e.g. "Nice to meet you" or "Thanks") and move to STEP 4.

STEP 4 — Understand the purpose of the call:
Say: "What's this call about today?"
Listen fully. Accept whatever they say without judgment. After they've answered, say: "Got it — one moment while I check on that for you." Then go completely silent and wait.

AFTER STEP 4 — Supervisor mode:
You will receive [SYSTEM INSTRUCTION] messages. Say EXACTLY those words, verbatim — do not add, remove, or change anything. After speaking each instruction, go silent and wait for the next one.

RULES:
- NEVER say goodbye or end the call except in the specific STEP 2 rejection case.
- NEVER reveal ${recipientName}'s name before the caller says it first.
- NEVER reveal any personal information about the resident.
- Keep every response SHORT — 1 to 2 sentences maximum. Warm, not robotic.
- Always let the caller finish speaking completely before you respond. Never interrupt.
- After the hand-off in STEP 4, remain completely silent until you receive a [SYSTEM INSTRUCTION]. Do not generate any responses on your own.`;
}
