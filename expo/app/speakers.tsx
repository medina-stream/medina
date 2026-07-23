import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AudioModule, RecordingPresets } from "expo-audio";
import { File } from "expo-file-system";
import { AppShell, SettingsBackButton } from "../components/MainNavigation";
import { Button, Card, Screen } from "../components/ui";
import { Icon } from "../components/Icon";
import {
  createSpeaker,
  deleteSpeaker,
  deleteSpeakerSample,
  getSpeakers,
  updateSpeaker,
  uploadSpeakerSample,
  type Speaker,
} from "../lib/medina";
import { useTheme, type AppTheme } from "../lib/theme";

type NativeRecorder = InstanceType<typeof AudioModule.AudioRecorder>;
type WebRecorder = {
  chunks: Blob[];
  recorder: MediaRecorder;
  stream: MediaStream;
};
type SampleRecorder =
  | { kind: "native"; recorder: NativeRecorder }
  | { kind: "web"; recorder: WebRecorder };

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function getWebMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function getWebExtension(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

function fileNameForSample(extension: string) {
  return `sample-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

async function recordedFileFromNativeUri(uri: string) {
  const file = new File(uri);
  return {
    arrayBuffer: () => file.arrayBuffer(),
    name: fileNameForSample("m4a"),
    type: file.type || "audio/mp4",
  };
}

function recordedFileFromWebBlob(blob: Blob) {
  return {
    arrayBuffer: () => blob.arrayBuffer(),
    name: fileNameForSample(getWebExtension(blob.type)),
    type: blob.type || "audio/webm",
  };
}

function confirmDestructive(message: string, action: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(message)) action();
    return;
  }
  Alert.alert("Confirm", message, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: action },
  ]);
}

function SpeakerCard({ onChanged, speaker, styles }: {
  onChanged: (speaker?: Speaker) => void;
  speaker: Speaker;
  styles: ReturnType<typeof createStyles>;
}) {
  const theme = useTheme();
  const [name, setName] = useState(speaker.name);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<SampleRecorder | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(speaker.name);
  }, [speaker.id, speaker.name]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onChanged(await updateSpeaker(speaker.id, { name }));
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function startSample() {
    setError(null);
    try {
      if (Platform.OS === "web") {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Browser microphone recording is not available.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = getWebMimeType();
        const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => setError("MediaRecorder error.");
        recorder.start();
        setRecording({ kind: "web", recorder: { chunks, recorder, stream } });
        return;
      }

      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("Microphone permission denied.");
      const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording({ kind: "native", recorder });
    } catch (nextError) {
      setError((nextError as Error).message);
    }
  }

  async function stopSample() {
    const active = recording;
    if (!active) return;
    setRecording(null);
    setBusy(true);
    setError(null);
    try {
      if (active.kind === "web") {
        const { chunks, recorder, stream } = active.recorder;
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve();
          recorder.stop();
        });
        stream.getTracks().forEach((track) => track.stop());
        if (chunks.length === 0) throw new Error("Recording produced no audio.");
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        onChanged(await uploadSpeakerSample(speaker.id, recordedFileFromWebBlob(blob)));
        return;
      }

      await active.recorder.stop();
      if (!active.recorder.uri) throw new Error("Recording produced no file.");
      onChanged(await uploadSpeakerSample(speaker.id, await recordedFileFromNativeUri(active.recorder.uri)));
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeSample(sampleName: string) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await deleteSpeakerSample(speaker.id, sampleName));
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={styles.card}>
      <View style={styles.nameRow}>
        <TextInput
          accessibilityLabel="Speaker name"
          autoCapitalize="words"
          onChangeText={setName}
          placeholder="Speaker name"
          placeholderTextColor={theme.colors.muted}
          style={styles.nameInput}
          value={name}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save speaker"
          accessibilityState={{ busy, disabled: busy || recording !== null || name.trim().length === 0 }}
          disabled={busy || recording !== null || name.trim().length === 0}
          onPress={() => void save()}
          style={({ pressed }) => [
            styles.saveButton,
            pressed && styles.pressed,
            (busy || recording !== null || name.trim().length === 0) && styles.disabled,
          ]}
        >
          {busy ? <ActivityIndicator color="#ffffff" size="small" /> : <Icon name="check" size={22} color="#ffffff" />}
        </Pressable>
      </View>
      <View style={styles.samplesList}>
        {speaker.samples.length === 0 ? (
          <Text style={styles.helpText}>No voice samples yet.</Text>
        ) : speaker.samples.map((sample) => (
          <View key={sample.key} style={styles.sampleRow}>
            <View style={styles.sampleMain}>
              <Text style={styles.sampleName}>{sample.name}</Text>
              <Text style={styles.sampleMeta}>{sample.contentType} · {formatBytes(sample.size)}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() => confirmDestructive("Delete this sample?", () => void removeSample(sample.name))}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            >
              <Icon name="close" size={18} color={theme.colors.danger} />
            </Pressable>
          </View>
        ))}
      </View>
      <Button disabled={busy} onPress={() => recording ? void stopSample() : void startSample()}>
        {recording ? "Stop sample" : "Record sample"}
      </Button>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <Button
        variant="secondary"
        disabled={busy || recording !== null}
        onPress={() => confirmDestructive(`Delete ${speaker.name}?`, async () => {
          setBusy(true);
          try {
            await deleteSpeaker(speaker.id);
            onChanged(undefined);
          } finally {
            setBusy(false);
          }
        })}
      >
        Delete speaker
      </Button>
    </Card>
  );
}

export default function SpeakersScreen() {
  const theme = useTheme();
  const styles = createStyles(theme);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setSpeakers(await getSpeakers());
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const orderedSpeakers = useMemo(
    () => [...speakers].sort((left, right) => Number(left.id) - Number(right.id)),
    [speakers],
  );

  async function addSpeaker() {
    setSaving(true);
    setError(null);
    try {
      const nextNumber = orderedSpeakers.reduce((max, speaker) => Math.max(max, Number(speaker.id) || 0), 0) + 1;
      const created = await createSpeaker({ name: `Speaker ${nextNumber}` });
      setSpeakers((current) => [...current.filter((item) => item.id !== created.id), created]);
    } catch (nextError) {
      setError((nextError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function mergeSpeaker(next?: Speaker) {
    setSpeakers((current) => next
      ? [...current.filter((item) => item.id !== next.id), next]
      : current.filter((item) => item.id !== undefined));
    void refresh();
  }

  return (
    <AppShell>
      <Screen>
        <SettingsBackButton />
        <Text style={styles.title}>Voiceprints</Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {loading ? <ActivityIndicator color={theme.colors.muted} /> : null}
        {!loading && orderedSpeakers.length === 0 ? <Text style={styles.emptyText}>No speakers yet.</Text> : null}
        {orderedSpeakers.map((speaker) => (
          <SpeakerCard key={speaker.id} speaker={speaker} onChanged={mergeSpeaker} styles={styles} />
        ))}
        <Button disabled={saving} onPress={() => void addSpeaker()}>{saving ? "Adding…" : "Add Speaker"}</Button>
      </Screen>
    </AppShell>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    title: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.bold,
      fontSize: 30,
      letterSpacing: -0.7,
      lineHeight: 36,
    },
    card: {
      gap: theme.space.lg,
    },
    nameRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.sm,
    },
    nameInput: {
      backgroundColor: theme.colors.control,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      color: theme.colors.primaryText,
      flex: 1,
      fontFamily: theme.fonts.regular,
      fontSize: 18,
      padding: theme.space.md,
    },
    saveButton: {
      alignItems: "center",
      backgroundColor: theme.colors.accentStrong,
      borderRadius: theme.radii.pill,
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    disabled: {
      opacity: 0.55,
    },
    helpText: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 13,
      lineHeight: 19,
    },
    emptyText: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 15,
      textAlign: "center",
    },
    errorText: {
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium,
      fontSize: 13,
      lineHeight: 19,
    },
    samplesList: {
      gap: theme.space.sm,
    },
    sampleRow: {
      alignItems: "center",
      backgroundColor: theme.colors.control,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      flexDirection: "row",
      gap: theme.space.md,
      justifyContent: "space-between",
      padding: theme.space.md,
    },
    sampleMain: {
      flex: 1,
      gap: theme.space.xs,
      minWidth: 0,
    },
    sampleName: {
      color: theme.colors.primaryText,
      fontFamily: theme.fonts.semibold,
      fontSize: 14,
    },
    sampleMeta: {
      color: theme.colors.muted,
      fontFamily: theme.fonts.regular,
      fontSize: 12,
    },
    iconButton: {
      padding: theme.space.sm,
    },
    pressed: {
      opacity: 0.68,
    },
  });
}
