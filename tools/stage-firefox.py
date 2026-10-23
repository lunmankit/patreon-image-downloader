#!/usr/bin/env python3
"""Stage a Firefox temporary add-on under dist/firefox.

Chrome and Firefox cannot share one background manifest key. Current Chrome
reports an error when Manifest V3 includes background.scripts, and Firefox
temporary install always reads manifest.json from the extension directory.
This copies the extension and rewrites that manifest so background.js is an
event page.
"""

import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist" / "firefox"
FILES = ("background.js", "content.js", "popup.js", "popup.html")


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    worker = (manifest.get("background") or {}).get("service_worker")
    if not worker:
        raise SystemExit("manifest.json is missing background.service_worker")

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "icons").mkdir(parents=True)

    for name in FILES:
        shutil.copy2(ROOT / name, OUT / name)
    for icon in sorted((ROOT / "icons").iterdir()):
        if icon.is_file():
            shutil.copy2(icon, OUT / "icons" / icon.name)

    manifest["background"] = {"scripts": [worker]}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
