#!/usr/bin/env bash
# One-time server setup on ns1: Node, the med user, the env file, the service, TLS and the vhost.
# Each step checks what is already there, so it can be run again.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HOST=root@ns1
DOMAIN=med.sundragon.se

ssh "$HOST" bash -s < server-setup.sh

# The server's env file: database credentials from our .env, but MariaDB directly on 3306
if ssh "$HOST" test -f /etc/med/med.env; then
    echo "/etc/med/med.env exists, left as it is"
else
    {
        grep -E '^DB_(HOST|DATABASE|USERNAME|PASSWORD)=' ../.env
        echo "DB_PORT=3306"
        echo "WEB_ORIGIN=https://$DOMAIN"
        echo "WEB_PORT=3100"
        echo "WEB_PUBLIC_DIR=/srv/med/public"
        echo "SESSION_SECRET=$(openssl rand -hex 32)"
    } | ssh "$HOST" 'umask 027; cat > /etc/med/med.env && chgrp med /etc/med/med.env'
    echo "wrote /etc/med/med.env"
fi

scp med-web.service "$HOST:/etc/systemd/system/med-web.service"
ssh "$HOST" 'systemctl daemon-reload && systemctl enable med-web'

# Certificate first (the shared ACME alias already answers for every vhost), then the vhost using it.
# The account is the one the sundragon.se certificate uses; ns1 has two.
ssh "$HOST" "test -d /etc/letsencrypt/live/$DOMAIN || certbot certonly --webroot -w /var/www/acme -d $DOMAIN --non-interactive --account d27c0377efb178959144f16b8347ddfa"
scp apache-med.conf "$HOST:/etc/apache2/sites-available/med.conf"
ssh "$HOST" 'a2ensite -q med && apache2ctl configtest && systemctl reload apache2'
echo "Setup done; run deploy/deploy.sh to install the app"
