#!/usr/bin/env python3
"""
Field Assets - ArcGIS Enterprise -> Supabase sync

Copies asset layers from ArcGIS Enterprise feature/map services into the
Supabase `assets` table, so the field app can find nearby assets without
every user needing an ArcGIS licence.

* Uses only the Python standard library (Python 3.8+). It runs with the
  Python that comes with ArcGIS Pro, or any normal Python install.
* Needs network access to your ArcGIS Enterprise server and outbound HTTPS
  to Supabase. Run it on a machine inside your network (e.g. the GIS server
  or a utility server) on a daily schedule.

Usage:
    python arcgis_sync.py                    # uses config.json next to this file
    python arcgis_sync.py --config my.json
    python arcgis_sync.py --layer Poles      # sync one layer only
    python arcgis_sync.py --dry-run          # read from ArcGIS, don't write
    python arcgis_sync.py --force            # skip the large-deletion safety check

Secrets can come from the config file or environment variables:
    ARCGIS_USERNAME, ARCGIS_PASSWORD, SUPABASE_URL, SUPABASE_SECRET_KEY
"""

import argparse
import datetime as dt
import json
import logging
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

log = logging.getLogger("arcgis_sync")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

class HttpError(Exception):
    pass


# Some servers sit behind Cloudflare or another firewall that blocks requests
# identifying as "Python-urllib" (Cloudflare error 1010). Send a normal
# browser-style identity instead. Override with "user_agent" in config.json.
USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 FieldAssetsSync/1.2")


def _ssl_context(cfg):
    ctx = ssl.create_default_context()
    ca = cfg.get("ca_bundle")
    if ca:
        ctx.load_verify_locations(ca)
    return ctx


def http_request(url, data=None, headers=None, method=None, ctx=None,
                 timeout=120, retries=3):
    """Make an HTTP request and return the parsed JSON body."""
    headers = dict(headers or {})
    headers.setdefault("User-Agent", USER_AGENT)
    headers.setdefault("Accept", "application/json, text/plain, */*")
    body = None
    if data is not None:
        if isinstance(data, (dict, list)) and headers.get("Content-Type") == "application/json":
            body = json.dumps(data).encode("utf-8")
        elif isinstance(data, dict):
            body = urllib.parse.urlencode(data).encode("utf-8")
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            body = data
    last_err = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                raw = resp.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:1000]
            hint = ""
            if e.code == 403 and ("1010" in detail or "cloudflare" in detail.lower()
                                  or "cf-ray" in str(e.headers).lower()):
                hint = (" -- This looks like a Cloudflare/firewall block, not an ArcGIS login problem. "
                        "Ask IT to allow this computer's IP address (or a WAF skip rule) for the GIS server.")
            last_err = HttpError(f"HTTP {e.code} from {url.split('?')[0]}: {detail}{hint}")
            if e.code < 500 and e.code != 429:
                raise last_err
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = HttpError(f"Network error calling {url.split('?')[0]}: {e}")
        if attempt < retries:
            wait = 5 * attempt
            log.warning("%s - retrying in %ss", last_err, wait)
            time.sleep(wait)
    raise last_err


# ---------------------------------------------------------------------------
# ArcGIS
# ---------------------------------------------------------------------------

