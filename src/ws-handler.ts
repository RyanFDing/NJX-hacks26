import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { VoiceSession, buildSystemPrompt } from './voice-session.js';
import { logCall, getSecurityContext } from './db.js';
import { forwardCall } from './twiml.js';
import { screenCall } from './screener.js';
import { sendAlert } from './alerts.js';
import type { CallRecord, ScreeningDecision } from './types.js';
import Twilio from 'twilio';

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';
const OPENAI_VOICE = 'shimmer';
const MAX_SCREENING_ROUNDS = 5;
const APPROVE_MIN_CONFIDENCE = 0.65;
const REJECT_MAX_CONFIDENCE = 0.15;

// ═══ HARDCODED TIMING CONSTRAINTS ════════════════════════════════════════════
// Minimum gap between the end of one AI turn and the start of the next.
const HARD_BOT_TURN_GAP_MS   = 3000;
// Minimum silence from the caller before the AI may speak.
const HARD_CALLER_SILENCE_MS = 800;
// How often scheduleInjection re-checks conditions while waiting.
const INJECTION_POLL_MS      = 50;
// ═════════════════════════════════════════════════════════════════════════════

// How long to wait after caller finishes before running the screener.
// The screener API call (~1-2 s) adds to this, giving ~3.5-4.5 s natural pause.
const MIN_SCREENING_DELAY_MS = 2500;

const activeSessions = new Map<string, VoiceSession>();

export function setupWebSocketServer(server: Server, db: Database.Database, config: Config): void {
  const wss = new WebSocketServer({ server, path: '/media-stream' });

  wss.on('connection', (twilioWs: WebSocket) => {
    let session: VoiceSession | null = null;
    let openaiWs: WebSocket | null = null;
    let streamSid = '';

    twilioWs.on('message', (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error('Twilio WebSocket: received non-JSON message, ignoring');
        return;
      }

      switch (msg.event) {
        case 'start': {
          streamSid = msg.start.streamSid;
          const callSid = msg.start.callSid;
          const callerNumber = msg.start.customParameters?.callerNumber || '';

          // Whitelist is handled at the HTTP layer (twilio.ts) before the stream starts.
          // If we're here, the caller is not whitelisted.
          session = new VoiceSession({
            callSid,
            callerNumber,
            recipientName: config.recipientName,
            streamSid,
          });
          activeSessions.set(streamSid, session);

          openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
            headers: {
              'Authorization': `Bearer ${config.openaiApiKey}`,
              'OpenAI-Beta': 'realtime=v1',
            },
          });

          openaiWs.on('open', () => {
            openaiWs!.send(JSON.stringify({
              type: 'session.update',
              session: {
                voice: OPENAI_VOICE,
                input_audio_format: 'g711_ulaw',
                output_audio_format: 'g711_ulaw',
                input_audio_transcription: { model: 'whisper-1' },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  silence_duration_ms: 800,
                },
                instructions: buildSystemPrompt(config.recipientName),
              },
            }));

            // Make the bot speak first — don't wait for caller input
            setTimeout(() => {
              openaiWs!.send(JSON.stringify({ type: 'response.create' }));
            }, 500);
          });


          // Wire up the screening callback
          session.onScreeningComplete = () => {
            runScreeningLoop(session!, openaiWs!, twilioWs, streamSid, db, config);
          };

          openaiWs.on('message', (openaiData: Buffer) => {
            const event = JSON.parse(openaiData.toString());
            handleOpenAIEvent(event, twilioWs, session!, streamSid, db, config);
          });

          openaiWs.on('error', (err) => {
            console.error('OpenAI WebSocket error:', err.message);
            handleOpenAIFailure(session!, streamSid, db, config);
          });

          openaiWs.on('close', () => {
            if (session && session.state !== 'completed') {
              handleOpenAIFailure(session, streamSid, db, config);
            }
          });
          break;
        }

        case 'media': {
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload,
            }));
          }
          break;
        }

        case 'stop': {
          if (session) {
            session.cancelPendingInjection();
          }
          if (openaiWs?.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          if (session) {
            activeSessions.delete(streamSid);
          }
          break;
        }
      }
    });

    twilioWs.on('close', () => {
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
      if (streamSid) {
        activeSessions.delete(streamSid);
      }
    });

    twilioWs.on('error', (err) => {
      console.error('Twilio WebSocket error:', err.message);
    });
  });
}

