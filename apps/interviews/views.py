import hashlib
import json
import logging
import os
import secrets
from datetime import datetime, timezone as dt_timezone

import httpx
from django.conf import settings
from django.core.cache import cache
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.utils import timezone
from django.views.decorators.http import require_GET, require_POST

from apps.vision.models import IntegrityEvent
from apps.resumes.services import ResumeError, validate_and_extract_resume

from .models import InterviewSession
from .services import (
    fallback_question,
    generate_discussion_summary,
    generate_next_question,
    realtime_instructions,
)

logger = logging.getLogger(__name__)


def _openai_api_key():
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key or "replace-with" in key.lower() or key.lower() in {"changeme", "your-key"}:
        return ""
    return key


def _payload(request):
    if request.content_type and request.content_type.startswith("multipart/form-data"):
        data = request.POST.dict()
        for key in ("consent", "realtime"):
            if key in data:
                data[key] = str(data[key]).lower() in {"1", "true", "yes", "on"}
        return data
    try:
        return json.loads(request.body or "{}")
    except json.JSONDecodeError:
        return {}


def _error(message, status=400):
    return JsonResponse({"ok": False, "error": message}, status=status)


@require_GET
def index(request):
    return render(
        request,
        "interview/index.html",
        {
            "question_count": settings.INTERVIEW_QUESTION_COUNT,
            "openai_model": settings.OPENAI_MODEL,
            "realtime_model": settings.OPENAI_REALTIME_MODEL,
            "realtime_available": bool(_openai_api_key()),
            "access_code_required": bool(settings.INTERVIEW_ACCESS_CODE),
            "max_minutes": settings.INTERVIEW_MAX_MINUTES,
        },
    )


@require_POST
def start_interview(request):
    data = _payload(request)
    client_ip = request.META.get("REMOTE_ADDR", "unknown")
    rate_key = f"interview-start:{client_ip}"
    cache.add(rate_key, 0, timeout=3600)
    try:
        attempts = cache.incr(rate_key)
    except ValueError:
        cache.set(rate_key, 1, timeout=3600)
        attempts = 1
    if attempts > settings.INTERVIEW_STARTS_PER_HOUR:
        return _error(
            "Too many interview sessions were started from this device. Try again later.",
            429,
        )
    if settings.INTERVIEW_ACCESS_CODE and not secrets.compare_digest(
        str(data.get("access_code", "")),
        settings.INTERVIEW_ACCESS_CODE,
    ):
        return _error("The interview access code is invalid.", 403)
    name = str(data.get("name", "")).strip()[:120]
    role = str(data.get("role", "")).strip()[:160]
    email = str(data.get("email", "")).strip()[:254]
    level = str(data.get("level", "mid")).strip()[:40]
    mode = str(data.get("mode", InterviewSession.Mode.INTERVIEW))
    if mode not in InterviewSession.Mode.values:
        mode = InterviewSession.Mode.INTERVIEW
    response_language = str(data.get("response_language", "auto"))
    allowed_languages = {
        "auto", "english", "hindi", "spanish", "french", "german", "japanese"
    }
    if response_language not in allowed_languages:
        response_language = "auto"
    wants_realtime = data.get("realtime") is True
    if not name or not role:
        return _error("Your name and target role are required.")
    if data.get("consent") is not True:
        return _error("Camera and monitoring consent is required to continue.")

    now = timezone.now()
    resume_file = request.FILES.get("resume")
    resume_text = ""
    if resume_file:
        try:
            resume_text = validate_and_extract_resume(resume_file)
        except ResumeError as exc:
            return _error(str(exc))

    interview = InterviewSession.objects.create(
        candidate_name=name,
        candidate_email=email,
        role=role,
        level=level,
        mode=mode,
        response_language=response_language,
        resume=resume_file or "",
        resume_original_name=(resume_file.name[:255] if resume_file else ""),
        resume_text=resume_text,
        consented_at=now,
        started_at=now,
        status=InterviewSession.Status.ACTIVE,
    )
    if wants_realtime:
        question = fallback_question(interview.role, 0)
        return JsonResponse(
            {
                "ok": True,
                "interview_id": str(interview.id),
                "question": question,
                "question_number": 1,
                "question_count": settings.INTERVIEW_QUESTION_COUNT,
                "source": "realtime",
                "realtime_available": bool(_openai_api_key()),
                "resume_name": interview.resume_original_name,
                "mode": interview.mode,
            }
        )

    question, used_ai = generate_next_question(interview)
    interview.transcript = [
        {
            "speaker": "interviewer",
            "text": question,
            "at": now.isoformat(),
            "source": "openai" if used_ai else "local",
        }
    ]
    interview.current_question = 1
    interview.save(
        update_fields=["transcript", "current_question", "updated_at"]
    )
    return JsonResponse(
        {
            "ok": True,
            "interview_id": str(interview.id),
            "question": question,
            "question_number": 1,
            "question_count": settings.INTERVIEW_QUESTION_COUNT,
            "source": "openai" if used_ai else "local",
        }
    )


