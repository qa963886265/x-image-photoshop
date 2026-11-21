"""Read pending preview jobs from this plugin's Photoshop data folders."""
import base64
import io
import json
import os
from pathlib import Path
import re
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image
from reference_classifier import classify

PROTOCOL = "jx-auto-selection-file-v1"
ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
def model_path():
    local = os.environ.get("LOCALAPPDATA")
    if local:
        external = Path(local) / "JXImagePhotoshop" / "auto-selection" / "model_quantized.onnx"
        if external.is_file():
            return external
    return ROOT / "model_quantized.onnx"

JOB_NAME = re.compile(r"jx-segment-[0-9]{13}-[0-9a-f]{8,16}")
MAX_REQUEST = 8 * 1024 * 1024
SESSION = None


def read_preview(value):
    if not isinstance(value, str) or len(value) > MAX_REQUEST:
        raise ValueError("Invalid preview")
    with Image.open(io.BytesIO(base64.b64decode(value, validate=True))) as image:
        if max(image.size) > 2048:
            raise ValueError("Preview too large")
        return image.convert("RGB")


def session_options():
    options = ort.SessionOptions()
    options.intra_op_num_threads = min(8, os.cpu_count() or 1)
    return options


def infer(value):
    global SESSION
    image = read_preview(value)
    rgb = np.asarray(image.resize((512, 512), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
    start = time.monotonic()
    if SESSION is None:
        SESSION = ort.InferenceSession(str(model_path()), session_options(), providers=["CPUExecutionProvider"])
    tensor = ((rgb - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)).transpose(2, 0, 1)[None]
    logits = SESSION.run(None, {SESSION.get_inputs()[0].name: tensor})[0][0]
    scores = np.stack([np.asarray(Image.fromarray(score).resize((512, 512), Image.Resampling.BILINEAR)) for score in logits])
    labels = np.argmax(scores, axis=0).astype(np.uint8)
    return {"width": 512, "height": 512, "labels": base64.b64encode(labels.tobytes()).decode("ascii"), "inferenceMs": round((time.monotonic() - start) * 1000)}


def is_head_reference(parsed):
    labels = np.frombuffer(base64.b64decode(parsed["labels"]), dtype=np.uint8)
    face = labels == 11
    clothes_below_waist = np.isin(labels, (5, 6, 9, 10))
    head = np.isin(labels, (1, 2, 3, 11))
    # A prominent face and head distinguish a portrait from an outfit reference.
    return face.mean() >= 0.025 and head.mean() >= 0.09 and clothes_below_waist.mean() < 0.02


def process(job):
    claimed = job / "working"
    try:
        (job / "ready").rename(claimed)
    except OSError:
        return
    result = {"protocol": PROTOCOL}
    try:
        with (job / "request.json").open("rb") as request:
            raw = request.read(MAX_REQUEST + 1)
        if len(raw) > MAX_REQUEST:
            raise ValueError("Request too large")
        data = json.loads(raw)
        if data.get("protocol") != PROTOCOL:
            raise ValueError("Invalid protocol")
        local = os.environ.get("LOCALAPPDATA")
        reference_model = Path(local) / "JXImagePhotoshop" / "auto-selection" / "fashionclip.onnx" if local else None
        if data.get("mode") == "reference":
            value = data.get("image")
            parsed = infer(value) if model_path().is_file() else None
            if parsed and is_head_reference(parsed):
                result["referencePart"] = "head"
            elif reference_model and reference_model.is_file():
                result["referencePart"] = classify(read_preview(value), reference_model, session_options())
            elif parsed:
                result.update(parsed)
            else:
                result["error"] = "model_missing"
        elif model_path().is_file():
            result.update(infer(data.get("image")))
        else:
            result["error"] = "model_missing"
    except Exception:
        result["error"] = "inference_failed"
    finally:
        (job / "request.json").unlink(missing_ok=True)
    try:
        with (job / "response.tmp").open("x", encoding="utf-8") as output:
            json.dump(result, output)
        (job / "response.tmp").replace(job / "response.json")
    except OSError:
        pass


def main():
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return
    root = Path(appdata) / "Adobe" / "UXP" / "PluginsStorage" / "PHSP"
    for host in root.glob("*"):
        for kind in ("Developer", "External"):
            folder = host / kind / "llai.psapi.selectioneditor" / "PluginData"
            for job in folder.glob("jx-segment-*"):
                if not JOB_NAME.fullmatch(job.name) or job.is_symlink() or job.is_junction():
                    continue
                try:
                    if time.time() - (job / "ready").stat().st_mtime < 90:
                        process(job)
                except OSError:
                    pass


if __name__ == "__main__":
    main()
