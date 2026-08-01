from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("interviews", "0002_interviewsession_mode_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="ai_usage",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="interviewsession",
            name="planned_minutes",
            field=models.PositiveSmallIntegerField(default=12),
        ),
    ]
