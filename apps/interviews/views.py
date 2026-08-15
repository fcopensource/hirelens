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

from apps.vision.models import IntegrityEvent, VisionCalibration
from apps.resumes.services import ResumeError, validate_and_extract_resume

from .models import InterviewSession
from .services import (
    build_interview_plan,
    fallback_question,
    generate_discussion_summary,
    generate_next_question,
    initial_interview_progress,
    realtime_instructions,
)

logger = logging.getLogger(__name__)

REALTIME_MINI_RATES_PER_MILLION = {
    "text_input": 0.60,
    "text_cached": 0.06,
    "text_output": 2.40,
    "audio_input": 10.00,
    "audio_cached": 0.30,
    "audio_output": 20.00,
}


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
            "default_minutes": settings.INTERVIEW_DEFAULT_MINUTES,
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
    interview_type = str(data.get("interview_type", InterviewSession.InterviewType.JOB))
    if interview_type not in InterviewSession.InterviewType.values:
        interview_type = InterviewSession.InterviewType.JOB
    mode = str(data.get("mode", InterviewSession.Mode.INTERVIEW))
    if mode not in InterviewSession.Mode.values:
        mode = InterviewSession.Mode.INTERVIEW
    response_language = str(data.get("response_language", "auto"))
    allowed_languages = {
        "auto", "english", "hindi", "spanish", "french", "german", "japanese"
    }
    if response_language not in allowed_languages:
        response_language = "auto"
    if interview_type == InterviewSession.InterviewType.IELTS:
        response_language = "english"
    interviewer_style = str(data.get("interviewer_style", InterviewSession.InterviewerStyle.FEMALE))
    if interviewer_style not in InterviewSession.InterviewerStyle.values:
        interviewer_style = InterviewSession.InterviewerStyle.FEMALE
    try:
        requested_minutes = int(data.get("planned_minutes", settings.INTERVIEW_DEFAULT_MINUTES))
    except (TypeError, ValueError):
        requested_minutes = settings.INTERVIEW_DEFAULT_MINUTES
    if requested_minutes not in {8, 12, 20}:
        requested_minutes = settings.INTERVIEW_DEFAULT_MINUTES
    planned_minutes = max(5, min(requested_minutes, settings.INTERVIEW_MAX_MINUTES))
    wants_realtime = data.get("realtime") is True
    if not name or not role:
        return _error("Your name and session focus are required.")
    if data.get("consent") is not True:
        return _error("Camera and monitoring consent is required to continue.")

    now = timezone.now()
    resume_file = (
        request.FILES.get("resume")
        if interview_type == InterviewSession.InterviewType.JOB
        else None
    )
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
        interview_type=interview_type,
        level=level,
        mode=mode,
        response_language=response_language,
        interviewer_style=interviewer_style,
        planned_minutes=planned_minutes,
        resume=resume_file or "",
        resume_original_name=(resume_file.name[:255] if resume_file else ""),
        resume_text=resume_text,
        consented_at=now,
        started_at=now,
        status=InterviewSession.Status.ACTIVE,
        interview_plan=build_interview_plan(interview_type),
        interview_progress=initial_interview_progress(interview_type),
    )
    if wants_realtime:
        question = fallback_question(interview.role, 0, interview.interview_type)
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
                "interview_type": interview.interview_type,
                "interviewer_style": interview.interviewer_style,
                "interviewer_name": (
                    "Arjun"
                    if interview.interviewer_style == InterviewSession.InterviewerStyle.MALE
                    else "Maya"
                ),
                "max_minutes": interview.planned_minutes,
                "interview_plan": interview.interview_plan,
                "interview_progress": interview.interview_progress,
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
            "max_minutes": interview.planned_minutes,
            "interviewer_style": interview.interviewer_style,
            "interview_type": interview.interview_type,
            "interview_plan": interview.interview_plan,
            "interview_progress": interview.interview_progress,
        }
    )


