from django.contrib import admin

from .models import IntegrityEvent, VisionCalibration


@admin.register(IntegrityEvent)
class IntegrityEventAdmin(admin.ModelAdmin):
    list_display = ("interview", "kind", "duration_ms", "occurred_at")
    list_filter = ("kind", "occurred_at")
    search_fields = (
        "interview__candidate_name",
        "interview__candidate_email",
        "interview__role",
    )
    readonly_fields = ("created_at",)


@admin.register(VisionCalibration)
class VisionCalibrationAdmin(admin.ModelAdmin):
    list_display = (
        "interview",
        "model_version",
        "calibrated",
        "sample_count",
        "updated_at",
    )
    list_filter = ("calibrated", "model_version")
    search_fields = ("interview__candidate_name", "interview__role")
