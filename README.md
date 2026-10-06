# GuardLine

GuardLine screens unfamiliar phone calls before they reach you.

When someone calls the protected number, GuardLine answers first. It asks who the caller is, who they are trying to reach, and why they are calling. A separate screening model evaluates that conversation, and the application either forwards the call, blocks it, or connects it with a warning. Known contacts can be whitelisted to bypass the conversation entirely.

The recipient can review screening results, reasoning, trust scores, and transcripts in a web dashboard. Push alerts announce screened calls without requiring the dashboard to be open. GuardLine is meant for older adults, people with public phone numbers, anyone frequently targeted by unknown callers, and families who want calls screened before they reach someone vulnerable.

## How a call works

1. Someone calls the protected phone number, provided through Twilio.
2. If their number is on the recipient's trusted list, the call goes straight through.
3. Otherwise, an AI receptionist answers and asks who they want to reach, their name, and their reason for calling. Its instructions tell it not to reveal the recipient's name first.
4. A separate screening model reviews the conversation for identity claims, consistency, and signs of scams or manipulation.
5. If more information is needed, the receptionist asks a follow-up question and the answer goes back to the screener. The application caps the process at five screening rounds.
6. GuardLine forwards, warns and forwards, or blocks based on the result. Uncertainty at the round limit leads to a warning and forwarding, not an automatic block.
7. The application sends an alert for the screening outcome and stores the decision and available transcript for the dashboard. Trusted-number bypasses are logged without a transcript or push alert.

```text
Incoming call
      ↓
Trusted number? ── yes ──→ Forward + log bypass
      ↓ no
AI receptionist
      ↓
Collect identity + reason
      ↓
Risk analysis ←───────────────┐
      ↓                       │
Need more information? ─ yes → Follow-up question
      ↓ no                    (within round limit)
Forward / Warn + forward / Block
      ↓
Notification + dashboard log
```

In the dashboard and API, `forwarded` means approved, `blocked` means rejected, and `whitelisted` means a trusted-number bypass. The screening outcome `held` means uncertain: the normal screening path connects the call with a warning, rather than placing it in a queue for manual approval.

## How the phone connection works