class ArcGIS:
    def __init__(self, cfg, ctx):
        self.cfg = cfg
        self.ctx = ctx
        self.token = None
        self.token_expires = 0

    def get_token(self):
        token_url = self.cfg.get("token_url")
        if not token_url:
            return None                      # service doesn't need a token
        if self.token and time.time() < self.token_expires - 300:
            return self.token
        user = os.environ.get("ARCGIS_USERNAME") or self.cfg.get("username")
        pwd = os.environ.get("ARCGIS_PASSWORD") or self.cfg.get("password")
        if not user or not pwd:
            raise SystemExit("ArcGIS username/password missing (config or ARCGIS_USERNAME / ARCGIS_PASSWORD).")
        referer = self.cfg.get("referer", "field-assets-sync")
        res = http_request(token_url, data={
            "username": user,
            "password": pwd,
            "client": "referer",
            "referer": referer,
            "expiration": 120,              # minutes
            "f": "json",
        }, ctx=self.ctx)
        if not res or "token" not in res:
            raise SystemExit(f"Could not get ArcGIS token: {res}")
        self.token = res["token"]
        self.token_expires = (res.get("expires", 0) / 1000) or (time.time() + 7200)
        log.info("Got ArcGIS token for %s", user)
        return self.token

    def call(self, url, params):
        params = dict(params)
        params["f"] = params.get("f", "json")
        headers = {}
        token = self.get_token()
        if token:
            params["token"] = token
            headers["Referer"] = self.cfg.get("referer", "field-assets-sync")
        # POST avoids URL length limits on long objectId lists
        res = http_request(url, data=params, headers=headers, ctx=self.ctx)
        if isinstance(res, dict) and "error" in res:
            raise HttpError(f"ArcGIS error from {url}: {res['error']}")
        return res

    def layer_info(self, layer_url):
        return self.call(layer_url, {})

    def object_ids(self, layer_url, where):
        res = self.call(f"{layer_url}/query", {"where": where, "returnIdsOnly": "true"})
        return res.get("objectIdFieldName"), sorted(res.get("objectIds") or [])

    def features(self, layer_url, oid_field, ids, out_fields):
        res = self.call(f"{layer_url}/query", {
            "objectIds": ",".join(str(i) for i in ids),
            "outFields": ",".join(out_fields),
            "returnGeometry": "true",
            "outSR": "4326",
            "geometryPrecision": "7",
            "f": "geojson",
        })
        return res.get("features") or []


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

class Supabase:
    def __init__(self, cfg, ctx):
        self.url = (os.environ.get("SUPABASE_URL") or cfg.get("url") or "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SECRET_KEY") or cfg.get("secret_key")
        if not self.url or not self.key:
            raise SystemExit("Supabase url/secret_key missing (config or SUPABASE_URL / SUPABASE_SECRET_KEY).")
        self.ctx = ctx

    def rpc(self, fn, payload):
        # Must NOT look like a browser: Supabase rejects secret keys sent with a
        # browser User-Agent ("Forbidden use of secret API key in browser").
        headers = {"Content-Type": "application/json", "apikey": self.key,
                   "User-Agent": "FieldAssetsSync/1.2 (server script; python-urllib)"}
        if not self.key.startswith("sb_"):
            # legacy service_role JWT keys are also sent as a bearer token
            headers["Authorization"] = f"Bearer {self.key}"
        return http_request(f"{self.url}/rest/v1/rpc/{fn}", data=payload,
                            headers=headers, method="POST", ctx=self.ctx)


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------

def _json_safe(value, field_type):
    if value is None:
        return None
    if field_type == "esriFieldTypeDate" and isinstance(value, (int, float)):
        try:
            return dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return value
    return value


def convert_feature(feat, layer_cfg, field_types, oid_field):
    props = feat.get("properties") or {}
    geom = feat.get("geometry")
    if not geom:
        return None

    def get(field):
        if not field:
            return None
        v = props.get(field)
        if v is None:
            return None
        v = str(_json_safe(v, field_types.get(field))).strip()
        return v or None

    # id_field can be one field, or a list of fields combined (e.g. ["SITE", "POLE_NO"])
    id_fields = layer_cfg.get("id_field")
    if isinstance(id_fields, list):
        parts = [get(f) for f in id_fields]
        asset_id = "-".join(parts) if all(parts) else None
    else:
        asset_id = get(id_fields)
    if not asset_id and layer_cfg.get("id_fallback_to_objectid", True) and props.get(oid_field) is not None:
        asset_id = f"OID-{props.get(oid_field)}"
    if not asset_id:
        return None

    attributes = {}
    for f in layer_cfg.get("extra_fields", []):
        label = layer_cfg.get("field_labels", {}).get(f, f)
        attributes[label] = _json_safe(props.get(f), field_types.get(f))

    return {
        "asset_id": asset_id,
        "name": get(layer_cfg.get("name_field")) or asset_id,
        "asset_type": get(layer_cfg.get("type_field")) or layer_cfg.get("type_value") or layer_cfg["name"],
        "status": get(layer_cfg.get("status_field")),
        "attributes": attributes,
        "geometry": geom,
    }


# ---------------------------------------------------------------------------
# Sync one layer
# ---------------------------------------------------------------------------

