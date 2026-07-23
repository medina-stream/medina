import { afterEach, describe, expect, test } from "bun:test";

import {
  createCaptureFilePath,
  dateForDayId,
  dayIdForDate,
  dayIntervalIso,
  getCaptureCommands,
  parseCaptureArgs,
  readProcessOutput,
  resolveDayCount,
  resolveDaySpec,
} from "./medina-cli";

afterEach(() => {
  delete process.env.MEDINA_RECORDER;
});

describe("dayIdForDate / dateForDayId", () => {
  test("round-trips through 5-digit-year day ids", () => {
    const id = dayIdForDate(new Date(Date.UTC(2026, 4, 21)));
    expect(id).toBe("020260521");
    const back = dateForDayId(id);
    expect(back.toISOString()).toBe("2026-05-21T00:00:00.000Z");
  });
});

describe("resolveDaySpec", () => {
  const now = new Date(Date.UTC(2026, 4, 21));

  test("defaults to today", () => {
    expect(resolveDaySpec(undefined, now)).toBe("020260521");
    expect(resolveDaySpec("today", now)).toBe("020260521");
  });

  test("yesterday", () => {
    expect(resolveDaySpec("yesterday", now)).toBe("020260520");
  });

  test("N days ago via bare integer, Nd, or -N", () => {
    expect(resolveDaySpec("2", now)).toBe("020260519");
    expect(resolveDaySpec("7d", now)).toBe("020260514");
    expect(resolveDaySpec("-3", now)).toBe("020260518");
  });

  test("YYYY-MM-DD", () => {
    expect(resolveDaySpec("2026-05-15", now)).toBe("020260515");
  });

  test("raw day ids passthrough", () => {
    expect(resolveDaySpec("020260515", now)).toBe("020260515");
    expect(resolveDaySpec("20260515", now)).toBe("020260515");
  });

  test("throws on garbage", () => {
    expect(() => resolveDaySpec("banana", now)).toThrow("Unrecognized day spec");
  });
});

describe("resolveDayCount", () => {
  test("defaults to a 7-day window", () => {
    expect(resolveDayCount(undefined)).toBe(7);
  });

  test("parses ISO durations like P30D", () => {
    expect(resolveDayCount("P30D")).toBe(30);
    expect(resolveDayCount("P1D")).toBe(1);
  });

  test("parses 7d shorthand", () => {
    expect(resolveDayCount("7d")).toBe(7);
    expect(resolveDayCount("30")).toBe(30);
  });
});

describe("dayIntervalIso", () => {
  test("renders ISO 8601 day interval", () => {
    expect(dayIntervalIso("020260521")).toBe("2026-05-21T00:00:00Z/P1D");
  });
});

describe("createCaptureFilePath", () => {
  test("writes captures into /tmp as wav files", () => {
    const outputPath = createCaptureFilePath();
    expect(outputPath.startsWith("/tmp/medina-capture-")).toBe(true);
    expect(outputPath.endsWith(".wav")).toBe(true);
  });

  test("uses the requested extension", () => {
    expect(createCaptureFilePath(".mp3").endsWith(".mp3")).toBe(true);
  });
});

describe("getCaptureCommands", () => {
  test("uses the default recorder fallback order", () => {
    expect(getCaptureCommands("/tmp/test.wav")).toEqual([
      { cmd: "arecord", args: ["-f", "cd", "-t", "wav", "/tmp/test.wav"] },
      { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "alsa", "-i", "default", "-ac", "1", "-ar", "16000", "-y", "/tmp/test.wav"] },
      { cmd: "rec", args: ["-c", "1", "-r", "16000", "/tmp/test.wav"] },
      { cmd: "sox", args: ["-d", "-c", "1", "-r", "16000", "/tmp/test.wav"] },
    ]);
  });

  test("appends the output path to MEDINA_RECORDER", () => {
    process.env.MEDINA_RECORDER = "ffmpeg -f avfoundation -i :0";
    expect(getCaptureCommands("/tmp/test.wav")).toEqual([
      { cmd: "ffmpeg", args: ["-f", "avfoundation", "-i", ":0", "/tmp/test.wav"] },
    ]);
  });
});

describe("parseCaptureArgs", () => {
  test("parses capture with just a base url", () => {
    expect(parseCaptureArgs(["http://localhost:4000"])).toEqual({
      baseUrl: "http://localhost:4000",
      speakText: undefined,
    });
  });

  test("parses --speak with a separate text argument", () => {
    expect(parseCaptureArgs(["--speak", "Hello from the CLI!", "http://localhost:4000"])).toEqual({
      baseUrl: "http://localhost:4000",
      speakText: "Hello from the CLI!",
    });
  });

  test("parses --speak=text", () => {
    expect(parseCaptureArgs(["--speak=Hello from the CLI!"])).toEqual({
      baseUrl: undefined,
      speakText: "Hello from the CLI!",
    });
  });

  test("rejects unknown capture options", () => {
    expect(() => parseCaptureArgs(["--bogus"])).toThrow("Unknown capture option: --bogus");
  });
});

describe("readProcessOutput", () => {
  test("reads subprocess stdout bytes instead of stringifying the stream object", async () => {
    const proc = Bun.spawn(["bash", "-lc", "printf 'hello'"], {
      stderr: "inherit",
      stdin: "ignore",
      stdout: "pipe",
    });
    const output = await readProcessOutput(proc);
    expect(new TextDecoder().decode(output)).toBe("hello");
  });
});
