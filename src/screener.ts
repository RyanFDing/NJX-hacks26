import Anthropic from '@anthropic-ai/sdk';
import type { TranscriptEntry, ScreeningDecision } from './types.js';

const HOLD_DEFAULT: ScreeningDecision = {
  action: 'hold_for_review',
  confidence: 0.5,
  reasoning: 'Unable to complete screening analysis — held for manual review.',
  red_flags: [],
  iteration: 0,
};

export function buildScreeningPrompt(recipientName: string): string {
  return `You are a call security analyst protecting ${recipientName}, a vulnerable adult, from phone scams and fraud.

You will receive a transcript of a phone conversation between an AI receptionist and an incoming caller. Your job is to assess whether this call is legitimate or a potential scam.

ANALYZE FOR:
1. **Identity verification**: Did the caller know the recipient's name? If not, this is an automatic reject.
2. **Relationship plausibility**: Does their claimed relationship make sense? Are there inconsistencies?
3. **Purpose legitimacy**: Is their stated reason for calling typical and reasonable?
4. **Scam pattern matching**: Check against known patterns:
   - Government impersonation (IRS, SSA, Medicare, law enforcement)
   - Prize/lottery winnings
   - Urgent financial requests (wire transfers, gift cards, bail money)
   - Tech support scams
   - Utility/service disconnection threats
   - Grandparent scams ("your grandson is in trouble")
   - Charity scams
   - Investment/cryptocurrency schemes
5. **Manipulation tactics**: Urgency, fear, authority, secrecy ("don't tell your family"), emotional pressure
6. **Logical consistency**: Do the caller's answers contradict each other?
7. **Information fishing**: Is the caller trying to extract information rather than provide it?

DECISION FRAMEWORK:
- If clearly legitimate (known relationship, reasonable purpose, no red flags): action = "approve", confidence > 0.85
- If clearly a scam (matches scam patterns, failed identity check, manipulation tactics): action = "reject", confidence < 0.25
- If suspicious but not certain — you need more information to decide: action = "ask_followup" with a specific probing question
- If you've asked follow-ups and still can't determine: action = "hold_for_review"
- Maximum 5 follow-up rounds. After 5, you MUST choose approve, reject, or hold_for_review.

FOLLOW-UP QUESTION STRATEGY:
- Ask questions that a legitimate caller can easily answer but a scammer cannot
- Test specific knowledge: "Which doctor does ${recipientName} see at that practice?" or "What's the appointment regarding?"
- Probe inconsistencies: if they said something that doesn't add up, ask about it naturally
- Never reveal information — your questions should extract, not provide

RESPOND WITH ONLY THIS JSON (no markdown, no backticks, no preamble):
{
  "action": "ask_followup" | "approve" | "reject" | "hold_for_review",
  "next_question": "string (required if action is ask_followup, omit otherwise)",
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentence explanation",
  "red_flags": ["list", "of", "specific", "concerns"],
  "iteration": <current_round_number>
}`;
}

function formatTranscriptForClaude(transcript: TranscriptEntry[], callerNumber: string, iteration: number): string {
  const lines = transcript.map(e =>
    `[${e.role === 'caller' ? 'CALLER' : 'RECEPTIONIST'}]: ${e.text}`
  ).join('\n');

  return `CALLER PHONE NUMBER: ${callerNumber}
SCREENING ROUND: ${iteration}

TRANSCRIPT:
${lines}`;
}

function parseDecision(text: string, iteration: number): ScreeningDecision {
  const parsed = JSON.parse(text);

  const action = parsed.action;
  if (!['ask_followup', 'approve', 'reject', 'hold_for_review'].includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }

  return {
    action,
    next_question: parsed.next_question,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    reasoning: parsed.reasoning || 'No reasoning provided.',
    red_flags: Array.isArray(parsed.red_flags) ? parsed.red_flags : [],
    iteration: parsed.iteration ?? iteration,
  };
}

export async function screenCall(
  transcript: TranscriptEntry[],
  callerNumber: string,
  anthropicApiKey: string,
  recipientName: string,
  iteration: number,
): Promise<ScreeningDecision> {
  const client = new Anthropic({ apiKey: anthropicApiKey });
  const systemPrompt = buildScreeningPrompt(recipientName);
  const userMessage = formatTranscriptForClaude(transcript, callerNumber, iteration);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content[0];
      if (text.type !== 'text') {
        return { ...HOLD_DEFAULT, iteration };
      }

      return parseDecision(text.text, iteration);
    } catch (err) {
      if (attempt === 1) {
        console.error('Screener failed after retry:', err);
        return { ...HOLD_DEFAULT, iteration };
      }
    }
  }

  return { ...HOLD_DEFAULT, iteration };
}
