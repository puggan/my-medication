#!/usr/bin/env bash
# Keep an SSH tunnel to MariaDB on ns1 running in a named screen.
# Local port is DB_PORT from .env; the remote side is MariaDB on ns1:3306.
# The tunnel reaches the whole server, so it is shared with other projects
# (e.g. eko) that use the same port: if the port is already listening, reuse it.
set -euo pipefail

SESSION=med-db-tunnel
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_PORT=$(sed -n 's/^DB_PORT=//p' "$DIR/.env")

if ss -ltnH "sport = :$LOCAL_PORT" | grep -q .; then
    echo "Port $LOCAL_PORT already listening, reusing existing tunnel"
    exit 0
fi

screen -dmS "$SESSION" ssh -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:3306" ns1
echo "Started tunnel 127.0.0.1:$LOCAL_PORT -> ns1:3306 in screen '$SESSION'"
