from django.db import models


class IntegrityEvent(models.Model):
    class Kind(models.TextChoices):
        FACE_MISSING = "face_missing", "Face not visible"
        MULTIPLE_FACES = "multiple_faces", "Multiple faces visible"
        GAZE_AWAY = "gaze_away", "Attention moved away"
        TAB_HIDDEN = "tab_hidden", "Tab hidden"
        WINDOW_BLUR = "window_blur", "Window lost focus"
        FULLSCREEN_EXIT = "fullscreen_exit", "Fullscreen exited"
        CAMERA_OFF = "camera_off", "Camera unavailable"
        MICROPHONE_OFF = "microphone_off", "Microphone unavailable"
        BODY_NOT_FRAMED = "body_not_framed", "Upper body not framed"
        HANDS_NOT_VISIBLE = "hands_not_visible", "Hands not visible"
        CAMERA_BLURRY = "camera_blurry", "Camera image blurry"
        LOW_LIGHT = "low_light", "Lighting too low"
        EXCESSIVE_MOTION = "excessive_motion", "Framing movement too high"
        VISION_UNAVAILABLE = "vision_unavailable", "Local vision model unavailable"

    interview = models.ForeignKey(
        "interviews.InterviewSession",
        on_delete=models.CASCADE,
        related_name="integrity_events",
    )
    kind = models.CharField(max_length=40, choices=Kind.choices)
    duration_ms = models.PositiveIntegerField(default=0)
    details = models.JSONField(default=dict, blank=True)
    occurred_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["occurred_at"]
