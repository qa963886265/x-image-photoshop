"""Classify a reference product image with FashionCLIP 2.0."""
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

# FashionCLIP tokenizer IDs for the fixed prompts below.
PROMPTS = (
    ('lower', (49406, 320, 4306, 1125, 539, 5003, 267, 10157, 541, 23172, 49407)),  # a product photo of pants, jeans or trousers
    ('lower', (49406, 320, 4306, 1125, 539, 320, 12386, 541, 9680, 49407)),  # a product photo of a skirt or shorts
    ('upper', (49406, 320, 4306, 1125, 539, 320, 2523, 267, 11455, 267, 1253, 267, 23525, 541, 6164, 49407)),  # a product photo of a shirt, sweater, top, blouse or jacket
    ('shoes', (49406, 320, 4306, 1125, 539, 4079, 267, 17397, 541, 7319, 49407)),  # a product photo of shoes, sneakers or boots
    ('head', (49406, 320, 5352, 1125, 539, 320, 1710, 537, 2225, 49407)),  # a portrait photo of a face and hair
    ('clothes', (49406, 320, 4306, 1125, 539, 320, 2595, 541, 31044, 49407)),  # a product photo of a dress or jumpsuit
    (None, (49406, 320, 1476, 1774, 6525, 1125, 539, 320, 2444, 2863, 3309, 320, 1253, 537, 23172, 49407)),  # a full body outfit photo of a fashion model wearing a top and trousers
    (None, (49406, 320, 2660, 268, 705, 7657, 539, 10033, 267, 45208, 267, 16188, 541, 320, 33670, 49407)),  # a close-up detail of fabric, stitching, buttons or a zipper
)


def classify(image, model, options):
    session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
    rgb = np.asarray(ImageOps.pad(image.convert("RGB"), (224, 224), Image.Resampling.BICUBIC, color="white"), dtype=np.float32) / 255.0
    mean = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
    std = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
    pixels = ((rgb - mean) / std).transpose(2, 0, 1)[None]
    length = max(len(ids) for _, ids in PROMPTS)
    tokens = np.full((len(PROMPTS), length), 49407, dtype=np.int64)
    mask = np.zeros_like(tokens)
    for row, (_, ids) in enumerate(PROMPTS):
        tokens[row, :len(ids)] = ids
        mask[row, :len(ids)] = 1
    logits = session.run(["logits_per_image"], {"input_ids": tokens, "attention_mask": mask, "pixel_values": pixels})[0][0]
    scores = {}
    for (part, _), score in zip(PROMPTS, logits):
        scores[part] = max(scores.get(part, -np.inf), score)
    ranked = sorted(scores.items(), key=lambda entry: entry[1], reverse=True)
    (part, best), (_, second) = ranked[:2]
    # Skip ambiguous images so a detail shot cannot steer the crop to another garment.
    return part if best - second >= 2.5 else None
