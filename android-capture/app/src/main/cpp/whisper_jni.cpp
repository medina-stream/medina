// JNI bridge over whisper.cpp: init a context from a model file, run full
// transcription on 16 kHz mono float PCM, return the segments as JSON.
// The JSON is built here so Kotlin only needs org.json to parse it.

#include <jni.h>

#include <cstdio>
#include <string>
#include <vector>

#include "whisper.h"

namespace {

struct JniString {
    JNIEnv* env;
    jstring js;
    const char* c;
    JniString(JNIEnv* e, jstring s) : env(e), js(s), c(e->GetStringUTFChars(s, nullptr)) {}
    ~JniString() { env->ReleaseStringUTFChars(js, c); }
};

// Minimal JSON string escaper for transcript text.
std::string json_escape(const char* s) {
    std::string out;
    for (; *s; ++s) {
        switch (*s) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if ((unsigned char)*s < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", *s);
                    out += buf;
                } else {
                    out += *s;
                }
        }
    }
    return out;
}

}  // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_dev_exe_bucketcapture_transcribe_WhisperEngine_initNative(JNIEnv* env, jobject /*thiz*/,
                                                               jstring modelPath) {
    JniString path(env, modelPath);
    whisper_context_params cparams = whisper_context_default_params();
    struct whisper_context* ctx = whisper_init_from_file_with_params(path.c, cparams);
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT jstring JNICALL
Java_dev_exe_bucketcapture_transcribe_WhisperEngine_transcribeNative(JNIEnv* env, jobject /*thiz*/,
                                                          jlong ctxHandle, jfloatArray pcm,
                                                          jint nThreads) {
    auto* ctx = reinterpret_cast<struct whisper_context*>(ctxHandle);
    if (ctx == nullptr) return nullptr;

    jfloat* data = env->GetFloatArrayElements(pcm, nullptr);
    jsize n = env->GetArrayLength(pcm);

    whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wparams.print_progress = false;
    wparams.print_special = false;
    wparams.print_realtime = false;
    wparams.print_timestamps = false;
    wparams.translate = false;
    wparams.language = "en";
    wparams.n_threads = nThreads > 0 ? nThreads : 4;
    wparams.audio_ctx = 0;

    std::string json;
    if (whisper_full(ctx, wparams, data, n) == 0) {
        const int n_segments = whisper_full_n_segments(ctx);
        json += "{\"segments\":[";
        std::string full;
        for (int i = 0; i < n_segments; ++i) {
            const char* text = whisper_full_get_segment_text(ctx, i);
            const int64_t t0 = whisper_full_get_segment_t0(ctx, i);
            const int64_t t1 = whisper_full_get_segment_t1(ctx, i);
            if (i > 0) json += ",";
            char seg[64];
            snprintf(seg, sizeof(seg), "{\"start\":%.2f,\"end\":%.2f,",
                     t0 / 100.0, t1 / 100.0);
            json += seg;
            json += "\"text\":\"" + json_escape(text) + "\"}";
            full += text;
        }
        json += "],\"text\":\"" + json_escape(full.c_str()) + "\"}";
    }
    env->ReleaseFloatArrayElements(pcm, data, JNI_ABORT);
    return env->NewStringUTF(json.c_str());
}

JNIEXPORT void JNICALL
Java_dev_exe_bucketcapture_transcribe_WhisperEngine_freeNative(JNIEnv* /*env*/, jobject /*thiz*/,
                                                               jlong ctxHandle) {
    auto* ctx = reinterpret_cast<struct whisper_context*>(ctxHandle);
    if (ctx != nullptr) whisper_free(ctx);
}

}  // extern "C"
