from django.contrib import admin

from .models import IntegrityEvent


@admin.register(IntegrityEvent)
class IntegrityEventAdmin(admin.ModelAdmin):
    list_display = ("interview", "kind", "duration_ms", "occurred_at")
    list_filter = ("kind", "occurred_at")
    search_fields = ("interview__candidate_name", "interview__candidate_email")
    readonly_fields = ("created_at",)
