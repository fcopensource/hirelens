from django.urls import path

from . import views

app_name = "interviews"

urlpatterns = [
    path("", views.index, name="index"),
    path("api/interviews/start/", views.start_interview, name="start"),
    path(
        "api/interviews/<uuid:interview_id>/answer/",
        views.submit_answer,
        name="answer",
    ),
    path(
        "api/interviews/<uuid:interview_id>/event/",
        views.record_event,
        name="event",
    ),
    path(
        "api/interviews/<uuid:interview_id>/events/",
        views.record_event,
        name="events",
    ),
    path(
        "api/interviews/<uuid:interview_id>/calibration/",
        views.record_vision_calibration,
        name="calibration",
    ),
    path(
        "api/interviews/<uuid:interview_id>/realtime/",
        views.realtime_session,
        name="realtime",
    ),
    path(
        "api/interviews/<uuid:interview_id>/transcript/",
        views.save_transcript_turn,
        name="transcript",
    ),
    path(
        "api/interviews/<uuid:interview_id>/complete/",
        views.complete_interview,
        name="complete",
    ),
    path(
        "api/interviews/<uuid:interview_id>/",
        views.interview_status,
        name="status",
    ),
]