async function runScreeningLoop(
  session: VoiceSession,
  openaiWs: WebSocket,
  twilioWs: WebSocket,
  streamSid: string,
  db: Database.Database,
  config: Config,
): Promise<void> {
  session.incrementIteration();
  console.log(`[${session.callSid}] Screening iteration ${session.screeningIteration}/${MAX_SCREENING_ROUNDS}`);
  console.log(`[${session.callSid}] Transcript so far:`, session.transcript.map(t => `${t.role}: ${t.text}`).join(' | '));

  const securityFacts = getSecurityContext(db).map(f => f.fact);
  let decision: ScreeningDecision;
  try {
    decision = await screenCall(
      session.transcript,
      session.callerNumber,
      config.openaiApiKey,
      config.recipientName,
      session.screeningIteration,
      securityFacts,
    );
  } catch (err) {
    console.error(`[${session.callSid}] Screening error:`, err);
    decision = {
      action: 'hold_for_review',
      confidence: 0.5,
      reasoning: 'Screening engine error — held for review.',
      red_flags: [],
      iteration: session.screeningIteration,
    };
  }

  // Auto-approve if the caller correctly matched a verified personal fact.
  // One confirmed fact is sufficient to pass — a scammer would not know these details.
  if (decision.verified_fact_matched && securityFacts.length > 0 && decision.action !== 'reject') {
    console.log(`[${session.callSid}] Verified personal fact matched — auto-approving`);
    decision = { ...decision, action: 'approve', confidence: Math.max(decision.confidence, 0.90) };
  }

  // Enforce confidence thresholds regardless of what the model returned as action.
  // The model's probability is treated as ground truth; these gates prevent low-confidence
  // approvals from being forwarded and low-confidence rejections from being hard-blocked.
  if (decision.action === 'approve' && decision.confidence < APPROVE_MIN_CONFIDENCE) {
    console.log(`[${session.callSid}] Approve overridden: confidence ${decision.confidence} < ${APPROVE_MIN_CONFIDENCE} → ask_followup`);
    decision = { ...decision, action: 'ask_followup', next_question: decision.next_question || "Could you tell me a bit more about your reason for calling?" };
  } else if (decision.action === 'reject' && decision.confidence > REJECT_MAX_CONFIDENCE) {
    console.log(`[${session.callSid}] Reject overridden: confidence ${decision.confidence} > ${REJECT_MAX_CONFIDENCE} → hold_for_review`);
    decision = { ...decision, action: 'hold_for_review' };
  }

  console.log(`[${session.callSid}] Decision: ${decision.action} (confidence: ${decision.confidence})`);
  console.log(`[${session.callSid}] Reasoning: ${decision.reasoning}`);
  if (decision.red_flags?.length) {
    console.log(`[${session.callSid}] Red flags: ${decision.red_flags.join(', ')}`);
  }

  switch (decision.action) {
    case 'approve': {
      session.setState('completed');
      const approvedRecord = logCallFromDecision(session, decision, 'forwarded', db);
      fireAlert(approvedRecord, config);
      const approvalMessage = buildApprovalMessage(approvedRecord.caller_name, decision.reasoning);
      scheduleInjection(openaiWs, approvalMessage, session);
      setTimeout(() => {
        forwardCallViaTwilio(session.callSid, config);
        activeSessions.delete(streamSid);
      }, 4000);
      break;
    }

    case 'reject': {
      session.setState('completed');
      const blockedRecord = logCallFromDecision(session, decision, 'blocked', db);
      fireAlert(blockedRecord, config);
      const rejectionMessage = buildRejectionMessage(decision.red_flags, decision.reasoning);
      console.log(`[${session.callSid}] Scam detected — delivering rejection message then disconnecting`);
      scheduleInjection(openaiWs, rejectionMessage, session);
      setTimeout(() => {
        endCall(session.callSid, config);
        activeSessions.delete(streamSid);
      }, 6000);
      break;
    }

    case 'hold_for_review': {
      session.setState('completed');
      const heldRecord = logCallFromDecision(session, decision, 'held', db);
      // Fire the alert first so the recipient gets the ntfy warning before the call rings through.
      fireAlert(heldRecord, config);
      scheduleInjection(openaiWs, "One moment, connecting you now.", session);
      setTimeout(() => {
        forwardCallViaTwilio(session.callSid, config);
        activeSessions.delete(streamSid);
      }, 4000);
      break;
    }

    case 'ask_followup': {
      if (session.screeningIteration >= MAX_SCREENING_ROUNDS) {
        // Exhausted all rounds without a clear decision — forward with alert so recipient is warned.
        session.setState('completed');
        const maxRecord = logCallFromDecision(session, { ...decision, action: 'hold_for_review' }, 'held', db);
        fireAlert(maxRecord, config);
        scheduleInjection(openaiWs, "One moment, connecting you now.", session);
        setTimeout(() => {
          forwardCallViaTwilio(session.callSid, config);
          activeSessions.delete(streamSid);
        }, 4000);
      } else {
        session.setState('follow_up');
        const question = decision.next_question || "Could you tell me a bit more about your reason for calling?";
        console.log(`[${session.callSid}] Follow-up question (round ${session.screeningIteration}/${MAX_SCREENING_ROUNDS}): ${question}`);

        scheduleInjection(openaiWs, question, session);

        // Wait for the caller to respond, then loop back.
        session.onScreeningComplete = () => {
          runScreeningLoop(session, openaiWs, twilioWs, streamSid, db, config);
        };
      }
      break;
    }
  }
}


