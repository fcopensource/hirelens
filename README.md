# HireLens AI Interviewer

HireLens is a Django interview room with a speaking 3D interviewer, a
low-latency OpenAI Realtime voice call, resume-aware questions, multilingual
practice, and consent-based local camera guidance.

## What it does

- Runs a camera and microphone preflight before the session.
- Presents Maya and the candidate in an equal, OmeTV-style split call.
- Uses WebRTC and the OpenAI Realtime API for fast, interruptible conversation.
- Accepts PDF, DOCX, and TXT resumes up to 5 MB and treats their text as
  untrusted background context.
- Includes a realistic interview mode and a practice-and-learn mode with
  multilingual conversation.
- Falls back to local questions, text input, and browser speech when live voice
  is unavailable.
- Uses three MediaPipe models in the browser for face/iris direction, blinking,
  upper-body posture, 21-point hand landmarks, natural movement, lighting, and
  blur guidance. Models load progressively so face tracking starts while body
  and hand tracking finish loading.
- Learns a 10-second per-session camera baseline before coaching, evaluates
  sustained rolling windows instead of single frames, and offers a
  `Not accurate` control for false prompts.
- Records tab hiding, focus loss, and fullscreen exits.
- Stores timestamped event metadata, aggregate calibration ratios, and explicit
  false-prompt feedback. It never uploads raw frames or raw landmarks.
- Can ask Maya to say a brief camera-adjustment message during the call.
- Shows a live local tracking HUD and persistent landmark overlay so candidates
  can correct their own framing immediately.
- Produces a neutral discussion recap for a human reviewer. It does not score,
  rank, or make a hiring recommendation.

## Local setup

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Export the values from `.env` in your shell or load them with your preferred
environment manager, then run:

```bash
python manage.py migrate
python manage.py runserver
```

Open `http://127.0.0.1:8000`. Camera and microphone access require HTTPS in
production; localhost is allowed for development.

For Hostinger MySQL, set `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, and
`DB_PORT`. When all five are present they take precedence over `DATABASE_URL`;
otherwise the project uses `DATABASE_URL` or local SQLite. MySQL connections use
UTF-8 and strict transactional mode.

## Cost controls

Live calls use `gpt-realtime-2.1-mini`; recaps and the non-Realtime fallback use
the cost-focused `gpt-5.6-luna`. The paid API key never enters browser
JavaScript. Sessions default to 12 minutes, candidates can choose an 8, 12, or
20 minute budget, output length is capped, starts are rate-limited, and
non-Realtime model calls are capped. Adjust `INTERVIEW_DEFAULT_MINUTES`,
`INTERVIEW_MAX_MINUTES`,
`INTERVIEW_STARTS_PER_HOUR`, and `OPENAI_MAX_REQUESTS_PER_INTERVIEW` to match
your budget. The live room shows Realtime response-token usage and a cost
estimate; transcription is billed separately and is not included in that
estimate. A public deployment should always set `INTERVIEW_ACCESS_CODE`.

## Deploy today

The included `render.yaml` is ready for a Render Blueprint with managed
PostgreSQL. Set these secrets in the hosting dashboard:

- `OPENAI_API_KEY`
- `OPENAI_REALTIME_MODEL` (defaults to `gpt-realtime-2.1-mini`)
- `OPENAI_REALTIME_VOICE` (legacy/default female voice, defaults to `marin`)
- `OPENAI_REALTIME_VOICE_FEMALE` (defaults to `marin`)
- `OPENAI_REALTIME_VOICE_MALE` (defaults to `cedar`)
- `DJANGO_ALLOWED_HOSTS` (for example, `your-app.onrender.com`)
- `CSRF_TRUSTED_ORIGINS` (for example, `https://your-app.onrender.com`)
- `INTERVIEW_ACCESS_CODE` (strongly recommended to prevent public API spend)

The `Dockerfile` and `Procfile` also support most Python hosting platforms.

For Hostinger, use a VPS rather than Web or Cloud Hosting. The complete
production checklist, systemd unit, Nginx configuration, and safe update
procedure are in [HOSTINGER_DEPLOYMENT.md](HOSTINGER_DEPLOYMENT.md).

## Browser requirements

Use a current Chrome, Edge, or Safari over HTTPS. The app needs camera and
microphone permission. Three.js and MediaPipe assets are loaded from CDNs, so a
strict production Content Security Policy must allow those hosts. If the local
landmark models fail to load, the interview continues with camera and clarity
checks instead of blocking the candidate.

## Responsible use

Monitoring events are observable browser signals, not proof of misconduct.
They must not be used as an automatic hiring decision. Provide candidates with
notice, a reasonable accommodation path, retention information, and a way to
request human review before production use.

The adaptive calibration data is suitable for threshold tuning and offline
validation. It is deliberately not a biometric training corpus. Training a
separate employment model requires a representative, consented, labeled
dataset, bias testing, retention controls, and human validation before use.
