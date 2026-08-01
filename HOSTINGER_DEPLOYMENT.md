# Hostinger deployment

## Supported Hostinger product

HireLens is a Django/Python application. Hostinger Web and Cloud Hosting do not
provide the Python runtime or root access that Django needs. Deploy the
application on a Hostinger VPS (KVM 1 or higher), not on Business Web Hosting.

The existing remote Hostinger MySQL database can remain in use if its remote
access rules allow the VPS IP address.

## Deployment stages

1. **Repository**
   - Keep the GitHub repository private.
   - Never commit `.env`, database exports, uploaded resumes, or API keys.
   - Require the GitHub test workflow to pass before updating production.

2. **VPS and DNS**
   - Create a Hostinger VPS with Ubuntu 24.04.
   - Add an `A` record such as `hirelens.example.com` pointing to the VPS IPv4.
   - Add that domain and HTTPS origin to the Django environment values below.

3. **Application**
   - Clone the repository into `/opt/hirelens`.
   - Create a virtual environment and install `requirements.txt`.
   - Put production secrets in `/opt/hirelens/app/.env` with permissions `600`.
   - Run migrations and collect static assets.

4. **Process and proxy**
   - Install the included systemd service.
   - Install the included Nginx site after replacing `hirelens.example.com`.
   - Enable HTTPS with Certbot.

5. **Verification**
   - Run `python manage.py check --deploy`.
   - Confirm the homepage, camera permission, Realtime connection, transcript
     writes, movement events, interview completion, and a new database row.

## Initial VPS setup

Run these commands from the VPS as a sudo-capable administrator:

```bash
sudo apt update
sudo apt install -y python3-venv python3-dev default-libmysqlclient-dev \
  build-essential pkg-config nginx git certbot python3-certbot-nginx
sudo useradd --system --create-home --home-dir /opt/hirelens \
  --shell /usr/sbin/nologin hirelens
sudo -u hirelens git clone https://github.com/OWNER/hirelens.git /opt/hirelens/app
sudo -u hirelens python3 -m venv /opt/hirelens/venv
sudo -u hirelens /opt/hirelens/venv/bin/pip install -r /opt/hirelens/app/requirements.txt
sudo install -m 600 -o hirelens -g hirelens /opt/hirelens/app/.env.example /opt/hirelens/app/.env
sudoedit /opt/hirelens/app/.env
```

Use a GitHub deploy key or short-lived fine-grained token for the private clone.
Do not place that credential in `.env`.

Required production environment values:

```dotenv
DJANGO_SECRET_KEY=generate-a-new-long-random-value
DJANGO_DEBUG=false
DJANGO_ALLOWED_HOSTS=hirelens.example.com
CSRF_TRUSTED_ORIGINS=https://hirelens.example.com
SECURE_SSL_REDIRECT=true

DB_NAME=your_database
DB_USER=your_database_user
DB_PASSWORD=your_rotated_database_password
DB_HOST=your_database_host
DB_PORT=3306

OPENAI_API_KEY=your_rotated_openai_key
OPENAI_INTERVIEW_MODEL=gpt-5.6-luna
OPENAI_REALTIME_MODEL=gpt-realtime-2.1-mini
OPENAI_REALTIME_VOICE=marin
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe

INTERVIEW_ACCESS_CODE=use-a-strong-private-access-code
INTERVIEW_DEFAULT_MINUTES=12
INTERVIEW_MAX_MINUTES=20
INTERVIEW_STARTS_PER_HOUR=5
```

Install and start the application:

```bash
sudo -u hirelens /opt/hirelens/venv/bin/python /opt/hirelens/app/manage.py migrate --noinput
sudo -u hirelens /opt/hirelens/venv/bin/python /opt/hirelens/app/manage.py collectstatic --noinput
sudo cp /opt/hirelens/app/deploy/hostinger/hirelens.service /etc/systemd/system/hirelens.service
sudo cp /opt/hirelens/app/deploy/hostinger/nginx.conf /etc/nginx/sites-available/hirelens
sudo sed -i 's/hirelens\\.example\\.com/YOUR_REAL_DOMAIN/g' /etc/nginx/sites-available/hirelens
sudo ln -s /etc/nginx/sites-available/hirelens /etc/nginx/sites-enabled/hirelens
sudo systemctl daemon-reload
sudo systemctl enable --now hirelens
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d YOUR_REAL_DOMAIN
```

## Safe updates

After a new commit reaches `main`, run:

```bash
sudo /opt/hirelens/app/deploy/hostinger/update.sh
```

The update script stops if tests, migrations, static collection, or Django’s
deployment check fails. It restarts Gunicorn only after all checks pass.

## Rollback

Record the current commit before each update:

```bash
cd /opt/hirelens/app
git rev-parse HEAD
```

To roll back, check out that known-good commit and run the update script again.
Never roll back a database migration without reviewing whether it is reversible.
