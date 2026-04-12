import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type Database from 'better-sqlite3';
import type { Config } from './config.js';
import { VoiceSession, buildSystemPrompt } from './voice-session.js';
import { logCall } from './db.js';
import { screenCall } from './screener.js';
import { sendAlert } from './alerts.js';
import type { CallRecord, ScreeningDecision } from './types.js';
import Twilio from 'twilio';

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17';
const OPENAI_VOICE = 'shimmer';

const activeSessions = new Map<string, VoiceSession>();

export function setupWebSocketServer(server: Server, db: Database.Database, config: Config): void {
  const wss = new WebSocketServer({ server, path: '/media-stream' });

  wss.on('connection', (twilioWs: WebSocket) => {
    let session: VoiceSession | null = null;
    let openaiWs: WebSocket | null = null;
    let streamSid = '';

    twilioWs.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'start': {
          streamSid = msg.start.streamSid;
          const callSid = msg.start.callSid;

          session = new VoiceSession({
            callSid,
            callerNumber: msg.start.customParameters?.callerNumber || '',
            recipientName: config.recipientName,
            streamSid,
          });
          activeSessions.set(streamSid, session);
	console.log('[DEBUG] OpenAI key starts with:', config.openaiApiKey.substring(0, 10));

          console.log("[DEBUG] OpenAI key starts with:", config.openaiApiKey.substring(0, 10));
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
                turn_detection: { type: 'server_vad' },
                instructions: buildSystemPrompt(config.recipientName),
              },
            }));
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
  console.log(`[${session.callSid}] Screening iteration ${session.screeningIteration}`);

  let decision: ScreeningDecision;
  try {
    decision = await screenCall(
      session.transcript,
      session.callerNumber,
      config.anthropicApiKey,
      config.recipientName,
      session.screeningIteration,
    );
  } catch {
    decision = {
      action: 'hold_for_review',
      confidence: 0.5,
      reasoning: 'Screening engine error — held for review.',
      red_flags: [],
      iteration: session.screeningIteration,
    };
  }

  console.log(`[${session.callSid}] Decision: ${decision.action} (confidence: ${decision.confidence})`);

  switch (decision.action) {
    case 'approve': {
      session.setState('completed');
      logCallFromDecision(session, decision, 'forwarded', db);
      // Forward the call via Twilio REST API
      await forwardCallViaTwilio(session.callSid, config);
      activeSessions.delete(streamSid);
      break;
    }

    case 'reject': {
      session.setState('completed');
      const blockedRecord = logCallFromDecision(session, decision, 'blocked', db);
      fireAlert(blockedRecord, config);
      // Tell the caller goodbye via OpenAI
      injectMessage(openaiWs, "I'm sorry, I'm not able to connect you at this time. Goodbye.");
      // Close after a short delay to let the message play
      setTimeout(() => {
        endCall(session.callSid, config);
        activeSessions.delete(streamSid);
      }, 5000);
      break;
    }

    case 'hold_for_review': {
      session.setState('completed');
      const heldRecord = logCallFromDecision(session, decision, 'held', db);
      fireAlert(heldRecord, config);
      injectMessage(openaiWs, "Thank you for calling. I'll have them call you back. Have a good day.");
      setTimeout(() => {
        endCall(session.callSid, config);
        activeSessions.delete(streamSid);
      }, 5000);
      break;
    }

    case 'ask_followup': {
      if (session.maxIterationsReached()) {
        // Force hold after max iterations
        session.setState('completed');
        const maxIterRecord = logCallFromDecision(session, { ...decision, action: 'hold_for_review' }, 'held', db);
        fireAlert(maxIterRecord, config);
        injectMessage(openaiWs, "Thank you for your patience. I'll have them call you back. Have a good day.");
        setTimeout(() => {
          endCall(session.callSid, config);
          activeSessions.delete(streamSid);
        }, 5000);
      } else {
        // Ask the follow-up question via OpenAI
        session.setState('follow_up');
        injectMessage(openaiWs, decision.next_question || "Could you tell me a bit more about your reason for calling?");
        // The screening will re-trigger when the AI finishes this follow-up turn
        // and looksLikeScreeningComplete detects the next "one moment" phrase
        // We set up a listener for the caller's response to the follow-up
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

function logCallFromDecision(
  session: VoiceSession,
  decision: ScreeningDecision,
  outcome: 'forwarded' | 'blocked' | 'held',
  db: Database.Database,
): CallRecord {
  // Extract caller info from transcript
  const callerName = extractFromTranscript(session.transcript, 'who am I speaking with');
  const relationship = extractFromTranscript(session.transcript, 'how do you know');
  const purpose = extractFromTranscript(session.transcript, 'call regarding');
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
    twilioAccountSid: config.twilioAccountSid,
    twilioAuthToken: config.twilioAuthToken,
    twilioPhoneNumber: config.twilioPhoneNumber,
    emergencyContactPhone: config.emergencyContactPhone,
    recipientName: config.recipientName,
  }).catch(err => console.error('Alert dispatch error:', err));
}

function extractFromTranscript(transcript: { role: string; text: string }[], questionFragment: string): string | null {
  for (let i = 0; i < transcript.length - 1; i++) {
    if (
      transcript[i].role === 'receptionist' &&
      transcript[i].text.toLowerCase().includes(questionFragment.toLowerCase())
    ) {
      // The next caller entry is the answer
      if (transcript[i + 1]?.role === 'caller') {
        return transcript[i + 1].text;
      }
    }
  }
  return null;
}

function checkIfKnewName(transcript: { role: string; text: string }[], recipientName: string): boolean {
  const nameLower = recipientName.toLowerCase();
  for (const entry of transcript) {
    if (entry.role === 'caller' && entry.text.toLowerCase().includes(nameLower)) {
      return true;
    }
  }
  return false;
}

async function forwardCallViaTwilio(callSid: string, config: Config): Promise<void> {
  try {
    const client = Twilio(config.twilioAccountSid, config.twilioAuthToken);
    await client.calls(callSid).update({
      twiml: `<Response><Say voice="Polly.Joanna">Connecting you now.</Say><Dial>${config.recipientPhoneNumber}</Dial></Response>`,
    });
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

    case 'conversation.item.input_audio_transcription.completed': {
      if (event.transcript?.trim()) {
        session.addTranscriptEntry('caller', event.transcript.trim());
        console.log(`[${session.callSid}] Caller: ${event.transcript.trim()}`);
      }
      break;
    }

    case 'response.audio_transcript.done': {
      if (event.transcript?.trim()) {
        session.addTranscriptEntry('receptionist', event.transcript.trim());
        console.log(`[${session.callSid}] Receptionist: ${event.transcript.trim()}`);
      }
      break;
    }

    case 'response.done': {
      const lastEntry = session.transcript[session.transcript.length - 1];
      if (
        session.state !== 'completed' &&
        session.state !== 'analyzing' &&
        lastEntry?.role === 'receptionist' &&
        looksLikeScreeningComplete(lastEntry.text)
      ) {
        session.setState('analyzing');
        session.onScreeningComplete?.();
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
