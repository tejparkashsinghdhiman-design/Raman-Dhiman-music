#!/usr/bin/env python3
"""Brand the generated Android project. Run from android-app/ right after `npx cap add android`.

  - launcher icon: the abstract note-and-ripples icon from assets/ (adaptive and legacy versions)
  - splash screen: plain indigo instead of the Capacitor logo
  - manifest: microphone permission, so Drafts can record voice ideas

Needs rsvg-convert (apt package librsvg2-bin) unless --renderer says otherwise.
"""
import argparse
import pathlib
import struct
import subprocess
import sys
import zlib

HERE = pathlib.Path(__file__).resolve().parent
ASSETS = HERE.parent / "assets"
INDIGO = (0x12, 0x0C, 0x36)
INDIGO_HEX = "#120C36"
PERMISSIONS = ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"]
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_size(path):
    head = path.read_bytes()[:24]
    if head[:8] != PNG_MAGIC:
        raise ValueError(f"not a PNG: {path}")
    return struct.unpack(">II", head[16:24])


def write_solid_png(path, width, height, rgb):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = (b"\x00" + bytes(rgb) * width) * height
    path.write_bytes(
        PNG_MAGIC
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def render(renderer, svg, size, out):
    subprocess.run([renderer, "-w", str(size), "-h", str(size), str(svg), "-o", str(out)], check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--android", default=str(HERE / "android"), help="generated Android project")
    ap.add_argument("--renderer", default="rsvg-convert")
    args = ap.parse_args()

    android = pathlib.Path(args.android)
    res = android / "app/src/main/res"
    manifest = android / "app/src/main/AndroidManifest.xml"
    if not res.is_dir() or not manifest.is_file():
        sys.exit(f"brand.py: no Android project at {android}. Run `npx cap add android` first.")

    icon, maskable = ASSETS / "icon.svg", ASSETS / "icon-maskable.svg"
    for f in (icon, maskable):
        if not f.is_file():
            sys.exit(f"brand.py: missing {f}")

    # Launcher icons. Legacy PNGs use the rounded-square icon; the adaptive foreground uses the full-bleed
    # maskable version, on an indigo background layer.
    legacy = sorted(res.glob("mipmap-*/ic_launcher.png")) + sorted(res.glob("mipmap-*/ic_launcher_round.png"))
    if not legacy:
        sys.exit("brand.py: no launcher icons found. The Capacitor template has changed; update brand.py.")
    for p in legacy:
        render(args.renderer, icon, png_size(p)[0], p)
    foregrounds = sorted(res.glob("mipmap-*/ic_launcher_foreground.png"))
    for p in foregrounds:
        render(args.renderer, maskable, png_size(p)[0], p)
    bg = res / "values" / "ic_launcher_background.xml"
    bg.parent.mkdir(parents=True, exist_ok=True)
    bg.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{INDIGO_HEX}</color>\n</resources>\n'
    )

    # Splash: keep each file's size, replace the picture with plain indigo.
    splashes = sorted(res.glob("drawable*/splash.png"))
    for p in splashes:
        w, h = png_size(p)
        write_solid_png(p, w, h, INDIGO)

    # Microphone permission for recording voice ideas in Drafts.
    text = manifest.read_text()
    missing = [p for p in PERMISSIONS if p not in text]
    if missing and "<application" in text:
        block = "".join(f'<uses-permission android:name="{p}" />\n    ' for p in missing)
        manifest.write_text(text.replace("<application", block + "<application", 1))

    print(f"brand.py: {len(legacy)} launcher icons, {len(foregrounds)} adaptive layers, "
          f"{len(splashes)} splash images, permissions added: {missing or 'none needed'}")


if __name__ == "__main__":
    main()
