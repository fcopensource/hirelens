from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("interviews", "0002_interviewsession_mode_and_more"),
        ("vision", "0003_alter_integrityevent_kind"),
    ]

    operations = [
        migrations.CreateModel(
            name="VisionCalibration",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("model_version", models.CharField(max_length=50)),
                ("calibrated", models.BooleanField(default=False)),
                ("sample_count", models.PositiveIntegerField(default=0)),
                ("metrics", models.JSONField(blank=True, default=dict)),
                ("windows", models.JSONField(blank=True, default=list)),
                ("feedback", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "interview",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="vision_calibration",
                        to="interviews.interviewsession",
                    ),
                ),
            ],
        ),
    ]