@require_POST
def submit_answer(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    if interview.status != InterviewSession.Status.ACTIVE:
        return _error("This interview is no longer active.", 409)

    data = _payload(request)
    answer = str(data.get("answer", "")).strip()
    if len(answer) < 8:
        return _error("Please give a fuller answer before continuing.")
    if len(answer) > 12000:
        return _error("The answer is too long. Please keep it under 12,000 characters.")

    transcript = list(interview.transcript)
    transcript.append(
        {
            "speaker": "candidate",
            "text": answer,
            "at": timezone.now().isoformat(),
        }
    )
    interview.transcript = transcript
    interview.save(update_fields=["transcript", "updated_at"])

    if interview.current_question >= settings.INTERVIEW_QUESTION_COUNT:
        return JsonResponse(
            {
                "ok": True,
                "complete": True,
                "question_number": interview.current_question,
                "question_count": settings.INTERVIEW_QUESTION_COUNT,
            }
        )

    question, used_ai = generate_next_question(interview)
    transcript = list(interview.transcript)
    transcript.append(
        {
            "speaker": "interviewer",
            "text": question,
            "at": timezone.now().isoformat(),
            "source": "openai" if used_ai else "local",
        }
    )
    interview.current_question += 1
    interview.transcript = transcript
    interview.save(
        update_fields=["transcript", "current_question", "updated_at"]
    )
    return JsonResponse(
        {
            "ok": True,
            "complete": False,
            "question": question,
            "question_number": interview.current_question,
            "question_count": settings.INTERVIEW_QUESTION_COUNT,
            "source": "openai" if used_ai else "local",
        }
    )


@require_POST
def record_event(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    if interview.status != InterviewSession.Status.ACTIVE:
        return _error("Interview is not active.", 409)
    data = _payload(request)
    valid_kinds = {choice for choice, _ in IntegrityEvent.Kind.choices}
    kind = str(data.get("kind", ""))
    if kind not in valid_kinds:
        return _error("Unknown event type.")
    try:
        occurred_at = datetime.fromisoformat(
            str(data.get("occurred_at", "")).replace("Z", "+00:00")
        )
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=dt_timezone.utc)
    except (TypeError, ValueError):
        occurred_at = timezone.now()
    try:
        duration_ms = max(0, min(int(data.get("duration_ms", 0)), 3_600_000))
    except (TypeError, ValueError):
        duration_ms = 0
    raw_details = data.get("details")
    details = raw_details if isinstance(raw_details, dict) else {}
    event = IntegrityEvent.objects.create(
        interview=interview,
        kind=kind,
        duration_ms=duration_ms,
        details={
            key: value
            for key, value in details.items()
            if key in {"face_count", "confidence", "reason"}
        },
        occurred_at=occurred_at,
    )
    return JsonResponse({"ok": True, "event_id": event.id})


@require_POST
def realtime_session(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    if interview.status != InterviewSession.Status.ACTIVE:
        return _error("Interview is not active.", 409)
    api_key = _openai_api_key()
    if not api_key:
        return _error(
            "Live voice is not configured. Replace the example OPENAI_API_KEY in .env with your real project API key, then restart Django.",
            503,
        )
    if request.content_type != "application/sdp":
        return _error("Expected a WebRTC SDP offer.", 415)
    try:
        offer_sdp = request.body.decode("utf-8")
    except UnicodeDecodeError:
        return _error("The WebRTC offer is invalid.")
    if not offer_sdp.startswith("v=0") or len(offer_sdp) > 200_000:
        return _error("The WebRTC offer is invalid.")

    session_config = {
        "type": "realtime",
        "model": settings.OPENAI_REALTIME_MODEL,
        "output_modalities": ["audio"],
        "max_output_tokens": 320,
        "instructions": realtime_instructions(interview),
        "audio": {
            "input": {
                "transcription": {"model": settings.OPENAI_TRANSCRIPTION_MODEL},
                "turn_detection": {
                    "type": "semantic_vad",
                    "eagerness": "high",
                    "create_response": True,
                    "interrupt_response": True,
                },
            },
            "output": {"voice": settings.OPENAI_REALTIME_VOICE},
        },
        "truncation": {
            "type": "retention_ratio",
            "retention_ratio": 0.8,
            "token_limits": {"post_instructions": 8_000},
        },
    }
    safety_identifier = hashlib.sha256(
        f"{interview.id}:{settings.SECRET_KEY}".encode()
    ).hexdigest()
    try:
        with httpx.Client(timeout=30) as client:
            response = client.post(
                "https://api.openai.com/v1/realtime/calls",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "OpenAI-Safety-Identifier": safety_identifier,
                },
                files={
                    "sdp": (None, offer_sdp, "application/sdp"),
                    "session": (
                        None,
                        json.dumps(session_config),
                        "application/json",
                    ),
                },
            )
    except httpx.HTTPError:
        return _error("Could not reach the live interviewer service.", 502)
    if response.status_code >= 400:
        try:
            upstream_error = response.json().get("error", {})
        except (ValueError, AttributeError):
            upstream_error = {}
        error_code = str(upstream_error.get("code", ""))
        logger.warning(
            "Realtime session rejected by OpenAI: status=%s code=%s request_id=%s",
            response.status_code,
            error_code or "unknown",
            response.headers.get("x-request-id", "unavailable"),
        )
        if response.status_code == 401:
            return _error(
                "OpenAI rejected the API key. Update OPENAI_API_KEY in .env and restart Django.",
                503,
            )
        if response.status_code == 403:
            return _error(
                "This OpenAI project cannot access the configured Realtime model. Check project model permissions.",
                503,
            )
        if response.status_code == 429:
            return _error(
                "OpenAI rate or billing limit reached. Check the project usage limit and billing status.",
                503,
            )
        if response.status_code == 400:
            return _error(
                f"OpenAI rejected the Realtime session configuration ({error_code or 'invalid_request'}).",
                502,
            )
        return _error("The live interviewer service is temporarily unavailable.", 502)
    interview.openai_request_count += 1
    interview.save(update_fields=["openai_request_count", "updated_at"])
    return HttpResponse(response.text, content_type="application/sdp")


@require_POST
def save_transcript_turn(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    if interview.status != InterviewSession.Status.ACTIVE:
        return _error("Interview is not active.", 409)
    data = _payload(request)
    speaker = str(data.get("speaker", ""))
    text = str(data.get("text", "")).strip()
    if speaker not in {"candidate", "interviewer"}:
        return _error("Unknown transcript speaker.")
    if not text or len(text) > 12_000:
        return _error("Transcript turn is empty or too long.")
    transcript = list(interview.transcript)
    if (
        transcript
        and transcript[-1].get("speaker") == speaker
        and transcript[-1].get("text") == text
    ):
        return JsonResponse({"ok": True, "duplicate": True})
    transcript.append(
        {
            "speaker": speaker,
            "text": text,
            "at": timezone.now().isoformat(),
            "source": "realtime",
        }
    )
    interview.transcript = transcript
    update_fields = ["transcript", "updated_at"]
    if speaker == "interviewer" and "?" in text:
        interview.current_question += 1
        update_fields.append("current_question")
    interview.save(update_fields=update_fields)
    return JsonResponse(
        {
            "ok": True,
            "turn_count": len(transcript),
            "question_number": interview.current_question,
        }
    )


@require_POST
def complete_interview(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    if interview.status == InterviewSession.Status.COMPLETED:
        return JsonResponse(
            {"ok": True, "summary": interview.discussion_summary}
        )
    if interview.status != InterviewSession.Status.ACTIVE:
        return _error("Interview is not active.", 409)

    counts = {}
    for event in interview.integrity_events.all():
        counts[event.kind] = counts.get(event.kind, 0) + 1
    interview.monitoring_summary = {
        "event_counts": counts,
        "total_events": sum(counts.values()),
        "note": (
            "These are observable browser signals, not proof of misconduct. "
            "Review context before drawing conclusions."
        ),
    }
    summary, used_ai = generate_discussion_summary(interview)
    interview.discussion_summary = summary
    interview.status = InterviewSession.Status.COMPLETED
    interview.completed_at = timezone.now()
    interview.save(
        update_fields=[
            "monitoring_summary",
            "discussion_summary",
            "status",
            "completed_at",
            "updated_at",
        ]
    )
    return JsonResponse(
        {
            "ok": True,
            "summary": summary,
            "monitoring": interview.monitoring_summary,
            "answer_count": sum(
                1
                for item in interview.transcript
                if item.get("speaker") == "candidate"
            ),
            "source": "openai" if used_ai else "local",
        }
    )


@require_GET
def interview_status(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    return JsonResponse(
        {
            "ok": True,
            "id": str(interview.id),
            "status": interview.status,
            "role": interview.role,
            "mode": interview.mode,
            "response_language": interview.response_language,
            "resume_name": interview.resume_original_name,
            "question_number": interview.current_question,
            "question_count": settings.INTERVIEW_QUESTION_COUNT,
            "transcript": interview.transcript,
            "summary": interview.discussion_summary,
            "monitoring": interview.monitoring_summary,
        }
    )

# Create your views here.