function injectMessage(openaiWs: WebSocket, text: string): void {
  if (openaiWs.readyState !== WebSocket.OPEN) return;

  // Cancel any response currently in progress to avoid the
  // 'conversation_already_has_active_response' error.
  openaiWs.send(JSON.stringify({ type: 'response.cancel' }));

  openaiWs.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `[SYSTEM INSTRUCTION]: Say exactly this to the caller: "${text}"` }],
    },
  }));
  openaiWs.send(JSON.stringify({ type: 'response.create' }));
}

/**
 * Schedule an injection that respects both hardcoded timing constraints:
 *   1. HARD_BOT_TURN_GAP_MS  — AI must be silent ≥ 3 s since it last spoke.
 *   2. HARD_CALLER_SILENCE_MS — caller must be silent ≥ 0.8 s since they last spoke.
 *
 * Polls every INJECTION_POLL_MS until both conditions are true, then fires.
 * Any previously pending injection for this session is cancelled first.
 */
function scheduleInjection(openaiWs: WebSocket, text: string, session: VoiceSession): void {
  // Cancel any injection that was already queued for this session.
  session.cancelPendingInjection();

  const attempt = () => {
    // Abort if the WebSocket has closed (call ended while we were waiting).
    if (openaiWs.readyState !== WebSocket.OPEN) {
      session.pendingInjectionTimer = null;
      return;
    }

    const now = Date.now();
    const botGapOk     = now - session.lastBotSpeechEndTime  >= HARD_BOT_TURN_GAP_MS;
    const callerSilent = !session.callerIsSpeaking &&
                         now - session.lastCallerSpeechEndTime >= HARD_CALLER_SILENCE_MS;

    if (botGapOk && callerSilent) {
      session.pendingInjectionTimer = null;
      injectMessage(openaiWs, text);
    } else {
      session.pendingInjectionTimer = setTimeout(attempt, INJECTION_POLL_MS);
    }
  };

  // Compute the earliest moment both conditions could be met and use that as
  // the initial delay — avoids tight-looping when we know we'll wait a while.
  const now = Date.now();
  const botWait = Math.max(0, HARD_BOT_TURN_GAP_MS - (now - session.lastBotSpeechEndTime));
  const silenceWait = session.callerIsSpeaking
    ? HARD_CALLER_SILENCE_MS + 300   // mid-speech: rough minimum estimate
    : Math.max(0, HARD_CALLER_SILENCE_MS - (now - session.lastCallerSpeechEndTime));
  const initialDelay = Math.max(botWait, silenceWait, INJECTION_POLL_MS);

  session.pendingInjectionTimer = setTimeout(attempt, initialDelay);
}




function logCallFromDecision(
  session: VoiceSession,
  decision: ScreeningDecision,
  outcome: 'forwarded' | 'blocked' | 'held',
  db: Database.Database,
): CallRecord {
  // Extract caller info from transcript
  const callerName = extractFromTranscript(session.transcript, [
    'who am i speaking with',
    "who's calling",
    'may i ask your name',
    'your name',
    'who is this',
  ]);
  const relationship = extractFromTranscript(session.transcript, [
    'how do you know',
    'your relationship',
    'how are you related',
    'relation to',
  ]);
  const purpose = extractFromTranscript(session.transcript, [
    'what\'s this call about',
    'call about today',
    'call regarding',
    'reason for calling',
    'reason for your call',
    'what brings you',
    'calling about',
    'how can i help',
    'what is this regarding',
    'what can i help',
  ]);
  const knewName = checkIfKnewName(session.transcript, session.recipientName);

  const record: CallRecord = {
    id: session.callSid,
    caller_number: session.callerNumber,
    caller_name: callerName,
    stated_relationship: relationship,
    stated_purpose: purpose,
    knew_recipient_name: knewName,
    confidence_score: decision.confidence,
    risk_reasoning: decision.reasoning,
    outcome,
    transcript: JSON.stringify(session.transcript),
    created_at: new Date().toISOString(),
  };

  logCall(db, record);
  return record;
}

