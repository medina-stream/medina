#!/usr/bin/env python3
"""Airgapped NAS media metadata scanner.

Walks a directory tree, probes media files with ffprobe when available, and emits
JSONL plus CSV metadata suitable for sharing without raw audio bytes.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_EXTENSIONS = {
    ".3gp",
    ".aac",
    ".aif",
    ".aiff",
    ".amr",
    ".caf",
    ".flac",
    ".m4a",
    ".m4b",
    ".mka",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".oga",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
}

TIMESTAMP_PATTERNS = [
    ("yyyymmdd_hhmmss", re.compile(r"(?<!\d)(20\d{2})([01]\d)([0-3]\d)[-_ T]?([0-2]\d)([0-5]\d)([0-5]\d)(?!\d)")),
    ("yyyymmdd_hhmm", re.compile(r"(?<!\d)(20\d{2})([01]\d)([0-3]\d)[-_ T]?([0-2]\d)([0-5]\d)(?!\d)")),
    ("yyyy-mm-dd_hh-mm-ss", re.compile(r"(?<!\d)(20\d{2})[-_.]([01]\d)[-_.]([0-3]\d)[-_ T]([0-2]\d)[-_.:]([0-5]\d)[-_.:]([0-5]\d)(?!\d)")),
    ("yyyy-mm-dd_hh-mm", re.compile(r"(?<!\d)(20\d{2})[-_.]([01]\d)[-_.]([0-3]\d)[-_ T]([0-2]\d)[-_.:]([0-5]\d)(?!\d)")),
    ("yyyymmdd", re.compile(r"(?<!\d)(20\d{2})([01]\d)([0-3]\d)(?!\d)")),
    ("yyyy-mm-dd", re.compile(r"(?<!\d)(20\d{2})[-_.]([01]\d)[-_.]([0-3]\d)(?!\d)")),
]

TAG_DATETIME_KEYS = {
    "creation_time",
    "date",
    "datetime",
    "encoded_date",
    "media_create_date",
    "track_create_date",
    "year",
}

CSV_FIELDS = [
    "scan_id",
    "row_index",
    "status",
    "rel_path",
    "parent_path",
    "basename",
    "extension",
    "size_bytes",
    "fs_mtime",
    "fs_ctime",
    "fs_atime",
    "hash_mode",
    "sha256",
    "ffprobe_ok",
    "duration_seconds",
    "format_name",
    "format_long_name",
    "bit_rate",
    "audio_codec",
    "audio_sample_rate",
    "audio_channels",
    "tag_creation_time",
    "tag_date",
    "tags_json",
    "timestamp_candidates_json",
    "error",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan a NAS/media directory for shareable audio metadata evidence without copying audio bytes.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("root", help="Root directory to scan")
    parser.add_argument("--out", default="nas-scan", help="Output prefix, or a directory when --out-dir-style is set")
    parser.add_argument("--out-dir-style", action="store_true", help="Write <out>/nas-scan.{jsonl,csv} instead of <out>.{jsonl,csv}")
    parser.add_argument("--timezone", default="UTC", help="IANA timezone for filesystem-local and filename-local timestamps, e.g. America/Los_Angeles")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of matching files to scan; 0 means no limit")
    parser.add_argument("--include-extensions", default=",".join(sorted(DEFAULT_EXTENSIONS)), help="Comma-separated extensions to include; use '*' for all files")
    parser.add_argument("--redact-parent-dirs", action=argparse.BooleanOptionalAction, default=True, help="Redact parent directory names from output paths")
    parser.add_argument("--hash-mode", choices=["none", "prefix", "full"], default="none", help="Content hash mode. prefix hashes first --hash-prefix-bytes bytes only; full reads entire file")
    parser.add_argument("--hash-prefix-bytes", type=int, default=1048576, help="Bytes read for --hash-mode prefix")
    parser.add_argument("--ffprobe", default="ffprobe", help="ffprobe executable path/name")
    parser.add_argument("--no-ffprobe", action="store_true", help="Skip ffprobe entirely")
    return parser.parse_args()


def iso_from_timestamp(value: float, tz: ZoneInfo) -> str:
    return dt.datetime.fromtimestamp(value, tz).isoformat()


def normalize_extensions(raw: str) -> set[str] | None:
    if raw.strip() == "*":
        return None
    exts: set[str] = set()
    for part in raw.split(","):
        part = part.strip().lower()
        if not part:
            continue
        if not part.startswith("."):
            part = "." + part
        exts.add(part)
    return exts


def safe_rel_path(path: Path, root: Path, redact: bool) -> tuple[str, str]:
    rel = path.relative_to(root)
    if not redact:
        parent = rel.parent.as_posix() if rel.parent.as_posix() != "." else ""
        return rel.as_posix(), parent
    parts = rel.parts
    if len(parts) <= 1:
        return parts[-1], ""
    parent = "/".join("<dir>" for _ in parts[:-1])
    return f"{parent}/{parts[-1]}", parent


def hash_file(path: Path, mode: str, prefix_bytes: int) -> str | None:
    if mode == "none":
        return None
    h = hashlib.sha256()
    remaining = prefix_bytes if mode == "prefix" else None
    with path.open("rb") as f:
        while True:
            size = 1024 * 1024
            if remaining is not None:
                if remaining <= 0:
                    break
                size = min(size, remaining)
            chunk = f.read(size)
            if not chunk:
                break
            h.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    return h.hexdigest()


def run_ffprobe(path: Path, ffprobe: str) -> tuple[bool, dict[str, Any], str | None]:
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-print_format",
        "json",
        str(path),
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    except FileNotFoundError:
        return False, {}, f"ffprobe not found: {ffprobe}"
    except subprocess.TimeoutExpired:
        return False, {}, "ffprobe timed out after 30s"
    if proc.returncode != 0:
        return False, {}, proc.stderr.strip() or f"ffprobe exited {proc.returncode}"
    try:
        return True, json.loads(proc.stdout or "{}"), None
    except json.JSONDecodeError as exc:
        return False, {}, f"ffprobe emitted invalid JSON: {exc}"


def parse_float(value: Any) -> float | None:
    try:
        if value is None or value == "N/A":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def media_summary(probe: dict[str, Any]) -> dict[str, Any]:
    fmt = probe.get("format") or {}
    streams = probe.get("streams") or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    tags: dict[str, Any] = {}
    for source in [fmt, audio, *streams]:
        for key, value in (source.get("tags") or {}).items():
            norm_key = str(key).strip().lower()
            if norm_key and norm_key not in tags:
                tags[norm_key] = value
    return {
        "duration_seconds": parse_float(fmt.get("duration")) or parse_float(audio.get("duration")),
        "format_name": fmt.get("format_name"),
        "format_long_name": fmt.get("format_long_name"),
        "bit_rate": fmt.get("bit_rate") or audio.get("bit_rate"),
        "audio_codec": audio.get("codec_name"),
        "audio_sample_rate": audio.get("sample_rate"),
        "audio_channels": audio.get("channels"),
        "tags": tags,
        "stream_count": len(streams),
        "audio_stream_count": sum(1 for s in streams if s.get("codec_type") == "audio"),
    }


def valid_dt(year: int, month: int, day: int, hour: int = 0, minute: int = 0, second: int = 0) -> dt.datetime | None:
    try:
        return dt.datetime(year, month, day, hour, minute, second)
    except ValueError:
        return None


def add_candidate(candidates: list[dict[str, Any]], source: str, pattern: str, text: str, value: dt.datetime, tz: ZoneInfo, confidence: str) -> None:
    candidates.append(
        {
            "source": source,
            "pattern": pattern,
            "matched_text": text,
            "local_time": value.replace(tzinfo=tz).isoformat(),
            "utc_time": value.replace(tzinfo=tz).astimezone(dt.timezone.utc).isoformat(),
            "confidence": confidence,
        }
    )


def parse_text_timestamps(source: str, text: str, tz: ZoneInfo) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for name, regex in TIMESTAMP_PATTERNS:
        for match in regex.finditer(text):
            nums = [int(g) for g in match.groups()]
            if len(nums) == 6:
                value = valid_dt(*nums)
                confidence = "high"
            elif len(nums) == 5:
                value = valid_dt(nums[0], nums[1], nums[2], nums[3], nums[4])
                confidence = "medium"
            else:
                value = valid_dt(nums[0], nums[1], nums[2])
                confidence = "low"
            if value is not None:
                add_candidate(candidates, source, name, match.group(0), value, tz, confidence)
    return candidates


def parse_tag_timestamp(key: str, value: Any, tz: ZoneInfo) -> list[dict[str, Any]]:
    text = str(value)
    out = []
    normalized = text.strip()
    if not normalized:
        return out
    normalized = normalized.replace("Z", "+00:00")
    for candidate_text in [normalized, normalized.replace(" ", "T")]:
        try:
            parsed = dt.datetime.fromisoformat(candidate_text)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            local = parsed.replace(tzinfo=tz)
        else:
            local = parsed.astimezone(tz)
        out.append(
            {
                "source": f"tag:{key}",
                "pattern": "iso8601",
                "matched_text": text,
                "local_time": local.isoformat(),
                "utc_time": local.astimezone(dt.timezone.utc).isoformat(),
                "confidence": "high",
            }
        )
        return out
    out.extend(parse_text_timestamps(f"tag:{key}", text, tz))
    return out


def timestamp_candidates(path: Path, rel_path: str, tags: dict[str, Any], tz: ZoneInfo) -> list[dict[str, Any]]:
    candidates = parse_text_timestamps("basename", path.name, tz)
    candidates.extend(parse_text_timestamps("path", rel_path, tz))
    seen = {(c["source"], c["matched_text"], c["utc_time"]) for c in candidates}
    for key, value in sorted(tags.items()):
        if key in TAG_DATETIME_KEYS or "date" in key or "time" in key:
            for cand in parse_tag_timestamp(key, value, tz):
                sig = (cand["source"], cand["matched_text"], cand["utc_time"])
                if sig not in seen:
                    candidates.append(cand)
                    seen.add(sig)
    return candidates


def iter_files(root: Path, exts: set[str] | None, limit: int) -> Iterable[Path]:
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".git"))
        for filename in sorted(filenames):
            path = Path(dirpath) / filename
            if exts is not None and path.suffix.lower() not in exts:
                continue
            yield path
            count += 1
            if limit and count >= limit:
                return


def output_paths(out: str, dir_style: bool) -> tuple[Path, Path]:
    base = Path(out)
    if dir_style:
        base.mkdir(parents=True, exist_ok=True)
        return base / "nas-scan.jsonl", base / "nas-scan.csv"
    base.parent.mkdir(parents=True, exist_ok=True)
    return base.with_suffix(".jsonl"), base.with_suffix(".csv")


def scan() -> int:
    args = parse_args()
    root = Path(args.root).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        print(f"error: root is not a directory: {root}", file=sys.stderr)
        return 2
    try:
        tz = ZoneInfo(args.timezone)
    except ZoneInfoNotFoundError:
        print(f"error: unknown timezone: {args.timezone}", file=sys.stderr)
        return 2

    exts = normalize_extensions(args.include_extensions)
    jsonl_path, csv_path = output_paths(args.out, args.out_dir_style)
    scan_id = dt.datetime.now(dt.timezone.utc).strftime("nas-scan-%Y%m%dT%H%M%SZ")
    ffprobe_path = None if args.no_ffprobe else shutil.which(args.ffprobe) or args.ffprobe
    started = dt.datetime.now(dt.timezone.utc).isoformat()

    header = {
        "record_type": "scan_header",
        "scan_id": scan_id,
        "started_at": started,
        "root_basename": root.name,
        "timezone": args.timezone,
        "include_extensions": "*" if exts is None else sorted(exts),
        "redact_parent_dirs": args.redact_parent_dirs,
        "hash_mode": args.hash_mode,
        "hash_prefix_bytes": args.hash_prefix_bytes if args.hash_mode == "prefix" else None,
        "ffprobe": None if args.no_ffprobe else ffprobe_path,
        "scanner": "scripts/nas-scan.py",
        "scanner_version": 1,
    }

    rows = 0
    with jsonl_path.open("w", encoding="utf-8") as jf, csv_path.open("w", encoding="utf-8", newline="") as cf:
        writer = csv.DictWriter(cf, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        jf.write(json.dumps(header, sort_keys=True) + "\n")

        for row_index, path in enumerate(iter_files(root, exts, args.limit), start=1):
            error_parts: list[str] = []
            try:
                stat = path.stat()
                rel_path, parent_path = safe_rel_path(path, root, args.redact_parent_dirs)
                row: dict[str, Any] = {
                    "record_type": "media_file",
                    "scan_id": scan_id,
                    "row_index": row_index,
                    "status": "ok",
                    "rel_path": rel_path,
                    "parent_path": parent_path,
                    "basename": path.name,
                    "extension": path.suffix.lower(),
                    "size_bytes": stat.st_size,
                    "fs_mtime": iso_from_timestamp(stat.st_mtime, tz),
                    "fs_ctime": iso_from_timestamp(stat.st_ctime, tz),
                    "fs_atime": iso_from_timestamp(stat.st_atime, tz),
                    "fs_mtime_utc": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat(),
                    "fs_ctime_utc": dt.datetime.fromtimestamp(stat.st_ctime, dt.timezone.utc).isoformat(),
                    "fs_atime_utc": dt.datetime.fromtimestamp(stat.st_atime, dt.timezone.utc).isoformat(),
                    "hash_mode": args.hash_mode,
                    "sha256": None,
                    "ffprobe_ok": False,
                    "error": "",
                }
                try:
                    row["sha256"] = hash_file(path, args.hash_mode, args.hash_prefix_bytes)
                except OSError as exc:
                    error_parts.append(f"hash failed: {exc}")

                probe: dict[str, Any] = {}
                if not args.no_ffprobe:
                    ok, probe, probe_error = run_ffprobe(path, ffprobe_path or args.ffprobe)
                    row["ffprobe_ok"] = ok
                    if probe_error:
                        error_parts.append(probe_error)
                summary = media_summary(probe)
                row["media"] = summary
                for key, value in summary.items():
                    if key != "tags":
                        row[key] = value
                tags = summary.get("tags") or {}
                row["tag_creation_time"] = tags.get("creation_time")
                row["tag_date"] = tags.get("date")
                row["tags_json"] = json.dumps(tags, sort_keys=True)
                row["timestamp_candidates"] = timestamp_candidates(path, rel_path, tags, tz)
                row["timestamp_candidates_json"] = json.dumps(row["timestamp_candidates"], sort_keys=True)
                if error_parts:
                    row["status"] = "partial"
                    row["error"] = "; ".join(error_parts)

            except Exception as exc:  # keep scanner moving on odd NAS files
                try:
                    rel_path, parent_path = safe_rel_path(path, root, args.redact_parent_dirs)
                except Exception:
                    rel_path, parent_path = path.name, ""
                row = {
                    "record_type": "media_file",
                    "scan_id": scan_id,
                    "row_index": row_index,
                    "status": "error",
                    "rel_path": rel_path,
                    "parent_path": parent_path,
                    "basename": path.name,
                    "extension": path.suffix.lower(),
                    "hash_mode": args.hash_mode,
                    "ffprobe_ok": False,
                    "tags_json": "{}",
                    "timestamp_candidates": [],
                    "timestamp_candidates_json": "[]",
                    "error": repr(exc),
                }

            jf.write(json.dumps(row, sort_keys=True, default=str) + "\n")
            writer.writerow(row)
            rows += 1

    print(f"scanned {rows} file(s)")
    print(f"jsonl: {jsonl_path}")
    print(f"csv:   {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(scan())
