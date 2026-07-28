import uuid

from django.db import models


class InterviewSession(models.Model):
    class Status(models.TextChoices):
        READY = "ready", "Ready"
        ACTIVE = "active", "Active"
        COMPLETED = "completed", "Completed"
        ABANDONED = "abandoned", "Abandoned"

    class Mode(models.TextChoices):
        INTERVIEW = "interview", "Interview"
        PRACTICE = "practice", "Practice and learn"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    candidate_name = models.CharField(max_length=120)
    candidate_email = models.EmailField(blank=True)
    role = models.CharField(max_length=160)
    level = models.CharField(max_length=40, default="mid")
    mode = models.CharField(
        max_length=20, choices=Mode.choices, default=Mode.INTERVIEW
    )
    response_language = models.CharField(max_length=40, default="auto")
    resume = models.FileField(upload_to="resumes/%Y/%m/", blank=True)
    resume_original_name = models.CharField(max_length=255, blank=True)
    resume_text = models.TextField(blank=True)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.READY
    )
    consented_at = models.DateTimeField()
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    current_question = models.PositiveSmallIntegerField(default=0)
    transcript = models.JSONField(default=list, blank=True)
    monitoring_summary = models.JSONField(default=dict, blank=True)
    discussion_summary = models.JSONField(default=dict, blank=True)
    openai_request_count = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.candidate_name} — {self.role}"
