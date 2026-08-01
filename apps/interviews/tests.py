import json
import os
import shutil
import tempfile
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.urls import reverse

from apps.vision.models import IntegrityEvent, VisionCalibration

from .models import InterviewSession


@override_settings(INTERVIEW_QUESTION_COUNT=2)
class InterviewFlowTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls._test_media_root = tempfile.mkdtemp(prefix="hirelens-test-media-")
        cls._media_override = override_settings(MEDIA_ROOT=cls._test_media_root)
        cls._media_override.enable()
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        cls._media_override.disable()
        shutil.rmtree(cls._test_media_root, ignore_errors=True)

    def setUp(self):
        cache.clear()

    def start(self, **overrides):
        payload = {
            "name": "Asha Rao",
            "email": "asha@example.com",
            "role": "Python Engineer",
            "level": "mid",
            "consent": True,
            **overrides,
        }
        return self.client.post(
            reverse("interviews:start"),
            data=payload,
            content_type="application/json",
        )

    def test_home_renders_product(self):
        response = self.client.get(reverse("interviews:index"))
        self.assertContains(response, "A real interview")
        self.assertContains(response, "Add your resume")
        self.assertContains(response, "No automatic cheating or hiring decision")
        self.assertContains(response, "favicon.svg")

    def test_start_requires_consent(self):
        response = self.start(consent=False)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(InterviewSession.objects.count(), 0)

    @patch("apps.interviews.services._client", return_value=None)
    def test_start_applies_candidate_session_budget(self, _mock_client):
        response = self.start(
            realtime=True,
            planned_minutes=8,
            interviewer_style="male",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["max_minutes"], 8)
        interview = InterviewSession.objects.get()
        self.assertEqual(interview.planned_minutes, 8)
        self.assertEqual(interview.interviewer_style, "male")
        self.assertEqual(response.json()["interviewer_name"], "Arjun")

    @patch("apps.interviews.services._client", return_value=None)
    def test_start_rejects_unknown_interviewer_style(self, _mock_client):
        response = self.start(realtime=True, interviewer_style="robot")
        self.assertEqual(response.status_code, 200)
        interview = InterviewSession.objects.get()
        self.assertEqual(interview.interviewer_style, "female")
        self.assertEqual(response.json()["interviewer_name"], "Maya")

    @override_settings(INTERVIEW_DEFAULT_MINUTES=12, INTERVIEW_MAX_MINUTES=20)
    @patch("apps.interviews.services._client", return_value=None)
    def test_start_rejects_unknown_session_budget(self, _mock_client):
        response = self.start(realtime=True, planned_minutes=999)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["max_minutes"], 12)

    @override_settings(INTERVIEW_ACCESS_CODE="invite-42")
    def test_start_requires_configured_access_code(self):
        response = self.start(access_code="wrong")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(InterviewSession.objects.count(), 0)

    @override_settings(INTERVIEW_STARTS_PER_HOUR=1)
    @patch("apps.interviews.services._client", return_value=None)
    def test_start_rate_limit_protects_api_spend(self, _mock_client):
        self.assertEqual(self.start().status_code, 200)
        self.assertEqual(self.start().status_code, 429)

    @patch("apps.interviews.services._client", return_value=None)
    def test_complete_interview_flow_uses_safe_fallback(self, _mock_client):
        response = self.start()
        self.assertEqual(response.status_code, 200)
        started = response.json()
        interview_id = started["interview_id"]
        self.assertEqual(started["source"], "local")

        first = self.client.post(
            reverse("interviews:answer", args=[interview_id]),
            data={"answer": "I led a service migration and reduced failures by forty percent."},
            content_type="application/json",
        )
        self.assertEqual(first.status_code, 200)
        self.assertFalse(first.json()["complete"])

        second = self.client.post(
            reverse("interviews:answer", args=[interview_id]),
            data={"answer": "I investigated logs, tested assumptions, and documented the result."},
            content_type="application/json",
        )
        self.assertTrue(second.json()["complete"])

        completed = self.client.post(
            reverse("interviews:complete", args=[interview_id]),
            data={},
            content_type="application/json",
        )
        self.assertEqual(completed.status_code, 200)
        self.assertIn("not a hiring recommendation", completed.json()["summary"]["notice"])
        self.assertEqual(completed.json()["answer_count"], 2)
        interview = InterviewSession.objects.get(id=interview_id)
        self.assertEqual(interview.status, InterviewSession.Status.COMPLETED)
        self.assertEqual(len(interview.transcript), 4)
        self.assertEqual(
            interview.monitoring_summary["completion_reason"],
            "candidate_ended",
        )

    @patch("apps.interviews.services._client", return_value=None)
    def test_records_only_allowlisted_integrity_event_details(self, _mock_client):
        interview_id = self.start().json()["interview_id"]
        response = self.client.post(
            reverse("interviews:event", args=[interview_id]),
            data={
                "kind": "face_missing",
                "duration_ms": 4200,
                "details": {
                    "face_count": 0,
                    "raw_frame": "must-not-be-stored",
                },
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        event = IntegrityEvent.objects.get()
        self.assertEqual(event.details, {"face_count": 0})

    @patch("apps.interviews.services._client", return_value=None)
    def test_records_restricted_shortcut_without_key_content(self, _mock_client):
        interview_id = self.start().json()["interview_id"]
        response = self.client.post(
            reverse("interviews:event", args=[interview_id]),
            data={
                "kind": "restricted_shortcut",
                "details": {
                    "reason": "restricted_shortcut",
                    "shortcut": "Meta+Tab",
                    "typed_content": "must-not-be-stored",
                },
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        event = IntegrityEvent.objects.get()
        self.assertEqual(
            event.details,
            {"reason": "restricted_shortcut", "shortcut": "Meta+Tab"},
        )

    @patch("apps.interviews.services._client", return_value=None)
    def test_stores_neutral_integrity_timeout_completion_reason(self, _mock_client):
        interview_id = self.start().json()["interview_id"]
        response = self.client.post(
            reverse("interviews:complete", args=[interview_id]),
            data={"completion_reason": "integrity_timeout"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        interview = InterviewSession.objects.get(id=interview_id)
        self.assertEqual(
            interview.monitoring_summary["completion_reason"],
            "integrity_timeout",
        )

    @patch("apps.interviews.services._client", return_value=None)
    def test_plural_integrity_event_route_remains_compatible(self, _mock_client):
        interview_id = self.start().json()["interview_id"]
        response = self.client.post(
            reverse("interviews:events", args=[interview_id]),
            data={"kind": "camera_blurry", "duration_ms": 7000},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(IntegrityEvent.objects.get().kind, "camera_blurry")

    @patch("apps.interviews.services._client", return_value=None)
    def test_rejects_unknown_integrity_event(self, _mock_client):
        interview_id = self.start().json()["interview_id"]
        response = self.client.post(
            reverse("interviews:event", args=[interview_id]),
            data={"kind": "emotion_detected"},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(IntegrityEvent.objects.count(), 0)

    @patch("apps.interviews.services._client", return_value=None)
    def test_stores_only_aggregate_vision_calibration_metrics(self, _mock_client):
        interview_id = self.start().json()["interview_id"]
        response = self.client.post(
            reverse("interviews:calibration", args=[interview_id]),
            data={
                "action": "calibrated",
                "model_version": "adaptive-local-v1",
                "sample_count": 42,
                "metrics": {
                    "face_presence_ratio": 0.96,
                    "shoulder_presence_ratio": 0.82,
                    "hand_presence_ratio": 0.4,
                    "average_fps": 18.2,
                    "raw_landmarks": [[0.1, 0.2]],
                    "frame": "must-not-be-stored",
                },
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        calibration = VisionCalibration.objects.get()
        self.assertTrue(calibration.calibrated)
        self.assertEqual(calibration.sample_count, 42)
        self.assertEqual(
            calibration.metrics,
            {
                "face_presence_ratio": 0.96,
                "shoulder_presence_ratio": 0.82,
                "hand_presence_ratio": 0.4,
                "average_fps": 18.2,
            },
        )
        self.assertNotIn("raw_landmarks", str(calibration.windows))

    @patch("apps.interviews.services._client", return_value=None)
    def test_records_incorrect_coaching_feedback(self, _mock_client):
        interview_id = self.start().json()["interview_id"]
        response = self.client.post(
            reverse("interviews:calibration", args=[interview_id]),
            data={
                "action": "feedback",
                "model_version": "adaptive-local-v1",
                "sample_count": 80,
                "cue_kind": "body_not_framed",
                "metrics": {"shoulder_presence_ratio": 0.91},
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        calibration = VisionCalibration.objects.get()
        self.assertEqual(calibration.feedback["incorrect:body_not_framed"], 1)
        self.assertNotIn("candidate_image", calibration.metrics)

    def test_realtime_start_accepts_and_extracts_text_resume(self):
        resume = SimpleUploadedFile(
            "asha-resume.txt",
            (
                b"Asha Rao\nPython Engineer\nBuilt reliable Django services "
                b"and improved API latency by thirty percent."
            ),
            content_type="text/plain",
        )
        response = self.client.post(
            reverse("interviews:start"),
            data={
                "name": "Asha Rao",
                "email": "asha@example.com",
                "role": "Python Engineer",
                "level": "mid",
                "mode": "practice",
                "response_language": "hindi",
                "consent": "true",
                "realtime": "true",
                "resume": resume,
            },
        )
        self.assertEqual(response.status_code, 200)
        session = InterviewSession.objects.get()
        self.assertEqual(session.mode, InterviewSession.Mode.PRACTICE)
        self.assertEqual(session.response_language, "hindi")
        self.assertEqual(session.resume_original_name, "asha-resume.txt")
        self.assertIn("Django services", session.resume_text)
        self.assertEqual(response.json()["source"], "realtime")

    def test_resume_rejects_unsupported_file_type(self):
        resume = SimpleUploadedFile(
            "resume.exe",
            b"This is deliberately long enough to pass the text length check.",
        )
        response = self.client.post(
            reverse("interviews:start"),
            data={
                "name": "Asha Rao",
                "role": "Python Engineer",
                "level": "mid",
                "consent": "true",
                "realtime": "true",
                "resume": resume,
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("PDF, DOCX, or TXT", response.json()["error"])
        self.assertEqual(InterviewSession.objects.count(), 0)

    @patch.dict(os.environ, {"OPENAI_API_KEY": ""})
    def test_realtime_endpoint_requires_server_api_key(self):
        interview_id = self.start(realtime=True).json()["interview_id"]
        response = self.client.post(
            reverse("interviews:realtime", args=[interview_id]),
            data="v=0\r\nvalid-offer",
            content_type="application/sdp",
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("OPENAI_API_KEY", response.json()["error"])

    @patch.dict(
        os.environ,
        {"OPENAI_API_KEY": "replace-with-your-project-api-key"},
    )
    def test_realtime_endpoint_rejects_placeholder_key_without_upstream_call(self):
        interview_id = self.start(realtime=True).json()["interview_id"]
        response = self.client.post(
            reverse("interviews:realtime", args=[interview_id]),
            data="v=0\r\nvalid-offer",
            content_type="application/sdp",
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("Replace the example", response.json()["error"])

    @patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"})
    @patch("apps.interviews.views.httpx.Client")
    def test_realtime_endpoint_exchanges_sdp_server_side(self, client_class):
        interview_id = self.start(
            realtime=True,
            mode="practice",
            response_language="hindi",
            interviewer_style="male",
        ).json()["interview_id"]
        upstream = MagicMock()
        upstream.status_code = 200
        upstream.text = "v=0\r\nanswer-sdp"
        client_class.return_value.__enter__.return_value.post.return_value = upstream
        response = self.client.post(
            reverse("interviews:realtime", args=[interview_id]),
            data="v=0\r\noffer-sdp",
            content_type="application/sdp",
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content.decode(), "v=0\r\nanswer-sdp")
        call = client_class.return_value.__enter__.return_value.post.call_args
        self.assertEqual(call.args[0], "https://api.openai.com/v1/realtime/calls")
        self.assertNotIn("test-key", response.content.decode())
        self.assertIn("session", call.kwargs["files"])
        session_config = json.loads(call.kwargs["files"]["session"][1])
        self.assertEqual(session_config["audio"]["output"]["voice"], "cedar")
        self.assertIn("You are Arjun", session_config["instructions"])
        session_config = call.kwargs["files"]["session"][1]
        self.assertIn('"type": "semantic_vad"', session_config)
        self.assertIn('"eagerness": "medium"', session_config)
        self.assertIn('"max_output_tokens": 320', session_config)
        self.assertIn('"retention_ratio": 0.7', session_config)
        self.assertIn('"post_instructions": 3000', session_config)

    @patch("apps.interviews.services._client", return_value=None)
    def test_complete_stores_allowlisted_realtime_usage(self, _mock_client):
        interview_id = self.start(realtime=True).json()["interview_id"]
        response = self.client.post(
            reverse("interviews:complete", args=[interview_id]),
            data={
                "realtime_usage": {
                    "input_text_tokens": 100,
                    "input_audio_tokens": 200,
                    "cached_text_tokens": 40,
                    "cached_audio_tokens": 20,
                    "output_text_tokens": 50,
                    "output_audio_tokens": 80,
                    "responses": 3,
                    "raw_audio": "must-not-be-stored",
                }
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        usage = InterviewSession.objects.get().ai_usage["realtime"]
        self.assertEqual(usage["responses"], 3)
        self.assertEqual(usage["model"], "gpt-realtime-2.1-mini")
        self.assertGreater(usage["estimated_usd"], 0)
        self.assertNotIn("raw_audio", usage)

    @patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"})
    @patch("apps.interviews.views.httpx.Client")
    def test_realtime_endpoint_explains_rejected_api_key(self, client_class):
        interview_id = self.start(realtime=True).json()["interview_id"]
        upstream = MagicMock()
        upstream.status_code = 401
        upstream.headers = {"x-request-id": "request-test"}
        upstream.json.return_value = {
            "error": {"code": "invalid_api_key", "message": "masked"}
        }
        client_class.return_value.__enter__.return_value.post.return_value = upstream
        response = self.client.post(
            reverse("interviews:realtime", args=[interview_id]),
            data="v=0\r\noffer-sdp",
            content_type="application/sdp",
        )
        self.assertEqual(response.status_code, 503)
        self.assertIn("rejected the API key", response.json()["error"])

    @patch("apps.interviews.services._client", return_value=None)
    def test_saves_realtime_transcript_turn(self, _mock_client):
        interview_id = self.start(realtime=True).json()["interview_id"]
        response = self.client.post(
            reverse("interviews:transcript", args=[interview_id]),
            data={
                "speaker": "interviewer",
                "text": "Tell me about a Django service you built?",
            },
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        session = InterviewSession.objects.get(id=interview_id)
        self.assertEqual(session.current_question, 1)
        self.assertEqual(session.transcript[0]["source"], "realtime")

# Create your tests here.