[Twilio Programmable Voice](https://www.twilio.com/docs/voice) is the telephony layer. It provides the phone number people dial and connects ordinary phone calls to the application. The recipient has a separate, real phone number that approved calls are forwarded to.

When a call arrives, Twilio sends an HTTP request, called a webhook, to GuardLine's `/voice/incoming` endpoint. GuardLine replies with **TwiML**, an XML document telling Twilio what to do: dial the recipient immediately for a trusted caller, or open a bidirectional audio stream for an unknown caller.

[Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams) carries the caller's audio over a WebSocket, a connection that stays open while messages move in both directions. GuardLine passes that audio to OpenAI and sends the AI's generated speech back to Twilio, which plays it into the phone call. Bidirectional streaming is what lets the receptionist listen and answer, rather than only transcribe a call. The [WebSocket message reference](https://www.twilio.com/docs/voice/media-streams/websocket-messages) describes the audio and call-lifecycle messages used by the bridge.

Once the application approves a call, it updates the live Twilio call with a `<Dial>` instruction to connect the recipient. Blocking ends the call instead.

```text
Caller
  ↕ phone network
Twilio
  ↕ WebSocket audio
GuardLine server
  ├─↔ OpenAI Realtime API: conversation and speech
  └─↔ Screening model: transcript assessment
  ↓ call-control instruction
Twilio
  ↓ approved or warned call
Recipient
```

## Two AI responsibilities

### Voice agent

The [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) handles the live conversation: listening to caller audio, generating spoken responses, and managing turns through voice-activity detection. The session also requests caller transcription through Whisper. GuardLine stores caller and receptionist text as the conversation progresses.

The receptionist gathers information and speaks follow-up questions supplied by the application. It does not independently authorize forwarding. The configured voice model is `gpt-4o-mini-realtime-preview`.

### Screening model

A separate `gpt-4o-mini` text request receives the transcript, caller number, screening round, recipient name, and any saved verification facts. Its instructions ask it to consider:

- Who the caller claims to be and why they are calling.
- Whether they knew the recipient's identity and their answers are consistent.
- Requests for money or access, impersonation patterns, urgency, secrecy, and emotional pressure.
- Relevant answers to personal verification questions.

It returns JSON containing an action, confidence score, reasoning, red flags, and an optional follow-up question. GuardLine parses the response and applies confidence gates before acting: approval requires at least 0.65 confidence, while rejection requires a score no higher than 0.15. Here, higher confidence means greater estimated legitimacy, so the interface calls it a **trust score**, not a scam probability.

The voice model handles conversation; the text model supplies a structured assessment that application code can inspect. Keeping those responsibilities separate lets session behavior and screening-response handling be tested independently. A model score is an assessment, not proof that a caller is safe.

## Personal verification context

The recipient can save facts in Preferences, such as a doctor's name, a family member's name, or a detail a close friend would know. These give the screener context beyond the displayed phone number and generic scam language.

The screening prompt reserves fact-based questions for callers claiming to be a parent, sibling, or close friend. It explicitly avoids quizzing doctors, businesses, delivery services, and other non-intimate contacts. For example, someone claiming to be a sibling may be asked a family detail that an unrelated caller is less likely to know.

When the model reports a matching fact and has not rejected the call, the application promotes the result to approval. This is an additional signal, not identity authentication: personal facts may be known to other people, and both transcription and model judgments can be wrong.

## Dashboard and notifications

The dashboard refreshes call history and outcome totals every ten seconds. Recipients can inspect a call's available identity information, trust score, reasoning, and conversation transcript, then manage trusted numbers and verification facts in separate tabs. Transcripts cover the screening conversation, not the subsequent conversation with the recipient.

The Alerts tab explains how to subscribe to the configured [ntfy](https://ntfy.sh/) topic and provides a test-alert button. The topic itself is configured on the server through `NTFY_TOPIC`.

For screened calls, push alerts include the caller's number, name when available, outcome, and trust score. Blocked and uncertain-call alerts also include the screening reasoning; approved-call alerts are a shorter heads-up. Trusted contacts do not trigger alerts. This keeps screening useful when the recipient is away from the dashboard. See the [ntfy documentation](https://docs.ntfy.sh/) for phone subscriptions and notification behavior.

## Technical architecture

Express serves the dashboard, REST endpoints, and incoming-call webhook. A WebSocket bridge maintains one voice session per screened call, relays audio, and coordinates the screening loop. SQLite stores call records, trusted contacts, and personal facts across restarts. ntfy sends the outcome alerts.

```text
Phone call → Twilio → Media Streams → WebSocket bridge
                                          ↕
                                  OpenAI Realtime API
                                          │ transcript
                                          ↓
                                  Screening engine
                                          ↓
                                       Decision
                         ┌────────────────┼────────────────┐
                      Forward       Warn + forward       Block
                         └────────────────┼────────────────┘
                                  Twilio call control
                                          +
                             SQLite → dashboard / ntfy
```

### Turn timing

A voice agent that immediately asks its next question can interrupt a caller or make the conversation feel rushed. For application-injected follow-ups and outcome messages, GuardLine waits for at least three seconds since the last bot turn and 800 milliseconds of caller silence. A per-session scheduler checks those conditions before sending the instruction. The Realtime session also uses an 800-millisecond silence window for turn detection.

### Speech and transcription timing

A response-completion event can arrive before the caller's transcription is available. If screening is triggered while the caller is still marked as speaking, GuardLine sets a pending flag and defers analysis until the transcription-completed event. Screening then waits another 2.5 seconds. This coordinates asynchronous events without treating response completion alone as proof that the transcript is ready.

### Fuzzy name matching

Speech-to-text may spell a name differently from the recipient's configured name. The call-recording logic first tries an exact text match, then compares simplified consonant patterns, and finally uses sliding-window edit distance to tolerate small transcription differences.

This helps record whether a caller appeared to know the recipient's name. It does not establish who the caller is, and the recorded match is separate from the screening model's own assessment of the transcript.

## Tech stack

- [Node.js](https://nodejs.org/), [TypeScript](https://www.typescriptlang.org/), and [Express](https://expressjs.com/) for the server.
- [Twilio Programmable Voice](https://www.twilio.com/docs/voice) and [Media Streams](https://www.twilio.com/docs/voice/media-streams) for phone routing and bidirectional audio.
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) for voice; Chat Completions for screening.
- [SQLite](https://sqlite.org/) through [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for persistence.
- Plain JavaScript, HTML, and CSS for the dashboard; [ntfy](https://ntfy.sh/) for push alerts.
- [Vitest](https://vitest.dev/) and Supertest for tests.

## Setup

You need Node.js 22.12+ or a compatible newer release, a Twilio account with a voice-capable number, an OpenAI API key with access to the configured models, and an ntfy topic subscribed to on the recipient's phone. Live calls require a public HTTPS address with WebSocket support.

```sh
git clone https://github.com/RyanFDing/NJX-hacks26.git
cd NJX-hacks26
npm ci
cp .env.example .env
```

Fill in `.env`:

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Authenticate call-control requests to Twilio. |
| `TWILIO_PHONE_NUMBER` | The Twilio number GuardLine answers. |
| `RECIPIENT_PHONE_NUMBER` | The separate real number approved calls dial. Use international format, including `+` and country code. |
| `RECIPIENT_NAME` | Name used in receptionist instructions, screening context, and alerts. |
| `OPENAI_API_KEY` | Authenticate the voice and screening models. |
| `NTFY_TOPIC` | Topic on ntfy.sh where the recipient subscribes to alerts. |
| `PORT` | Optional server port; defaults to `3000`. |

Add trusted numbers through the dashboard; incoming-call checks use the saved SQLite whitelist.

```sh
npm run dev       # watch for server changes
# or
npm start
```

Open `http://localhost:3000/#dashboard`. The server creates `guardline.db` in the working directory; retain that file to keep call history and settings. The dashboard requires no build step.

For local call testing, `ngrok http 3000` can provide an HTTPS tunnel. In the Twilio number's configuration, set the incoming voice webhook to `https://YOUR_HOST/voice/incoming`, using HTTP POST. GuardLine derives `wss://YOUR_HOST/media-stream` from the incoming request's host, so a reverse proxy must preserve the public host and support WebSocket upgrades. Twilio's [incoming-call setup guide](https://www.twilio.com/docs/voice/tutorials/how-to-respond-to-incoming-phone-calls) explains webhook configuration.

For a shared deployment, protect the dashboard and `/api` with authentication at the reverse proxy, and validate Twilio requests at the public ingress. Call transcripts and verification facts are private data. The configured ntfy integration publishes without authentication, so use a topic whose access is appropriate for that information.

## API

The dashboard uses these JSON endpoints. Call records include the outcome, `confidence_score`, `risk_reasoning`, and a JSON-encoded `transcript` when available.

| Method | Path | Purpose / request body |
| --- | --- | --- |
| GET | `/api/calls` | Call history, newest first; optional `?limit=N`. |
| GET | `/api/calls/:id` | One call record. |
| GET | `/api/stats` | Total calls and counts by outcome. |
| GET | `/api/whitelist` | Trusted numbers. |
| POST | `/api/whitelist` | Add or replace a number: `phone_number`, `name`, optional `relationship`. |
| DELETE | `/api/whitelist/:id` | Remove a trusted entry. |
| GET | `/api/security-context` | Saved verification facts. |
| POST | `/api/security-context` | Add a fact: `fact`. |
| DELETE | `/api/security-context/:id` | Remove a fact. |
| GET | `/api/alerts/config` | Configured topic and recipient name. |
| POST | `/api/alerts/test` | Request a test push alert. |

Missing records return 404; missing required fields on create requests return 400. `GET /health` returns `{ "status": "ok" }` and does not check external providers. The test-alert endpoint acknowledges the send attempt; confirm receipt on the subscribed device.

## Project structure

```text
src/
  index.ts          Express, server startup, shutdown
  config.ts         Environment loading and validation
  twilio.ts         Incoming calls and trusted-number checks
  twiml.ts          Stream and forwarding instructions
  ws-handler.ts     Audio bridge, screening loop, call control
  voice-session.ts  Per-call state, transcripts, voice prompt
  screener.ts       Text-model request and decision parsing
  db.ts             SQLite schema and queries
  api.ts            Dashboard REST endpoints
  alerts.ts         ntfy notification delivery
  types.ts          Shared record and decision types
public/             Dashboard HTML, CSS, and JavaScript
tests/              Unit and HTTP/database integration tests
```

## Tests

```sh
npm test
npm run test:watch
npm run typecheck
```

Vitest covers configuration, session state, receptionist instructions, screening-response parsing and retry behavior, SQLite queries, incoming-call routing, REST endpoints, health responses, and notification payloads. Model and notification requests are mocked; tests exercise application behavior rather than measure a model's accuracy at identifying scams. Live audio, actual forwarding, and push delivery need a test call with configured provider accounts.

## Contributors

Repository owner: [Ryan Ding](https://github.com/RyanFDing). Contributor: [Raahil Russell](https://github.com/RaahilRussell).
