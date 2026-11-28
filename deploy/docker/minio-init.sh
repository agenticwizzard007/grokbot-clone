#!/bin/sh
set -eu
# Keep credentials out of normal output; this job never uses a real cloud endpoint.
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing local/swarm-backups
mc version enable local/swarm-backups
mc anonymous set none local/swarm-backups
mc admin user add local "$BACKUP_S3_ACCESS_KEY_ID" "$BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null
mc admin policy create local swarm-backups /init/policy.json >/dev/null
mc admin policy attach local swarm-backups --user "$BACKUP_S3_ACCESS_KEY_ID" >/dev/null
# Replacing this owned local bucket's rules is idempotent across local-up runs.
mc ilm rule import local/swarm-backups < /init/lifecycle.json
touch /tmp/initialized