function fireAlert(record: CallRecord, config: Config): void {
  sendAlert(record, {
    ntfyTopic: config.ntfyTopic,
    recipientName: config.recipientName,
  }).catch(err => console.error('Alert dispatch error:', err));
}

function extractFromTranscript(transcript: { role: string; text: string }[], fragments: string | string[]): string | null {
  const needles = (Array.isArray(fragments) ? fragments : [fragments]).map(f => f.toLowerCase());
  for (let i = 0; i < transcript.length - 1; i++) {
    const entry = transcript[i];
    if (entry.role !== 'receptionist') continue;
    const lower = entry.text.toLowerCase();
    if (needles.some(n => lower.includes(n))) {
      // Find the next caller turn (skip any back-to-back receptionist turns)
      for (let j = i + 1; j < transcript.length; j++) {
        if (transcript[j].role === 'caller') return transcript[j].text;
        if (transcript[j].role === 'receptionist') break;
      }
    }
  }
  return null;
}

/**
 * Reduce a string to its consonant skeleton:
 *   1. Lowercase + strip non-alpha
 *   2. Common phonetic substitutions (ph→f, ck→k, etc.)
 *   3. Remove all vowels including 'y' (semi-vowel in names like "Ryan")
 *   4. Collapse repeated consonants
 *
 * "ryan ding", "rin ding", "rynding" all reduce to "rndng".
 */
