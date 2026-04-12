# GuardLine

An AI-powered phone screening system that intercepts incoming calls on behalf of a protected individual, conducts a real-time voice conversation to assess the caller's identity and intent, and either forwards the call or blocks it — with a push notification to the recipient either way.

Built for people who are frequently targeted by phone scams: elderly adults, people with public phone numbers, or anyone who needs a first line of defense before a call reaches them.

---

## How it works

When someone calls the protected Twilio number:

1. **Whitelist check** — if the caller's number is on the whitelist, the call is forwarded immediately with no screening.
2. **AI receptionist** — otherwise, an OpenAI Realtime API voice agent answers the call. It greets the caller, asks who they're trying to reach, collects their name, and asks the reason for the call — all in natural speech.
3. **Screener** — once the receptionist has enough information, it hands off to a GPT-4o-mini screening pass that analyzes the transcript for scam patterns, identity consistency, and manipulation tactics. The screener can ask follow-up questions (up to 5 rounds) through the receptionist before making a decision.
4. **Decision** — one of four outcomes:
   - **Approved** — legitimate call, forwarded to the recipient's real number.
   - **Blocked** — scam detected, caller is told why and the call is terminated.
   - **Held for review** — uncertain, call is forwarded with a warning alert.
   - **Whitelisted** — bypassed before screening.
5. **Alerts** — a push notification is sent to the recipient's phone via [ntfy.sh](https://ntfy.sh) for every outcome except whitelisted, with the risk reasoning and trust score.

All calls are logged to a local SQLite database and viewable in the web dashboard.

---

## Technical stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript (`tsx`) |
| Web framework | Express 5 |
| Voice infrastructure | Twilio Media Streams (WebSocket, bidirectional μ-law audio) |
| AI voice agent | OpenAI Realtime API (`gpt-4o-mini-realtime-preview`, `server_vad`) |
| Screening engine | OpenAI Chat Completions API (`gpt-4o-mini`, structured JSON output) |
| Speech transcription | Whisper-1 (via OpenAI Realtime `input_audio_transcription`) |
| Database | SQLite via `better-sqlite3` |
| Push notifications | ntfy.sh (no-auth HTTP POST) |
| Frontend | Vanilla JS + CSS, hash-based SPA routing, no build step |
| Tests | Vitest |

### Key design decisions

**Timing constraints** — the AI voice agent enforces a hardcoded 3-second minimum gap between each of its own speech turns and requires at least 0.8 seconds of caller silence before speaking. This is implemented as a polling loop (`scheduleInjection`) that checks both conditions before firing any system instruction into the Realtime session. Without this, the agent rapid-fires questions.

**Dual-model architecture** — the Realtime API handles live audio I/O and conversation flow; a separate `gpt-4o-mini` chat completions call does the security analysis. This keeps screening logic deterministic and auditable (structured JSON) while the voice layer stays natural.

**Phonetic name matching** — the system uses three-tier fuzzy matching to determine whether the caller knew the recipient's name: exact string match → consonant-skeleton substring match (handles fused pronunciations like "rynding" for "Ryan Ding") → sliding-window Levenshtein edit distance at 60% threshold (handles missing trailing consonants). Speech-to-text errors would otherwise cause false negatives on name recognition.

**Security context** — the dashboard allows the recipient to store personal facts (doctor's name, family members, etc.). These are only used as targeted weed-out questions when a caller claims to be a parent, sibling, or close friend — not for every call. A correct answer on a personal fact auto-approves the call.

**Race condition handling** — `response.done` fires before the Whisper transcription completes, so the system uses a `pendingScreeningTrigger` flag to defer screener execution until `conversation.item.input_audio_transcription.completed` fires.

---

## Setup

### Prerequisites

- Node.js 18+
- A [Twilio](https://twilio.com) account with a phone number and Media Streams enabled
- An [OpenAI](https://platform.openai.com) API key with Realtime API access
- A publicly reachable URL for your server (ngrok works for local development)
- The [ntfy app](https://ntfy.sh) on the recipient's phone

### Install

```bash
git clone https://github.com/your-username/guardline.git
cd guardline
npm install
```

### Environment variables

Create a `.env` file in the project root:

```env
# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+15551234567      # your Twilio number

# Who the system is protecting
RECIPIENT_PHONE_NUMBER=+15559876543   # the real phone to forward calls to
RECIPIENT_NAME=Ryan                   # first name used in prompts and alerts

# OpenAI
OPENAI_API_KEY=sk-...

# Push notifications (ntfy.sh topic — pick any unique string)
NTFY_TOPIC=guardline-ryan

# Optional: comma-separated numbers that bypass screening
WHITELIST_NUMBERS=+15550001111,+15550002222

# Optional: override default port
PORT=3000
```

### Twilio configuration

In your Twilio console, configure your phone number's incoming call webhook to:

```
https://your-server.com/voice/incoming
```

Method: `HTTP POST`

Also set the status callback URL to:

```
https://your-server.com/voice/status
```

### ngrok (local development)

```bash
ngrok http 3000
```

Use the `https://xxxx.ngrok.io` URL as your Twilio webhook base.

### Run

```bash
npm run dev       # development (hot reload)
npm start         # production
npm test          # run test suite
```

The dashboard is available at `http://localhost:3000` once the server is running.

---

## Dashboard

The web UI (served from `public/`) has four tabs:

- **Dashboard** — live call history with trust scores, outcomes, and full transcript viewer
- **Whitelist** — add/remove phone numbers that bypass screening entirely
- **Preferences** — manage personal security facts used for identity verification
- **Alerts** — ntfy.sh setup guide and test alert button

---

## API

All endpoints are under `/api`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/calls` | Call history (supports `?limit=N`) |
| `GET` | `/api/calls/:id` | Single call record |
| `GET` | `/api/stats` | Aggregate counts by outcome |
| `GET` | `/api/whitelist` | List whitelist entries |
| `POST` | `/api/whitelist` | Add entry (`phone_number`, `name`, `relationship`) |
| `DELETE` | `/api/whitelist/:id` | Remove entry |
| `GET` | `/api/security-context` | List personal security facts |
| `POST` | `/api/security-context` | Add fact (`fact`) |
| `DELETE` | `/api/security-context/:id` | Remove fact |
| `GET` | `/api/alerts/config` | Current ntfy topic and recipient name |
| `POST` | `/api/alerts/test` | Send a test push notification |

---

## Project structure

```
src/
  index.ts          # Express app setup and server entry point
  config.ts         # Environment variable loading and validation
  twilio.ts         # Incoming call handler, whitelist check
  twiml.ts          # TwiML response builders
  ws-handler.ts     # Twilio WebSocket ↔ OpenAI Realtime bridge, screening loop
  voice-session.ts  # Per-call state, timing fields, system prompt
  screener.ts       # GPT-4o-mini screening analysis
  db.ts             # SQLite schema and query functions
  api.ts            # REST API router
  alerts.ts         # ntfy.sh push notification sender
  types.ts          # Shared TypeScript types

public/
  index.html        # Single-page app (landing + dashboard)
  style.css
  app.js

tests/              # Vitest unit and integration tests
```

---

## License

MIT
