#!/usr/bin/env python3
import fcntl
import hashlib
import json
import os
import re
import tempfile
import urllib.request


API_URL = "https://api.github.com/repos/qa963886265/x-image-photoshop/releases/latest"
MODEL_URL = "https://github.com/qa963886265/x-image-photoshop/releases/download/selection-models-v1/model_quantized.onnx"
MODEL_SIZE = 28837959
MODEL_SHA256 = "2b18fbdd196a7ee12702c2fceaa6f812fe70d1154573a43bd62667b9157ee48d"
PUBLIC_BASE = "https://updates.8.208.32.40.sslip.io"
ROOT = "/opt/jx-photoshop-updates"
MAX_PACKAGE_SIZE = 300 * 1024 * 1024


def request(url):
    req = urllib.request.Request(url, headers={"User-Agent": "JX-Photoshop-Release-Mirror", "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=90)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, destination, expected_size, expected_sha256, max_size):
    directory = os.path.dirname(destination)
    fd, temporary = tempfile.mkstemp(prefix=".download-", dir=directory)
    try:
        total = 0
        digest = hashlib.sha256()
        with os.fdopen(fd, "wb") as output, request(url) as response:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_size:
                    raise ValueError("download exceeds size limit")
                digest.update(chunk)
                output.write(chunk)
        if expected_size and total != expected_size:
            raise ValueError("download size mismatch")
        actual = digest.hexdigest()
        if expected_sha256 and actual.lower() != expected_sha256.lower():
            raise ValueError("download SHA-256 mismatch")
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def version_tuple(value):
    match = re.match(r"^v?(\d+)\.(\d+)\.(\d+)$", value or "")
    if not match:
        raise ValueError("invalid release version")
    return tuple(int(part) for part in match.groups())


def ensure_model():
    destination = os.path.join(ROOT, "models", "model_quantized.onnx")
    if os.path.isfile(destination) and os.path.getsize(destination) == MODEL_SIZE and sha256_file(destination) == MODEL_SHA256:
        return
    download(MODEL_URL, destination, MODEL_SIZE, MODEL_SHA256, MODEL_SIZE)


def sync_release():
    with request(API_URL) as response:
        release = json.loads(response.read().decode("utf-8"))
    tag = release.get("tag_name", "")
    version_tuple(tag)
    expected_name = "x-image-photoshop-" + tag + ".zip"
    asset = next((item for item in release.get("assets", []) if item.get("name") == expected_name), None)
    if not asset or not asset.get("browser_download_url"):
        raise ValueError("latest release package was not found")
    size = int(asset.get("size", 0))
    digest = asset.get("digest", "")
    sha256 = digest.split(":", 1)[1] if digest.startswith("sha256:") else ""
    if size <= 0 or size > MAX_PACKAGE_SIZE or not re.match(r"^[0-9a-fA-F]{64}$", sha256):
        raise ValueError("release asset metadata is incomplete")

    os.makedirs(os.path.join(ROOT, "releases"), mode=0o755, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "models"), mode=0o755, exist_ok=True)
    latest_path = os.path.join(ROOT, "latest.json")
    current = None
    try:
        with open(latest_path, "r", encoding="utf-8") as source:
            current = json.load(source)
    except (IOError, ValueError):
        pass
    if current and version_tuple(current.get("tag_name", "")) > version_tuple(tag):
        return

    package_name = expected_name
    package_path = os.path.join(ROOT, "releases", package_name)
    if not (os.path.isfile(package_path) and os.path.getsize(package_path) == size and sha256_file(package_path) == sha256):
        download(asset["browser_download_url"], package_path, size, sha256, MAX_PACKAGE_SIZE)

    metadata = {
        "tag_name": tag,
        "name": release.get("name", tag),
        "asset_name": package_name,
        "download_url": PUBLIC_BASE + "/releases/" + package_name,
        "asset_size": size,
        "sha256": sha256.lower(),
        "published_at": release.get("published_at", ""),
        "body": release.get("body", ""),
    }
    fd, temporary = tempfile.mkstemp(prefix=".latest-", dir=ROOT)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(metadata, output, ensure_ascii=False, indent=2)
            output.write("\n")
        os.chmod(temporary, 0o644)
        os.replace(temporary, latest_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    os.makedirs(os.path.join(ROOT, "releases"), mode=0o755, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "models"), mode=0o755, exist_ok=True)
    with open("/var/lock/jx-photoshop-release-mirror.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ensure_model()
        sync_release()


if __name__ == "__main__":
    main()
