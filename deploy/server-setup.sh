#!/usr/bin/env bash
# One-time setup on ns1, run as root (deploy/setup.sh sends it over ssh). Safe to run again.
# Rollback: systemctl disable --now med-web; a2dissite med; systemctl reload apache2;
#           rm /etc/systemd/system/med-web.service /etc/apache2/sites-available/med.conf
set -euo pipefail

# Node 22 from NodeSource; Ubuntu's own package is older
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x -o /root/nodesource_setup_22.sh
    bash /root/nodesource_setup_22.sh
    apt-get install -y nodejs
fi
echo "node $(node --version)"

id med >/dev/null 2>&1 || useradd --system --home-dir /srv/med --shell /usr/sbin/nologin med
install -d -o root -g med -m 750 /srv/med
install -d -o root -g med -m 750 /etc/med
command -v rsync >/dev/null || apt-get install -y rsync
echo "user med and /srv/med ready"
