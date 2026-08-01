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
        RESTRICTED_SHORTCUT = "restricted_shortcut", "Restricted shortcut observed"

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


class VisionCalibration(models.Model):
    interview = models.OneToOneField(
        "interviews.InterviewSession",
        on_delete=models.CASCADE,
        related_name="vision_calibration",
    )
    model_version = models.CharField(max_length=50)
    calibrated = models.BooleanField(default=False)
    sample_count = models.PositiveIntegerField(default=0)
    metrics = models.JSONField(default=dict, blank=True)
    windows = models.JSONField(default=list, blank=True)
    feedback = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.interview_id} — {self.model_version}"
