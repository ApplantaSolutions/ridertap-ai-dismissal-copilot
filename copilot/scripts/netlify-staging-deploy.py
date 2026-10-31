#!/usr/bin/env python3
"""RiderTap COPILOT STAGING deploy — Netlify API FILE-DIGEST method.

Why not bin/netlify-deploy.py (the existing ZIP deploy)? Netlify's own
support answer: a ZIP deploy "won't bundle the functions. It's only useful
to fully static websites." RiderTap needs its actions function live, so the
deploy must use the digest method:
  1. POST /sites/{site_id}/deploys with
       {"files": {path: sha1}, "functions": {"actions": sha256_of_zip}, "draft": true}
  2. PUT each file Netlify lists in `required`
       -> /deploys/{deploy_id}/files/{path}
     PUT the function zip listed in `required_functions`
       -> /deploys/{deploy_id}/functions/actions?runtime=js
  3. Poll until state=ready  -> this is a DRAFT at its unique deploy URL.
  4. Smoke-test the draft URL (POST_DEPLOY_SMOKE_TEST.md).
  5. Promote: POST /sites/{site_id}/deploys/{deploy_id}/restore
     (publishes the SAME deploy — no second upload, no extra deploy burn).

Usage:
  netlify-digest-deploy.py --dry-run   # compute + print digests only; NO API writes
  netlify-digest-deploy.py --deploy    # full flow above (stops before promotion)
  netlify-digest-deploy.py --promote <deploy_id>

Auth: the stored custom.netlify credential via dynamic_credentials, exactly
like bin/netlify-deploy.py. No raw token is read, printed, or stored here.

Expected staging layout (built Oct 27, 2026):
  copilot/public/                 built client (index.html + assets/ + _redirects + _headers)
  copilot/functions-dist/actions.zip   bundled function (single-file JS + node_modules, zipped)

Modes:
  --prepare   find/create the STAGING site and set its function env vars
              (COPILOT_DB_URL=file:/tmp/... smoke DB, COPILOT_SAM_ADAPTER=stub).
              NEVER touches the production site (name differs by construction).
  --deploy    one DRAFT deploy. Promotion is a separate, deliberate step
              that this build does NOT take.
"""
import hashlib
import io
import json
import os
import sys
import time
import urllib.request
import zipfile

sys.path[:0] = [p for p in ("/opt/muse/skills/custom-connector-setup/bin", "/opt/hatch/workflow-skills/custom-connector-setup/bin") if os.path.isdir(p)]
from dynamic_credentials import add_surrogate_to_request, read_json_response

API = "https://api.netlify.com/api/v1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC_DIR = os.path.join(ROOT, "public")
FUNCTION_ZIP = os.path.join(ROOT, "functions-dist", "actions.zip")
SITE_NAME = "ridertap-copilot-staging"


def api_req(path, method="GET", data=None, ctype=None):
    req = urllib.request.Request(API + path, data=data, method=method)
    if ctype:
        req.add_header("Content-Type", ctype)
    add_surrogate_to_request(req, "custom.netlify", allowed_hosts=["api.netlify.com"])
    with urllib.request.urlopen(req, timeout=120) as resp:
        return read_json_response(resp)


