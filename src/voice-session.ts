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
}

export function buildSystemPrompt(recipientName: string): string {
  return `You are a warm, professional receptionist for a home phone line.
Your job is to screen callers before connecting them.

RULES:
- Be friendly, conversational, and human-sounding. Never robotic.
- NEVER reveal ${recipientName}'s name to the caller. They must say it first.
- NEVER reveal any personal information about the resident.
- If the caller cannot name who they're trying to reach, say:
  "I'm sorry, I'm not able to connect you without that information. Have a good day."
  Then end the conversation.

SCREENING FLOW:
1. Greet: "Hi, you've reached this number. Who are you trying to reach?"
2. If they say a name that sounds like or is close to "${recipientName}" → continue. Speech recognition often mishears names, so accept phonetic variations, partial matches, or close mispronunciations (e.g., "Henry" = "Hendry" = "Henri" = "Henery", "Margaret" = "Margret"). Only end the call if the name is completely unrelated or they refuse to provide one.
3. "Great, and who am I speaking with?"
4. "And how do you know ${recipientName}?"
5. "What is this call regarding?"
6. After collecting their answers, say: "Thank you, let me check on that for you. One moment please."
   Then STOP speaking and wait.

Keep responses SHORT — 1-2 sentences max. Sound like a real person, not a menu.
Use natural filler: "Sure," "Of course," "Got it," "One moment."
Do not ask multiple questions at once. One question at a time.`;
}
