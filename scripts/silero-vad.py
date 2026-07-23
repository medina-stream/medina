#!/usr/bin/env python3
import argparse
import json
import sys

from silero_vad import get_speech_timestamps, load_silero_vad, read_audio


def main():
    parser = argparse.ArgumentParser(description="Run Silero VAD over an audio file and emit JSON.")
    parser.add_argument("audio")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--sampling-rate", type=int, default=16000)
    parser.add_argument("--min-speech-ms", type=int, default=250)
    parser.add_argument("--min-silence-ms", type=int, default=100)
    parser.add_argument("--speech-pad-ms", type=int, default=30)
    args = parser.parse_args()

    model = load_silero_vad(onnx=True)
    wav = read_audio(args.audio, sampling_rate=args.sampling_rate)
    timestamps = get_speech_timestamps(
        wav,
        model,
        threshold=args.threshold,
        sampling_rate=args.sampling_rate,
        min_speech_duration_ms=args.min_speech_ms,
        min_silence_duration_ms=args.min_silence_ms,
        speech_pad_ms=args.speech_pad_ms,
        return_seconds=True,
    )

    speech = []
    for item in timestamps:
        start = float(item["start"])
        end = float(item["end"])
        speech.append({
            "startSeconds": start,
            "endSeconds": end,
            "durationSeconds": max(0.0, end - start),
        })

    duration_seconds = float(len(wav)) / float(args.sampling_rate)
    speech_seconds = sum(span["durationSeconds"] for span in speech)
    json.dump({
        "durationSeconds": duration_seconds,
        "model": "silero-vad",
        "parameters": {
            "minSilenceMs": args.min_silence_ms,
            "minSpeechMs": args.min_speech_ms,
            "samplingRate": args.sampling_rate,
            "speechPadMs": args.speech_pad_ms,
            "threshold": args.threshold,
        },
        "speech": speech,
        "speechLikelihood": speech_seconds / duration_seconds if duration_seconds > 0 else 0,
        "speechSeconds": speech_seconds,
    }, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