function consonantSkeleton(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/tch/g, 'ch')
    .replace(/wr/g, 'r')
    .replace(/kn/g, 'n')
    .replace(/[aeiouy]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function checkIfKnewName(transcript: { role: string; text: string }[], recipientName: string): boolean {
  const nameLower = recipientName.toLowerCase();
  const targetSkeleton = consonantSkeleton(recipientName);
  // 60% match on the whole name: allow up to 40% of consonants to differ.
  const maxEditDist = Math.floor(targetSkeleton.length * 0.4);

  for (const entry of transcript) {
    if (entry.role !== 'caller') continue;
    const lower = entry.text.toLowerCase();

    // 1. Exact string match — fast path
    if (lower.includes(nameLower)) return true;

    if (targetSkeleton.length < 3) continue;

    const callerSkeleton = consonantSkeleton(entry.text);

    // 2. Exact consonant-skeleton substring — handles fused pronunciations
    //    like "rynding" or "rin ding" for "Ryan Ding"
    if (callerSkeleton.includes(targetSkeleton)) return true;

    // 3. Sliding-window edit distance at 60% threshold — handles "Ryan Din"
    //    (missing trailing consonant) and similar near-misses.
    //    Windows of targetLength ± 1 absorb minor length differences.
    const tLen = targetSkeleton.length;
    for (let winSize = Math.max(1, tLen - 1); winSize <= tLen + 1; winSize++) {
      for (let i = 0; i + winSize <= callerSkeleton.length; i++) {
        if (levenshtein(callerSkeleton.slice(i, i + winSize), targetSkeleton) <= maxEditDist) {
          return true;
        }
      }
    }
  }
  return false;
}

function buildRejectionMessage(redFlags: string[], reasoning: string): string {
  const primaryFlag = redFlags.length > 0 ? redFlags[0].toLowerCase() : null;
  // Use the full reasoning as the spoken justification — this is the same text shown in the dashboard.
  const spokenReason = reasoning.trim().replace(/\s+/g, ' ');

  if (primaryFlag) {
    return `I need to stop you there. This call has been flagged for ${primaryFlag}. ${spokenReason} This number is protected and this call is now being terminated. Goodbye.`;
  }
  return `I need to stop you there. ${spokenReason} This call is being terminated. Goodbye.`;
}

function buildApprovalMessage(callerName: string | null, reasoning: string): string {
  // Extract a short reason from the screener's reasoning — first sentence only.
  const shortReason = reasoning.split(/[.!]/)[0].trim();

  if (callerName) {
    return `Thanks ${callerName}, everything checks out — ${shortReason.toLowerCase()}. Connecting you now, one moment.`;
  }
  return `Everything checks out — ${shortReason.toLowerCase()}. Connecting you now, one moment.`;
}

async function forwardCallViaTwilio(callSid: string, config: Config): Promise<void> {
  try {
    const client = Twilio(config.twilioAccountSid, config.twilioAuthToken);
    await client.calls(callSid).update({
      twiml: forwardCall(config.recipientPhoneNumber),
    });
    console.log(`[${callSid}] Call forwarded to ${config.recipientPhoneNumber}`);
  } catch (err) {
    console.error(`Failed to forward call ${callSid}:`, err);
  }
}

async function endCall(callSid: string, config: Config): Promise<void> {
  try {
    const client = Twilio(config.twilioAccountSid, config.twilioAuthToken);
    await client.calls(callSid).update({ status: 'completed' });
  } catch (err) {
    console.error(`Failed to end call ${callSid}:`, err);
  }
}

// Trigger the screening loop, but defer if the caller is currently speaking so
// their full turn is transcribed before the screener evaluates it.
// Always waits MIN_SCREENING_DELAY_MS before running so there is a natural pause
// between the caller finishing and the bot asking its next question.
function triggerScreening(session: VoiceSession): void {
  if (session.callerIsSpeaking) {
    console.log(`[${session.callSid}] Caller is mid-speech — deferring screening until transcription completes`);
    session.pendingScreeningTrigger = true;
  } else {
    session.setState('analyzing');
    setTimeout(() => {
      session.onScreeningComplete?.();
    }, MIN_SCREENING_DELAY_MS);
  }
}

function handleOpenAIEvent(
  event: any,
  twilioWs: WebSocket,
  session: VoiceSession,
  streamSid: string,
  db: Database.Database,
  config: Config,
): void {
  switch (event.type) {
    case 'response.audio.delta': {
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: event.delta },
        }));
      }
      break;
    }

    case 'input_audio_buffer.speech_started': {
      session.callerIsSpeaking = true;
      break;
    }

    case 'input_audio_buffer.speech_stopped': {
      session.callerIsSpeaking = false;
      session.lastCallerSpeechEndTime = Date.now();
      break;
    }

    case 'conversation.item.input_audio_transcription.completed': {
      if (event.transcript?.trim()) {
        session.addTranscriptEntry('caller', event.transcript.trim());
        console.log(`[${session.callSid}] Caller: ${event.transcript.trim()}`);
      }
      session.callerIsSpeaking = false;
      // If screening was waiting for the caller to finish speaking, trigger it now
      // — with the same minimum delay applied as the direct path.
      if (session.pendingScreeningTrigger) {
        session.pendingScreeningTrigger = false;
        session.setState('analyzing');
        setTimeout(() => {
          session.onScreeningComplete?.();
        }, MIN_SCREENING_DELAY_MS);
      }
      break;
    }

    case 'response.audio_transcript.done': {
      if (event.transcript?.trim()) {
        session.addTranscriptEntry('receptionist', event.transcript.trim());
        console.log(`[${session.callSid}] Receptionist: ${event.transcript.trim()}`);
      }
      // Record when the bot finished speaking so follow-up injections can
      // respect the MIN_BOT_TURN_GAP_MS floor.
      session.lastBotSpeechEndTime = Date.now();
      break;
    }

        case 'response.done': {
      const lastEntry = session.transcript[session.transcript.length - 1];
      if (
        session.state === 'completed' ||
        session.state === 'analyzing'
      ) break;

      // After initial screening (bot said "one moment") OR after a follow-up
      // where the caller has responded
      if (session.state === 'follow_up') {
        // Check if the last entry was from the caller (they answered the follow-up)
        const callerResponded = session.transcript.some((entry, i) => {
          if (i < session.transcript.length - 2) return false;
          return entry.role === 'caller';
        });
        if (callerResponded) {
          triggerScreening(session);
        }
      } else if (
        lastEntry?.role === 'receptionist' &&
        looksLikeScreeningComplete(lastEntry.text)
      ) {
        triggerScreening(session);
      }
      break;
    }


    case 'error': {
      console.error(`[${session.callSid}] OpenAI error:`, event.error);
      break;
    }
  }
}

function looksLikeScreeningComplete(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('one moment') ||
    lower.includes('let me check') ||
    lower.includes('hold on') ||
    lower.includes('check on that')
  );
}

function handleOpenAIFailure(
  session: VoiceSession,
  streamSid: string,
  db: Database.Database,
  config: Config,
): void {
  if (session.state === 'completed') return;
  session.cancelPendingInjection();
  session.setState('completed');

  const record: CallRecord = {
    id: session.callSid,
    caller_number: session.callerNumber,
    caller_name: null,
    stated_relationship: null,
    stated_purpose: null,
    knew_recipient_name: null,
    confidence_score: null,
    risk_reasoning: 'Voice session failed — held for review',
    outcome: 'held',
    transcript: JSON.stringify(session.transcript),
    created_at: new Date().toISOString(),
  };

  logCall(db, record);
  fireAlert(record, config);

  activeSessions.delete(streamSid);
}

export function getActiveSession(streamSid: string): VoiceSession | undefined {
  return activeSessions.get(streamSid);
}
