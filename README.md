# HireLens

> A realtime, AI-powered interview practice room that turns a candidate's resume into a natural, voice-first mock interview — with privacy-conscious local coaching and human-centered reporting.

HireLens is a Django application for practicing interviews in a realistic live room. A conversational AI interviewer leads an adaptive discussion based on the candidate's uploaded resume, while the browser provides optional, consent-based camera guidance for framing, attention, posture, lighting, and clarity. The result is a practical environment for preparation and reflection, not an automated hiring decision system.

## Why HireLens?

Interview preparation usually happens in isolation: candidates rehearse answers without context, feedback arrives too late, and generic prompts fail to reflect their actual experience. HireLens brings the important pieces together:

- **Resume-aware conversation** — upload a PDF, DOCX, or TXT resume (up to 5 MB) to ground questions in the candidate's own experience.
- **Realtime voice interviewing** — use the OpenAI Realtime API for fast, interruptible, natural conversation.
- **Two purposeful modes** — choose a realistic interview simulation or a multilingual practice-and-learn session.
- **Graceful fallback paths** — continue with local questions, typed responses, and browser speech when live voice is unavailable.
- **Helpful, local visual coaching** — get immediate camera and presentation guidance without uploading raw video frames or landmarks.
- **Neutral recap, not a verdict** — generate a discussion recap for human review; HireLens does not score, rank, or make hiring recommendations.

## Experience at a glance

```text
Candidate opens HireLens
        ↓
Camera + microphone preflight
        ↓
Resume upload and interview preferences
        ↓
Live voice interview with Maya
        ↓
Optional local camera guidance during the conversation
        ↓
Neutral discussion recap for reflection or human review
```

The interview room uses an equal split-call layout for the candidate and Maya, the speaking 3D interviewer. Candidates can choose an 8-, 12-, or 20-minute session budget.

## Key features

### Resume-aware AI interviews

HireLens extracts text from PDF, DOCX, and TXT files and uses it as **untrusted background context** for interview preparation. This helps the interviewer ask grounded follow-ups while protecting against instruction-like content embedded in uploaded documents.

### Natural voice conversation

The live room uses WebRTC with the OpenAI Realtime API to support responsive, conversational speech. Candidates can interrupt naturally instead of waiting for a turn-based prompt cycle.

If a realtime connection cannot be used, HireLens still supports text input, browser speech, and local interview questions so a practice session can continue.

### Practice that adapts to the candidate

The app supports:

- A realistic interview mode
- A practice-and-learn mode
- Multilingual conversation
- Interview-type and interviewer-style preferences
- Planned session durations
- Resume-informed question selection

### Privacy-conscious local camera guidance

Visual guidance runs in the browser using MediaPipe. It progressively loads models for:

- Face and iris direction
- Blink signals
- Upper-body posture
- Hand landmarks and natural movement
- Lighting and image-blur checks

The application first learns a short, per-session camera baseline and evaluates sustained rolling windows rather than reacting to a single frame. Candidates can use a **Not accurate** control to flag misleading prompts.

HireLens stores event metadata, aggregate calibration ratios, and explicit false-prompt feedback. It does **not** upload raw frames or raw landmarks.

### Transparent session signals

The live room provides a local tracking HUD and persistent landmark overlay to help candidates correct their own framing. It can also record observable browser events such as tab hiding, focus loss, and fullscreen exits.

These signals are context for a human conversation — not proof of misconduct and never an automatic employment decision.

### Cost-aware by design

HireLens keeps the paid API key on the server and includes controls to help manage usage:

- Realtime calls use `gpt-realtime-2.1-mini`
- Recaps and non-realtime fallback use `gpt-5.6-luna`
- Default session length: 12 minutes
- Candidate-selectable session lengths: 8, 12, or 20 minutes
- Rate limiting for interview starts
- A cap on non-realtime model requests
- Output-length limits
- Live Realtime token-usage and cost estimation

> The displayed Realtime estimate excludes separate transcription charges.

## Technology

| Area | Implementation |
| --- | --- |
| Backend | Django 6 |
| AI | OpenAI Realtime API and OpenAI API |
| Realtime transport | WebRTC |
| Vision guidance | MediaPipe in the browser |
| Frontend visuals | Three.js and browser media APIs |
| Databases | SQLite locally; PostgreSQL via `DATABASE_URL`; MySQL for Hostinger VPS |
| Deployment | Render Blueprint, Docker, Procfile, or Hostinger VPS |
| Testing | Django test suite and GitHub Actions workflow |

## Quick start

### Prerequisites

- Python 3.13
- An OpenAI API key
- Camera and microphone permissions for the full interview experience

### Install

```bash
git clone https://github.com/fcopensource/hirelens.git
cd hirelens

python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
```

Update `.env` with your local configuration. At minimum, provide a valid `OPENAI_API_KEY` and replace the Django secret key.

### Run locally

```bash
python manage.py migrate
python manage.py runserver
```

