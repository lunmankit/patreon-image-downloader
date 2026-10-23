#!/usr/bin/env python3
"""Stage a Firefox temporary add-on under dist/firefox.

Chrome loads manifest.json (background.service_worker) from the repo root.
Firefox release builds start an event page from background.scripts, and
Load Temporary Add-on only reads a file named manifest.json. This copies the
extension and writes manifest.firefox.json as dist/firefox/manifest.json.
"""

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHROME_MANIFEST = ROOT / "manifest.json"
FIREFOX_MANIFEST = ROOT / "manifest.firefox.json"
OUT = ROOT / "dist" / "firefox"
FILES = ("background.js", "content.js", "popup.html", "popup.js")

CHROME_BACKGROUND = {"service_worker": "background.js"}
FIREFOX_BACKGROUND = {"scripts": ["background.js"]}


def load(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def manifests_match():
    chrome = load(CHROME_MANIFEST)
    firefox = load(FIREFOX_MANIFEST)
    chrome_background = chrome.pop("background")
    firefox_background = firefox.pop("background")
    if chrome != firefox:
        return "manifest.json and manifest.firefox.json differ outside background"
    if chrome_background != CHROME_BACKGROUND:
        return "manifest.json background must be service_worker only"
    if firefox_background != FIREFOX_BACKGROUND:
        return "manifest.firefox.json background must be scripts only"
    if "scripts" in chrome_background or "service_worker" in firefox_background:
        return "background keys are mixed"
    return None


def main():
    error = manifests_match()
    if error:
        print(error, file=sys.stderr)
        return 1

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    for name in FILES:
        shutil.copy2(ROOT / name, OUT / name)
    shutil.copytree(ROOT / "icons", OUT / "icons")
    shutil.copy2(FIREFOX_MANIFEST, OUT / "manifest.json")

    staged = load(OUT / "manifest.json")
    if staged.get("background") != FIREFOX_BACKGROUND:
        print("staged manifest is missing background.scripts", file=sys.stderr)
        return 1
    if "service_worker" in staged.get("background", {}):
        print("staged manifest still contains service_worker", file=sys.stderr)
        return 1

    print(f"Staged Firefox add-on at {OUT}")
    print(f"Load Temporary Add-on and select {OUT / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