def sha1(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def collect_files():
    """{ '/index.html': (sha1, bytes), ... } for everything under public/."""
    out = {}
    for root, _, files in os.walk(PUBLIC_DIR):
        for f in files:
            full = os.path.join(root, f)
            rel = "/" + os.path.relpath(full, PUBLIC_DIR).replace(os.sep, "/")
            with open(full, "rb") as fh:
                data = fh.read()
            out[rel] = (sha1(data), data)
    return out


def find_or_create_site():
    sites = api_req("/sites")
    for s in sites:
        if s.get("name") == SITE_NAME:
            return s["id"], s.get("url"), False
    created = api_req(
        "/sites",
        method="POST",
        data=json.dumps({"name": SITE_NAME}).encode(),
        ctype="application/json",
    )
    return created["id"], created.get("url"), True


def prepare():
    """Find/create the STAGING site and set its function env vars.

    The DB env var points at a function-local /tmp file — an ephemeral
    SMOKE database for the scaffold deploy only. Real staging persistence
    is a staging Turso instance (C-12), which is JR's account tap; the
    zone pipeline's full-path proof lives in the local gate, not here.
    """
    site_id, url, created = find_or_create_site()
    print(f"site: {SITE_NAME} id={site_id} url={url} created={created}")
    assert site_id != "92bdda35-c5a0-48ad-9342-04fff1372d85", "REFUSING: resolved to the PRODUCTION site"
    env_payload = [
        {"key": "COPILOT_DB_URL", "values": [{"context": "all", "value": "file:/tmp/copilot-staging.sqlite"}]},
        {"key": "COPILOT_SAM_ADAPTER", "values": [{"context": "all", "value": "stub"}]},
    ]
    api_req(f"/sites/{site_id}/env", method="POST",
            data=json.dumps(env_payload).encode(), ctype="application/json")
    print("env set: COPILOT_DB_URL=file:/tmp/copilot-staging.sqlite, COPILOT_SAM_ADAPTER=stub")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--dry-run"

    if mode == "--prepare":
        prepare()
        return

    if mode == "--promote":
        deploy_id = sys.argv[2]
        sites = api_req("/sites")
        site = next(s for s in sites if s.get("name") == SITE_NAME)
        r = api_req(f"/sites/{site['id']}/deploys/{deploy_id}/restore", method="POST")
        print(f"promoted deploy {deploy_id}: {r.get('deploy_ssl_url') or r.get('url')}")
        return

    assert os.path.isfile(os.path.join(PUBLIC_DIR, "index.html")), \
        f"missing built client at {PUBLIC_DIR}/index.html — build the client first"
    assert os.path.isfile(FUNCTION_ZIP), \
        f"missing bundled function at {FUNCTION_ZIP} — bundle functions/actions.ts first"

    files = collect_files()
    with open(FUNCTION_ZIP, "rb") as fh:
        fn_bytes = fh.read()
    fn_digest = sha256(fn_bytes)

    print(f"files: {len(files)}  function actions sha256: {fn_digest[:16]}…")
    if mode == "--dry-run":
        for p in sorted(files):
            print(f"  {p}  sha1={files[p][0][:12]}…")
        print("DRY RUN — no API calls made, nothing deployed.")
        return

    if mode != "--deploy":
        raise SystemExit("usage: --dry-run | --deploy | --promote <deploy_id>")

    site_id, url, created = find_or_create_site()
    print(f"site: {SITE_NAME} id={site_id} url={url} created={created}")

    payload = {
        "files": {p: d for p, (d, _) in files.items()},
        "functions": {"actions": fn_digest},
        "draft": True,  # <-- never straight to production; smoke-test first
    }
    deploy = api_req(
        f"/sites/{site_id}/deploys",
        method="POST",
        data=json.dumps(payload).encode(),
        ctype="application/json",
    )
    deploy_id = deploy["id"]
    print(f"draft deploy created: {deploy_id}")

    by_digest = {d: (p, data) for p, (d, data) in files.items()}
    for d in deploy.get("required", []):
        p, data = by_digest[d]
        api_req(f"/deploys/{deploy_id}/files{p}", method="PUT",
                data=data, ctype="application/octet-stream")
        print(f"  uploaded file {p}")
    for fd in deploy.get("required_functions", []):
        assert fd == fn_digest, f"unexpected required function digest {fd}"
        api_req(f"/deploys/{deploy_id}/functions/actions?runtime=js",
                method="PUT", data=fn_bytes, ctype="application/octet-stream")
        print("  uploaded function actions")

    for _ in range(60):
        d = api_req(f"/sites/{site_id}/deploys/{deploy_id}")
        state = d.get("state")
        print(f"  state={state}", flush=True)
        if state == "ready":
            print(f"DRAFT READY: {d.get('deploy_ssl_url')}")
            print("Next: run POST_DEPLOY_SMOKE_TEST.md against the draft URL, then:")
            print(f"  netlify-digest-deploy.py --promote {deploy_id}")
            return
        if state in ("error", "failed"):
            raise SystemExit(f"deploy failed: {json.dumps(d)[:500]}")
        time.sleep(5)
    raise SystemExit("deploy timed out waiting for ready")


if __name__ == "__main__":
    main()
