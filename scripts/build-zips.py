#!/usr/bin/env python3
"""Rebuild the installable extension zips in dist/ (same rules as build-zips.sh,
for machines without the `zip` tool): folder contents at the zip root, *.md
left out, and popup-size.js must be identical in both extensions."""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
os.makedirs('dist', exist_ok=True)

a = open('tab-manager/popup-size.js', 'rb').read()
b = open('media-sniffer-ext/popup-size.js', 'rb').read()
if a != b:
    sys.exit('popup-size.js differs between tab-manager/ and media-sniffer-ext/')


def build(src, out):
    path = os.path.join('dist', out)
    if os.path.exists(path):
        os.remove(path)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(src):
            for f in sorted(files):
                if f.endswith('.md'):
                    continue
                full = os.path.join(base, f)
                z.write(full, os.path.relpath(full, src).replace(os.sep, '/'))
    v = json.load(open(os.path.join(src, 'manifest.json'), encoding='utf-8'))['version']
    print('dist/%s  <-  %s (v%s)' % (out, src, v))


build('tab-manager', 'tab-vault.zip')
build('media-sniffer-ext', 'media-vault.zip')
