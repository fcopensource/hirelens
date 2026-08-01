from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("interviews", "0003_interviewsession_ai_usage_and_planned_minutes"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="interviewer_style",
            field=models.CharField(
                choices=[("female", "Female — Maya"), ("male", "Male — Arjun")],
                default="female",
                max_length=12,
            ),
        ),
    ]