def sync_layer(arc, sb, layer_cfg, batch_size, dry_run=False, force=False):
    name = layer_cfg["name"]
    url = layer_cfg["url"].rstrip("/")
    where = layer_cfg.get("where", "1=1")
    log.info("[%s] reading layer info from %s", name, url)

    info = arc.layer_info(url)
    field_types = {f["name"]: f.get("type") for f in info.get("fields", [])}
    id_cfg = layer_cfg.get("id_field")
    wanted = list(id_cfg) if isinstance(id_cfg, list) else [id_cfg]
    wanted += [layer_cfg.get(k) for k in ("name_field", "type_field", "status_field")]
    wanted += layer_cfg.get("extra_fields", [])
    wanted = [f for f in dict.fromkeys(wanted) if f]
    missing = [f for f in wanted if f not in field_types]
    if missing:
        raise SystemExit(f"[{name}] these fields are not in the layer: {missing}. "
                         f"Available: {sorted(field_types)}")

    oid_field, ids = arc.object_ids(url, where)
    log.info("[%s] %d features match where=%r", name, len(ids), where)
    if not ids:
        log.warning("[%s] no features returned - skipping (nothing deleted).", name)
        return 0

    out_fields = list(dict.fromkeys(wanted + [oid_field]))
    max_batch = min(batch_size, int(info.get("maxRecordCount") or batch_size))
    run_id = str(uuid.uuid4())
    skipped = 0
    all_ids = set()          # unique asset IDs seen in this layer
    dup_counts = {}          # asset ID -> number of extra copies

    for start in range(0, len(ids), max_batch):
        chunk = ids[start:start + max_batch]
        feats = arc.features(url, oid_field, chunk, out_fields)
        converted = [r for r in (convert_feature(f, layer_cfg, field_types, oid_field) for f in feats) if r]
        skipped += len(feats) - len(converted)

        # One row per asset ID: if an ID repeats, the last feature wins
        batch = {}
        for r in converted:
            aid = r["asset_id"]
            if aid in batch or aid in all_ids:
                dup_counts[aid] = dup_counts.get(aid, 0) + 1
            batch[aid] = r
        all_ids.update(batch)
        rows = list(batch.values())

        if not dry_run and rows:
            sb.rpc("sync_upsert_assets", {"p_layer": name, "p_run": run_id, "p_features": rows})
        log.info("[%s] %d / %d", name, min(start + max_batch, len(ids)), len(ids))

    seen = len(all_ids)
    if skipped:
        log.warning("[%s] skipped %d features with no geometry or ID", name, skipped)
    if dup_counts:
        examples = ", ".join(f"{k!r} x{v + 1}" for k, v in list(dup_counts.items())[:5])
        log.warning("[%s] %d asset IDs appear more than once in %r (only one copy of each is kept). "
                    "Examples: %s. Consider a unique field, e.g. GLOBALID, or combine fields: "
                    "\"id_field\": [\"FIELD1\", \"FIELD2\"].",
                    name, len(dup_counts), id_cfg, examples)

    if dry_run:
        log.info("[%s] dry run - %d assets read, nothing written", name, seen)
        return seen

    removed = sb.rpc("sync_finish", {"p_layer": name, "p_run": run_id,
                                      "p_seen": seen, "p_force": force})
    log.info("[%s] done: %d assets synced, %s removed", name, seen, removed)
    return seen


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None):
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="Sync ArcGIS Enterprise layers to Supabase")
    ap.add_argument("--config", default=os.path.join(here, "config.json"))
    ap.add_argument("--layer", help="sync only the layer with this name")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true",
                    help="allow deleting a large share of assets in one run")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")

    with open(args.config, encoding="utf-8") as fh:
        cfg = json.load(fh)

    global USER_AGENT
    USER_AGENT = cfg.get("user_agent") or USER_AGENT

    ctx = _ssl_context(cfg.get("arcgis", {}))
    arc = ArcGIS(cfg.get("arcgis", {}), ctx)
    sb = None if args.dry_run else Supabase(cfg.get("supabase", {}), _ssl_context(cfg.get("supabase", {})))
    batch = int(cfg.get("batch_size", 500))

    layers = cfg.get("layers", [])
    if args.layer:
        layers = [l for l in layers if l["name"] == args.layer]
        if not layers:
            raise SystemExit(f"No layer named {args.layer!r} in config")

    failures = 0
    for layer in layers:
        try:
            sync_layer(arc, sb, layer, batch, dry_run=args.dry_run, force=args.force)
        except SystemExit:
            raise
        except Exception as e:                        # keep going with other layers
            failures += 1
            log.error("[%s] FAILED: %s", layer.get("name"), e)

    if failures:
        log.error("%d layer(s) failed", failures)
        return 1
    log.info("All layers synced")
    return 0


if __name__ == "__main__":
    sys.exit(main())
