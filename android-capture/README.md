# Bucket Capture for Android

Bucket Capture is a native Kotlin app that records 15-minute M4A audio segments
and fused-location fixes into app-private storage, then streams each immutable
payload directly to an S3-compatible bucket. Its credentials only need object
write permission. The app never calls ListBucket, GET, HEAD, or DELETE.

An HTTP 2xx response to a SigV4-signed PUT is the confirmation boundary. Room
stores stable object keys in a `PENDING`/`UPLOADED` manifest; an ambiguous or
interrupted request re-PUTs the same bytes at the same key. `Content-MD5` is sent
on every PUT. WorkManager retries constrained uploads with exponential backoff.

## Build

Prerequisites:

- JDK 17
- Android SDK Platform 35 and Build Tools 35.x
- `ANDROID_HOME` or `ANDROID_SDK_ROOT` configured

Then run:

```sh
./gradlew assembleDebug
```

The APK is produced under `app/build/outputs/apk/debug/`. The Gradle wrapper
scripts/properties are committed; `gradle/wrapper/gradle-wrapper.jar` must be
generated with a trusted Gradle 8.11.1 installation (`gradle wrapper`) if it is
not present in the checkout.

## Configure

Open **Bucket settings** and enter an HTTPS S3-compatible endpoint, bucket,
region, access key, secret key, and optional prefix. Credentials are encrypted
using a non-exportable Android Keystore AES key. **Test PUT** signs and writes a
zero-byte object below `probe/`; it remains there because the app deliberately
has no delete permission.

Use a bucket policy limited to `s3:PutObject` on the intended bucket/prefix. Do
not grant `s3:ListBucket`, `s3:GetObject`, or `s3:DeleteObject`. The endpoint is
used in path-style form: `https://endpoint/bucket/key`.

Grant microphone and foreground location when starting capture. Grant
background location separately from Android's app settings if capture should
retain GPS while the UI is closed. On Android 13+, allow notifications. The app
links to battery-optimization settings; exemption is optional but often useful
for continuous capture on vendor-customized Android builds.

## Reliability notes

- Capture runs in a foreground service with an ongoing notification.
- A boot/package-update receiver restores upload work and prompts the user to
  tap to resume capture; modern Android does not allow silent microphone resume.
- Pending payloads are never deleted for age or storage pressure. Audio stops
  below 512 MiB free rather than evicting unconfirmed data.
- Photo capture is intentionally not included; it can later use the same spool
  and manifest.

Before relying on the app, test permissions, Doze/screen-off behavior, reboot,
process death during recording and upload, network transitions, bad credentials,
and low storage on the actual device. A signed release configuration and field
soak testing remain deployment work.
