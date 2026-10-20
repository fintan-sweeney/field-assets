#!/bin/sh
# Daily sync for Linux/macOS cron, e.g. 5am every day:
#   0 5 * * * /opt/field-assets/sync/run_sync.sh
# Secrets can be exported here or set in config.json:
#   export ARCGIS_PASSWORD=...  SUPABASE_SECRET_KEY=...
cd "$(dirname "$0")" || exit 1
mkdir -p logs
python3 arcgis_sync.py >> logs/sync.log 2>&1
