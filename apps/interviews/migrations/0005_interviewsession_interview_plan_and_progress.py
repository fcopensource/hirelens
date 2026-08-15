from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("interviews", "0004_interviewsession_interviewer_style"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="interview_plan",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="interviewsession",
            name="interview_progress",
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
