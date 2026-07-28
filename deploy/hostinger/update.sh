#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/hirelens/app
VENV_DIR=/opt/hirelens/venv

cd "$APP_DIR"
sudo -u hirelens git pull --ff-only origin main
sudo -u hirelens "$VENV_DIR/bin/pip" install -r requirements.txt
sudo -u hirelens "$VENV_DIR/bin/python" manage.py check
sudo -u hirelens "$VENV_DIR/bin/python" manage.py test
sudo -u hirelens "$VENV_DIR/bin/python" manage.py migrate --noinput
sudo -u hirelens "$VENV_DIR/bin/python" manage.py collectstatic --noinput
sudo -u hirelens env DJANGO_DEBUG=false SECURE_SSL_REDIRECT=true \
  "$VENV_DIR/bin/python" manage.py check --deploy
systemctl restart hirelens
systemctl --no-pager --full status hirelens