Then open [http://127.0.0.1:8000](http://127.0.0.1:8000).

Camera and microphone access require HTTPS in production. Browsers allow `localhost` for development.

## Configuration

Start with [`.env.example`](.env.example). The most important variables are:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI credential. Never expose it to browser code. |
| `OPENAI_REALTIME_MODEL` | Realtime model; defaults to `gpt-realtime-2.1-mini`. |
| `OPENAI_MODEL` | Model for recaps and fallback operations; defaults to `gpt-5.6-luna`. |
| `OPENAI_REALTIME_VOICE_FEMALE` / `OPENAI_REALTIME_VOICE_MALE` | Voice configuration for the AI interviewer. |
| `INTERVIEW_DEFAULT_MINUTES` | Default session duration. |
| `INTERVIEW_MAX_MINUTES` | Maximum session duration. |
| `INTERVIEW_STARTS_PER_HOUR` | Per-hour interview-start limit. |
| `OPENAI_MAX_REQUESTS_PER_INTERVIEW` | Cap for non-realtime AI calls in a session. |
| `INTERVIEW_ACCESS_CODE` | Strongly recommended for public deployments to protect API spend. |
| `DATABASE_URL` | PostgreSQL connection string for supported hosts. |
| `DJANGO_ALLOWED_HOSTS` | Comma-separated production hosts. |
| `CSRF_TRUSTED_ORIGINS` | HTTPS origins trusted by Django's CSRF protection. |

### MySQL on Hostinger

For Hostinger MySQL, configure all of the following:

```env
DB_NAME=
DB_USER=
DB_PASSWORD=
DB_HOST=
DB_PORT=3306
```

When all five are supplied, they take precedence over `DATABASE_URL`. MySQL connections use UTF-8 and strict transactional mode.

## Deployment

### Render

This repository includes a [`render.yaml`](render.yaml) Blueprint for Render with managed PostgreSQL. Set the following secrets in the Render dashboard:

- `OPENAI_API_KEY`
- `OPENAI_REALTIME_MODEL`
- `OPENAI_REALTIME_VOICE`
- `OPENAI_REALTIME_VOICE_FEMALE`
- `OPENAI_REALTIME_VOICE_MALE`
- `DJANGO_ALLOWED_HOSTS`
- `CSRF_TRUSTED_ORIGINS`
- `INTERVIEW_ACCESS_CODE`

### Docker and other Python hosts

A `Dockerfile` and `Procfile` are included for Docker-capable and conventional Python hosting environments.

### Hostinger

Use a **VPS** for production deployment rather than Hostinger Web or Cloud Hosting. The repository includes a systemd service, Nginx configuration, update script, and a full deployment checklist in [`HOSTINGER_DEPLOYMENT.md`](HOSTINGER_DEPLOYMENT.md).

## Browser support

Use a current version of Chrome, Edge, or Safari over HTTPS. HireLens needs camera and microphone permission for the full experience.

Three.js and MediaPipe assets are loaded from CDNs. If your production environment uses a strict Content Security Policy, allow the required CDN hosts. If browser landmark models fail to load, the interview remains usable with camera and image-clarity checks rather than blocking the candidate.

## Safety, privacy, and responsible use

HireLens is built for practice, reflection, and human-supported review.

- Camera-related checks are observable browser signals, not evidence of misconduct.
- Do not use the application to automatically make, recommend, score, or rank employment decisions.
- Give candidates clear notice, a reasonable accommodation path, retention information, and a way to request human review before production use.
- The calibration data supports threshold tuning and offline validation; it is **not** a biometric training corpus.
- Training a separate employment model requires a representative, consented, labeled dataset, rigorous bias testing, retention controls, and human validation.

## Project structure

```text
apps/
  accounts/       # Account-related app structure
  interviews/     # Interview sessions, orchestration, prompts, and tests
  reports/        # Interview recap and reporting support
  resumes/        # Resume extraction services
  speech/         # Speech-related app structure
  vision/         # Vision calibration and integrity-event models
config/            # Django configuration and URL routing
static/            # Browser-side styles, vision logic, and interview UI
templates/         # Interview-room templates
deploy/hostinger/  # systemd, Nginx, and update configuration
```

## Testing

Run the Django test suite with:

```bash
python manage.py test
```

The repository also includes a GitHub Actions workflow in [`.github/workflows/test.yml`](.github/workflows/test.yml).

## Contributing

Contributions are welcome. For a focused change:

1. Fork the repository and create a descriptive branch.
2. Keep secrets out of commits; use `.env.example` as the configuration reference.
3. Add or update tests for behavioral changes.
4. Run `python manage.py test`.
5. Open a pull request that explains the user impact and any privacy, security, or cost implications.

## License

No license file is currently included. Before reusing, distributing, or contributing code outside this repository, please contact the repository owner to confirm the intended terms.

---

Built to help candidates practice with more context, more clarity, and more agency.
