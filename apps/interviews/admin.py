from django.contrib import admin

from .models import InterviewSession


@admin.register(InterviewSession)
class InterviewSessionAdmin(admin.ModelAdmin):
    list_display = (
        "candidate_name",
        "role",
        "level",
        "interviewer_style",
        "status",
        "planned_minutes",
        "current_question",
        "created_at",
    )
    list_filter = ("status", "level", "interviewer_style", "created_at")
    search_fields = ("candidate_name", "candidate_email", "role")
    readonly_fields = (
        "created_at",
        "updated_at",
        "consented_at",
        "started_at",
        "completed_at",
        "openai_request_count",
        "ai_usage",
    )
