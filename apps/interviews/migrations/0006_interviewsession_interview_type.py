from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("interviews", "0005_interviewsession_interview_plan_and_progress"),
    ]

    operations = [
        migrations.AddField(
            model_name="interviewsession",
            name="interview_type",
            field=models.CharField(
                choices=[
                    ("job", "Corporate job"),
                    ("ielts", "IELTS Speaking"),
                    ("speaking", "Speaking practice"),
                    ("viva", "Academic or project viva"),
                ],
                default="job",
                max_length=20,
            ),
        ),
    ]