@require_POST
def update_interview_progress(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    if interview.status != InterviewSession.Status.ACTIVE:
        return _error("Interview is not active.", 409)

    data = _payload(request)
    requested_stage = str(data.get("stage", "")).strip().lower()
    note = " ".join(str(data.get("note", "")).split())[:240]
    plan = interview.interview_plan or build_interview_plan(interview.interview_type)
    stage_ids = [stage["id"] for stage in plan]
    if requested_stage not in stage_ids:
        return _error("Unknown interview stage.")

    progress = (
        dict(interview.interview_progress)
        if isinstance(interview.interview_progress, dict)
        else initial_interview_progress()
    )
    current_stage = progress.get("current_stage", stage_ids[0])
    if current_stage not in stage_ids:
        current_stage = stage_ids[0]
    current_index = stage_ids.index(current_stage)
    requested_index = stage_ids.index(requested_stage)
    if requested_index < current_index:
        return _error("Interview stages cannot move backwards.", 409)
    if requested_index > current_index + 1:
        return _error("Complete the current stage before advancing.", 409)

    completed = [stage for stage in progress.get("completed_stages", []) if stage in stage_ids]
    history = list(progress.get("history", []))
    if requested_index == current_index + 1:
        if current_stage not in completed:
            completed.append(current_stage)
        history.append(
            {
                "from": current_stage,
                "to": requested_stage,
                "note": note,
                "at": timezone.now().isoformat(),
            }
        )
        current_stage = requested_stage

    progress = {
        "current_stage": current_stage,
        "completed_stages": completed,
        "history": history[-12:],
    }
    interview.interview_progress = progress
    interview.save(update_fields=["interview_progress", "updated_at"])
    return JsonResponse({"ok": True, "progress": progress})


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
    safe_details = {
        key: value
        for key, value in details.items()
        if key in {"face_count", "confidence", "reason", "countdown_seconds"}
    }
    if "shortcut" in details:
        safe_details["shortcut"] = str(details["shortcut"])[:80]
    if "reason" in safe_details:
        safe_details["reason"] = str(safe_details["reason"])[:240]
    event = IntegrityEvent.objects.create(
        interview=interview,
        kind=kind,
        duration_ms=duration_ms,
        details=safe_details,
        occurred_at=occurred_at,
    )
    return JsonResponse({"ok": True, "event_id": event.id})


@require_POST
def record_vision_calibration(request, interview_id):
    interview = get_object_or_404(InterviewSession, id=interview_id)
    if interview.status != InterviewSession.Status.ACTIVE:
        return _error("Interview is not active.", 409)
    data = _payload(request)
    model_version = "".join(
        character
        for character in str(data.get("model_version", "adaptive-local-v1"))[:50]
        if character.isalnum() or character in {".", "-", "_"}
    )
    if not model_version:
        return _error("Vision model version is required.")
    action = str(data.get("action", "window"))
    if action not in {"calibrated", "window", "feedback", "complete"}:
        return _error("Unknown calibration action.")

    metric_limits = {
        "face_presence_ratio": 1.0,
        "shoulder_presence_ratio": 1.0,
        "posture_alignment_ratio": 1.0,
        "hand_presence_ratio": 1.0,
        "gaze_stability_ratio": 1.0,
        "clarity_ratio": 1.0,
        "calibration_confidence": 1.0,
        "movement_score": 1.0,
        "average_fps": 120.0,
        "tracking_confidence": 1.0,
        "current_face_count": 2.0,
        "current_hand_count": 2.0,
        "upper_body_visible": 1.0,
        "current_gaze_aligned": 1.0,
    }
    raw_metrics = data.get("metrics")
    raw_metrics = raw_metrics if isinstance(raw_metrics, dict) else {}
    metrics = {}
    for key, maximum in metric_limits.items():
        try:
            value = float(raw_metrics.get(key))
        except (TypeError, ValueError):
            continue
        if value != value or value in {float("inf"), float("-inf")}:
            continue
        metrics[key] = round(max(0.0, min(value, maximum)), 4)
    try:
        sample_count = max(0, min(int(data.get("sample_count", 0)), 10_000_000))
    except (TypeError, ValueError):
        sample_count = 0

    calibration, _ = VisionCalibration.objects.get_or_create(
        interview=interview,
        defaults={"model_version": model_version},
    )
    calibration.model_version = model_version
    calibration.sample_count = max(calibration.sample_count, sample_count)
    calibration.metrics = metrics
    if action == "calibrated":
        calibration.calibrated = True

    windows = list(calibration.windows) if isinstance(calibration.windows, list) else []
    if action in {"calibrated", "window", "complete"}:
        windows.append(
            {
                "action": action,
                "at": timezone.now().isoformat(),
                "sample_count": sample_count,
                "metrics": metrics,
            }
        )
        calibration.windows = windows[-240:]

    feedback = (
        dict(calibration.feedback)
        if isinstance(calibration.feedback, dict)
        else {}
    )
    if action == "feedback":
        cue_kind = str(data.get("cue_kind", ""))
        valid_cues = {
            IntegrityEvent.Kind.FACE_MISSING,
            IntegrityEvent.Kind.MULTIPLE_FACES,
            IntegrityEvent.Kind.GAZE_AWAY,
            IntegrityEvent.Kind.BODY_NOT_FRAMED,
            IntegrityEvent.Kind.HANDS_NOT_VISIBLE,
            IntegrityEvent.Kind.CAMERA_BLURRY,
            IntegrityEvent.Kind.LOW_LIGHT,
            IntegrityEvent.Kind.EXCESSIVE_MOTION,
        }
        if cue_kind not in valid_cues:
            return _error("Unknown coaching cue.")
        key = f"incorrect:{cue_kind}"
        feedback[key] = min(int(feedback.get(key, 0)) + 1, 10_000)
        feedback["last_at"] = timezone.now().isoformat()
        calibration.feedback = feedback

    calibration.save()
    return JsonResponse(
        {
            "ok": True,
            "calibrated": calibration.calibrated,
            "sample_count": calibration.sample_count,
        }
    )


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

    interview_plan = interview.interview_plan or build_interview_plan(
        interview.interview_type
    )
    session_config = {
        "type": "realtime",
        "model": settings.OPENAI_REALTIME_MODEL,
        "output_modalities": ["audio"],
        "max_output_tokens": 640,
        "reasoning": {"effort": "low"},
        "instructions": realtime_instructions(interview),
        "tools": [
            {
                "type": "function",
                "name": "update_interview_stage",
                "description": (
                    "Advance the structured interview by exactly one stage after "
                    "enough relevant evidence has been collected. Never use visual "
                    "or monitoring signals as evidence."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "stage": {
                            "type": "string",
                            "enum": [stage["id"] for stage in interview_plan],
                            "description": "The next interview stage.",
                        },
                        "note": {
                            "type": "string",
                            "maxLength": 240,
                            "description": "A short neutral note about topic coverage, without scoring.",
                        },
                    },
                    "required": ["stage", "note"],
                    "additionalProperties": False,
                },
            }
        ],
        "tool_choice": "auto",
        "audio": {
            "input": {
                "transcription": {"model": settings.OPENAI_TRANSCRIPTION_MODEL},
                "turn_detection": {
                    "type": "semantic_vad",
                    "eagerness": "medium",
                    # Keep VAD for natural turn detection, but let the browser
                    # start the next response only after transcription and the
                    # current interviewer turn have both finished.
                    "create_response": False,
                    # Brief noise or echo must not cancel the interviewer's
                    # sentence.
                    "interrupt_response": False,
                },
            },
            "output": {
                "voice": (
                    settings.OPENAI_REALTIME_VOICE_MALE
                    if interview.interviewer_style == InterviewSession.InterviewerStyle.MALE
                    else settings.OPENAI_REALTIME_VOICE_FEMALE
                )
            },
        },
        "truncation": {
            "type": "retention_ratio",
            "retention_ratio": 0.7,
            "token_limits": {"post_instructions": 3_000},
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

    data = _payload(request)
    completion_reason = str(data.get("completion_reason", "candidate_ended"))
    if completion_reason not in {"candidate_ended", "time_limit", "integrity_timeout"}:
        completion_reason = "candidate_ended"
    raw_realtime_usage = data.get("realtime_usage")
    raw_realtime_usage = (
        raw_realtime_usage if isinstance(raw_realtime_usage, dict) else {}
    )
    allowed_usage = {
        "input_text_tokens",
        "input_audio_tokens",
        "cached_text_tokens",
        "cached_audio_tokens",
        "output_text_tokens",
        "output_audio_tokens",
        "responses",
    }
    realtime_usage = {}
    for key in allowed_usage:
        try:
            realtime_usage[key] = max(
                0,
                min(int(raw_realtime_usage.get(key, 0)), 100_000_000),
            )
        except (TypeError, ValueError):
            realtime_usage[key] = 0
    if any(realtime_usage.values()):
        input_text = realtime_usage["input_text_tokens"]
        input_audio = realtime_usage["input_audio_tokens"]
        cached_text = min(realtime_usage["cached_text_tokens"], input_text)
        cached_audio = min(realtime_usage["cached_audio_tokens"], input_audio)
        realtime_usage["model"] = settings.OPENAI_REALTIME_MODEL
        if "gpt-realtime-2.1-mini" in settings.OPENAI_REALTIME_MODEL:
            estimated = (
                (input_text - cached_text) * REALTIME_MINI_RATES_PER_MILLION["text_input"]
                + cached_text * REALTIME_MINI_RATES_PER_MILLION["text_cached"]
                + (input_audio - cached_audio) * REALTIME_MINI_RATES_PER_MILLION["audio_input"]
                + cached_audio * REALTIME_MINI_RATES_PER_MILLION["audio_cached"]
                + realtime_usage["output_text_tokens"] * REALTIME_MINI_RATES_PER_MILLION["text_output"]
                + realtime_usage["output_audio_tokens"] * REALTIME_MINI_RATES_PER_MILLION["audio_output"]
            ) / 1_000_000
            realtime_usage["estimated_usd"] = round(estimated, 6)
            realtime_usage["estimate_note"] = (
                "Realtime response-token estimate; transcription charges are excluded."
            )
        ai_usage = (
            dict(interview.ai_usage)
            if isinstance(interview.ai_usage, dict)
            else {}
        )
        ai_usage["realtime"] = realtime_usage
        interview.ai_usage = ai_usage

    counts = {}
    for event in interview.integrity_events.all():
        counts[event.kind] = counts.get(event.kind, 0) + 1
    interview.monitoring_summary = {
        "event_counts": counts,
        "total_events": sum(counts.values()),
        "completion_reason": completion_reason,
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
            "ai_usage",
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
            "ai_usage": interview.ai_usage,
            "interview_plan": interview.interview_plan,
            "interview_progress": interview.interview_progress,
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
            "interview_type": interview.interview_type,
            "mode": interview.mode,
            "response_language": interview.response_language,
            "planned_minutes": interview.planned_minutes,
            "resume_name": interview.resume_original_name,
            "question_number": interview.current_question,
            "question_count": settings.INTERVIEW_QUESTION_COUNT,
            "transcript": interview.transcript,
            "summary": interview.discussion_summary,
            "monitoring": interview.monitoring_summary,
            "ai_usage": interview.ai_usage,
        }
    )

# Create your views here.
