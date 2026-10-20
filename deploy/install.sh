#!/usr/bin/env bash
# One-time setup on a Raspberry Pi (Raspberry Pi OS / Debian 12).
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
APP_USER=${SUDO_USER:-$USER}

echo "==> System packages (Chromium for PDF, CUPS for printing, fonts)"
sudo apt-get update -q
sudo apt-get install -y -q python3-venv chromium cups cups-browsed avahi-daemon \
  fonts-noto-cjk fonts-noto-color-emoji fonts-arphic-ukai poppler-utils

echo "==> Python environment"
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

echo "==> Printing permissions (add/enable printers from the web page)"
sudo usermod -aG lpadmin "$APP_USER"

echo "==> systemd service"
sed -e "s#/home/addis/Coding/ai-review#$APP_DIR#g" -e "s#^User=.*#User=$APP_USER#" \
  deploy/ai-review.service | sudo tee /etc/systemd/system/ai-review.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now ai-review
sleep 2
systemctl --no-pager --lines=3 status ai-review || true
echo
echo "Done. Open http://$(hostname).local:8000 on any phone, tablet or computer on this Wi-Fi."
