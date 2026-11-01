#!/usr/bin/env bash
# Build the web app and install it on ns1. Migrations are run from here first, through the tunnel,
# since the development and the live database are the same.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
HOST=root@ns1

./db-tunnel.sh
pnpm db:migrate
pnpm web:build
rsync -rlt --delete --chmod=D750,F640 packages/web/dist/ "$HOST:/srv/med/"
ssh "$HOST" 'chgrp -R med /srv/med && systemctl restart med-web && sleep 2 && systemctl is-active med-web \
    && curl -fsS http://127.0.0.1:3100/api/me && echo'
