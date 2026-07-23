#!/usr/bin/env python3
import argparse
import json
import sys

import numpy as np
import soundfile as sf
import torch
from speechbrain.inference.speaker import EncoderClassifier

MODEL_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"
MIN_SECONDS = 0.5


def parse_group(value):
    spans = []
    for part in value.split(","):
        start, end = part.split("-")
        spans.append((float(start), float(end)))
    return spans


def main():
    parser = argparse.ArgumentParser(description="Emit ECAPA speaker embeddings for span groups of a 16kHz mono WAV file.")
    parser.add_argument("audio")
    parser.add_argument("--group", action="append", default=[], help="Comma-separated start-end second spans, e.g. 0.5-4.2,10-20. One embedding per group.")
    args = parser.parse_args()

    wav, rate = sf.read(args.audio, dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)

    groups = [parse_group(group) for group in args.group] or [[(0.0, len(wav) / rate)]]
    model = EncoderClassifier.from_hparams(source=MODEL_SOURCE, run_opts={"device": "cpu"})

    embeddings = []
    for spans in groups:
        pieces = []
        for start, end in spans:
            lo = max(0, int(start * rate))
            hi = min(len(wav), int(end * rate))
            if hi > lo:
                pieces.append(wav[lo:hi])
        if not pieces:
            embeddings.append(None)
            continue
        segment = np.concatenate(pieces)
        if len(segment) < int(MIN_SECONDS * rate):
            embeddings.append(None)
            continue
        with torch.no_grad():
            embedding = model.encode_batch(torch.from_numpy(segment).unsqueeze(0)).squeeze()
        embeddings.append([float(x) for x in embedding])

    json.dump({"model": MODEL_SOURCE, "embeddings": embeddings}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
