import OpenAI from 'openai';
import type { TranscriptEntry, ScreeningDecision } from './types.js';

const HOLD_DEFAULT: ScreeningDecision = {
  action: 'hold_for_review',
  confidence: 0.5,
  reasoning: 'Unable to complete screening analysis — held for manual review.',
  red_flags: [],
  iteration: 0,
};

export function buildScreeningPrompt(recipientName: string, securityContext: string[]): string {
  const contextSection = securityContext.length > 0
    ? `\nVERIFIED PERSONAL FACTS ABOUT ${recipientName.toUpperCase()}:
The following details have been confirmed by ${recipientName} or their family. These are NOT used for every caller — see the targeting rule below before deciding whether to probe.
${securityContext.map(f => `- ${f}`).join('\n')}

WHEN TO USE THESE FACTS (targeting rule):
- ONLY use these facts as follow-up questions if the caller claims to be a parent, sibling, or best/close friend of ${recipientName}. These are the relationships a scammer is most likely to impersonate to create emotional urgency.
- Do NOT probe with these facts for callers claiming to be doctors, businesses, delivery services, coworkers, acquaintances, or any other non-intimate relationship. Those calls are judged on their own merits (purpose, consistency, scam patterns).

HOW TO ASK (when targeting rule applies):
- Ask one fact-based question naturally, as if you are simply double-checking — not interrogating. E.g. "Just to confirm, what's ${recipientName}'s mum's name?" rather than listing the fact and asking to confirm it.
- If the caller correctly answers, that is a strong legitimacy signal.
- If the caller cannot answer or contradicts a fact, treat it as a significant red flag.

IMPORTANT: Set "verified_fact_matched": true only if the caller is claiming a close personal relationship (parent, sibling, close friend) AND their response directly confirms at least one specific detail from the VERIFIED PERSONAL FACTS above. Do not set this for distant relationships even if they happen to mention something consistent.\n`
    : '';

  return `You are a call security analyst protecting ${recipientName}, a vulnerable adult, from phone scams and fraud.

You will receive a transcript of a phone conversation between an AI receptionist and an incoming caller. Your job is to assess whether this call is legitimate or a potential scam.
${contextSection}
ANALYZE FOR:
1. **Identity verification**: Did the caller know the recipient's name (${recipientName})? Accept phonetically similar variations or close mispronunciations (e.g., "Henry" matching "Hendry", "Henri" or "Henery", "Margaret" matching "Margret"). Speech-to-text often mishears names. If the caller is clearly attempting the correct name, treat it as a pass. Only reject if the name is completely wrong or they cannot provide one at all.
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
- If the caller explicitly mentions scam-pattern content — tax debts, IRS/SSA/law enforcement threats, arrest warrants, gift card payments, wire transfers, prize winnings, "your grandson is in trouble", tech support access requests, or any urgent financial demand: action = "reject", confidence 0.01–0.05. These are near-certain scams; do not ask follow-ups.
- If clearly a scam for other reasons (failed identity check, manipulation tactics, government impersonation): action = "reject", confidence < 0.15
- If suspicious but not certain — you need more information to decide: action = "ask_followup" with a specific probing question
- If you've asked follow-ups and still can't determine: action = "hold_for_review"
- Maximum 5 follow-up rounds. After 5, you MUST choose approve, reject, or hold_for_review.

FOLLOW-UP QUESTION STRATEGY:
- Think like a curious, warm receptionist — not an interrogator. Questions must sound natural spoken aloud.
- Always reference what the caller has already said. Each question should follow logically from their previous answer.
- Build reasoning progressively: start broad if you need more context ("Could you tell me more about that?"), then narrow to specifics only when needed ("Which practice are you calling from?").
- For callers claiming to be a parent, sibling, or close friend of ${recipientName}: if you are still uncertain after one or two general questions, use ONE verified personal fact as a final weed-out question (see targeting rule above). Frame it naturally ("Just to confirm — what's his mum's name?" not a quiz). Do not ask more than one fact-based question.
- For all other callers: do not probe with personal facts. Assess based on purpose, consistency, and scam patterns only.
- Never ask two questions at once. One per turn, maximum.
- If the caller has already provided enough information to reach a decision, do NOT ask more questions — make the decision.
- Maximum 5 total rounds. Use them efficiently; most cases need 1–2 at most.

RESPOND WITH ONLY THIS JSON (no markdown, no backticks, no preamble):
{
  "action": "ask_followup" | "approve" | "reject" | "hold_for_review",
  "next_question": "string (required if action is ask_followup, omit otherwise)",
  "confidence": 0.0-1.0,
  "reasoning": "2-3 sentence explanation",
  "red_flags": ["list", "of", "specific", "concerns"],
  "verified_fact_matched": true | false,
  "iteration": <current_round_number>
}`;
}

function formatTranscript(transcript: TranscriptEntry[], callerNumber: string, iteration: number): string {
  const lines = transcript.map(e =>
    `[${e.role === 'caller' ? 'CALLER' : 'RECEPTIONIST'}]: ${e.text}`
  ).join('\n');

  return `CALLER PHONE NUMBER: ${callerNumber}
SCREENING ROUND: ${iteration}

TRANSCRIPT:
${lines}`;
}

function parseDecision(text: string, iteration: number): ScreeningDecision {
  // Strip markdown code fences the model sometimes adds despite being told not to
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(cleaned);

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
    verified_fact_matched: parsed.verified_fact_matched === true,
    iteration: parsed.iteration ?? iteration,
  };
}

let openaiClient: OpenAI | null = null;

function getOpenAIClient(apiKey: string): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export async function screenCall(
  transcript: TranscriptEntry[],
  callerNumber: string,
  openaiApiKey: string,
  recipientName: string,
  iteration: number,
  securityContext: string[] = [],
): Promise<ScreeningDecision> {
  const client = getOpenAIClient(openaiApiKey);
  const systemPrompt = buildScreeningPrompt(recipientName, securityContext);
  const userMessage = formatTranscript(transcript, callerNumber, iteration);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 512,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
      });

      const text = response.choices[0]?.message?.content;
      if (!text) {
        return { ...HOLD_DEFAULT, iteration };
      }

      return parseDecision(text, iteration);
    } catch (err) {
      if (attempt === 1) {
        console.error('Screener failed after retry:', err);
        return { ...HOLD_DEFAULT, iteration };
      }
    }
  }

  return { ...HOLD_DEFAULT, iteration };
}
