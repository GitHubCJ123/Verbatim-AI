// whisper-stream — headless streaming transcription sidecar for Verbatim AI.
//
// Issue #33 (true token-level streaming). This binary is spawned by the app's
// Rust manager (`src-tauri/src/commands/streaming_sidecar.rs`); it is NOT a
// user-facing tool. It replaces the batch "re-transcribe the whole clip per
// partial" pseudo-streaming with a rolling-window whisper.cpp loop fed by the
// app's own PCM frames.
//
// Clean-room note: this is an original implementation written against
// whisper.cpp's public C API (include/whisper.h). It intentionally does NOT
// reuse the upstream `examples/stream` source (which is an SDL2 microphone
// demo). whisper.cpp is MIT-licensed; only its documented public API is used.
//
// ---------------------------------------------------------------------------
// Invocation
//   whisper-stream -m <ggml-model.bin> [-fa] [-l <lang>] [-t <threads>]
//                  [--window-ms <n>] [--step-ms <n>]
//     -m           path to a standard whisper.cpp GGML .bin model (required)
//     -fa          enable flash attention (CUDA/Metal builds)
//     -l/--language language code, or "auto" (default: auto, locked after the
//                  first detection to keep partials stable)
//     -t/--threads decode threads (default: min(4, hw concurrency))
//     --window-ms  rolling context window length in ms (default 10000)
//     --step-ms    emit a partial after this much new audio in ms (default 2000)
//
// Protocol (see docs/proposals/streaming-sidecar.md §2.1)
//   stdin  — repeated chunks, each:
//              [u32 LE sample_count][sample_count x f32 LE]   (16 kHz mono)
//            A chunk with sample_count == 0 is the finalize/flush marker.
//            EOF also finalizes.
//   stdout — one JSON object per line, flushed per line:
//              {"type":"partial","text":"..."}   revisable hypotheses
//              {"type":"final","text":"..."}      exactly one, at the end
//   stderr — diagnostics only; never parsed by the app.
// ---------------------------------------------------------------------------

#include "whisper.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#endif

namespace {

constexpr int kSampleRate = 16000;

struct Options {
    std::string model_path;
    std::string language = "auto";
    bool flash_attn = false;
    int threads = 0;      // 0 => auto
    int window_ms = 10000;
    int step_ms = 2000;
};

void log_line(const std::string &msg) {
    std::fprintf(stderr, "[whisper-stream] %s\n", msg.c_str());
    std::fflush(stderr);
}

// Minimal, correct JSON string escaping for the small set of characters the
// spec requires (RFC 8259). Control chars below 0x20 are emitted as \u00XX.
std::string json_escape(const std::string &in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (unsigned char c : in) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out;
}

void emit_event(const char *type, const std::string &text) {
    std::string line = "{\"type\":\"";
    line += type;
    line += "\",\"text\":\"";
    line += json_escape(text);
    line += "\"}\n";
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);
}

// Collapse leading/trailing whitespace and internal runs to single spaces so
// concatenated windows read cleanly.
std::string normalize_text(const std::string &in) {
    std::string out;
    out.reserve(in.size());
    bool prev_space = true;  // trims leading whitespace
    for (char c : in) {
        const bool is_space = (c == ' ' || c == '\t' || c == '\n' || c == '\r');
        if (is_space) {
            if (!prev_space) {
                out += ' ';
                prev_space = true;
            }
        } else {
            out += c;
            prev_space = false;
        }
    }
    while (!out.empty() && out.back() == ' ') {
        out.pop_back();
    }
    return out;
}

std::string join(const std::string &a, const std::string &b) {
    if (a.empty()) return b;
    if (b.empty()) return a;
    return a + " " + b;
}

// Read exactly `n` bytes from stdin into `dst`. Returns false on EOF/short read.
bool read_exact(void *dst, size_t n) {
    auto *p = static_cast<uint8_t *>(dst);
    size_t got = 0;
    while (got < n) {
        const size_t r = std::fread(p + got, 1, n - got, stdin);
        if (r == 0) {
            return false;  // EOF or error
        }
        got += r;
    }
    return true;
}

bool parse_args(int argc, char **argv, Options &opt) {
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&](const char *flag) -> const char * {
            if (i + 1 >= argc) {
                log_line(std::string("missing value for ") + flag);
                return nullptr;
            }
            return argv[++i];
        };
        if (a == "-m" || a == "--model") {
            const char *v = next(a.c_str());
            if (!v) return false;
            opt.model_path = v;
        } else if (a == "-fa" || a == "--flash-attn") {
            opt.flash_attn = true;
        } else if (a == "-l" || a == "--language") {
            const char *v = next(a.c_str());
            if (!v) return false;
            opt.language = v;
        } else if (a == "-t" || a == "--threads") {
            const char *v = next(a.c_str());
            if (!v) return false;
            opt.threads = std::atoi(v);
        } else if (a == "--window-ms") {
            const char *v = next(a.c_str());
            if (!v) return false;
            opt.window_ms = std::atoi(v);
        } else if (a == "--step-ms") {
            const char *v = next(a.c_str());
            if (!v) return false;
            opt.step_ms = std::atoi(v);
        } else if (a == "-h" || a == "--help") {
            std::fprintf(stderr,
                "usage: whisper-stream -m <model.bin> [-fa] [-l <lang>] "
                "[-t <threads>] [--window-ms n] [--step-ms n]\n");
            return false;
        } else {
            log_line("ignoring unknown argument: " + a);
        }
    }
    if (opt.model_path.empty()) {
        log_line("error: -m <model> is required");
        return false;
    }
    if (opt.window_ms < 1000) opt.window_ms = 1000;
    if (opt.step_ms < 250) opt.step_ms = 250;
    if (opt.threads <= 0) {
        const unsigned hw = std::thread::hardware_concurrency();
        opt.threads = static_cast<int>(std::min(4u, hw == 0 ? 4u : hw));
    }
    return true;
}

class StreamDecoder {
public:
    StreamDecoder(whisper_context *ctx, Options opt)
        : ctx_(ctx),
          opt_(std::move(opt)),
          window_samples_(static_cast<size_t>(opt_.window_ms) * kSampleRate / 1000),
          step_samples_(static_cast<size_t>(opt_.step_ms) * kSampleRate / 1000),
          language_(opt_.language) {}

    // Append a chunk of samples; may emit a partial when enough new audio has
    // accumulated, and commits (freezes) the window when it overflows.
    void push(const std::vector<float> &samples) {
        window_.insert(window_.end(), samples.begin(), samples.end());
        new_since_step_ += samples.size();

        if (window_.size() >= window_samples_) {
            // Window is full: transcribe it, freeze the text into the committed
            // prefix, and start a fresh window. Committing on a clean boundary
            // (rather than overlapping) keeps partials strictly monotonic and
            // avoids duplicated words across the seam.
            const std::string text = transcribe(window_);
            committed_ = join(committed_, text);
            window_.clear();
            new_since_step_ = 0;
            emit_event("partial", committed_);
            return;
        }

        if (new_since_step_ >= step_samples_) {
            new_since_step_ = 0;
            const std::string text = transcribe(window_);
            emit_event("partial", join(committed_, text));
        }
    }

    // Finalize: transcribe whatever remains and emit exactly one final event.
    void finalize() {
        std::string text;
        if (!window_.empty()) {
            text = transcribe(window_);
        }
        emit_event("final", join(committed_, text));
    }

private:
    std::string transcribe(const std::vector<float> &pcm) {
        if (pcm.empty()) return "";

        whisper_full_params wparams =
            whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        wparams.n_threads        = opt_.threads;
        wparams.translate        = false;
        wparams.no_context       = true;   // each window decoded independently
        wparams.no_timestamps    = true;
        wparams.single_segment   = false;
        wparams.print_progress   = false;
        wparams.print_realtime   = false;
        wparams.print_special    = false;
        wparams.print_timestamps = false;
        wparams.suppress_blank   = true;
        wparams.language         = language_.c_str();

        const int rc =
            whisper_full(ctx_, wparams, pcm.data(), static_cast<int>(pcm.size()));
        if (rc != 0) {
            log_line("whisper_full failed rc=" + std::to_string(rc));
            return "";
        }

        // Lock onto the detected language after the first successful decode so
        // subsequent windows don't flip languages mid-recording.
        if (language_ == "auto") {
            const int lang_id = whisper_full_lang_id(ctx_);
            if (lang_id >= 0) {
                const char *lang = whisper_lang_str(lang_id);
                if (lang != nullptr && lang[0] != '\0') {
                    language_ = lang;
                }
            }
        }

        std::string out;
        const int n = whisper_full_n_segments(ctx_);
        for (int i = 0; i < n; ++i) {
            const char *seg = whisper_full_get_segment_text(ctx_, i);
            if (seg != nullptr) {
                out += seg;
            }
        }
        return normalize_text(out);
    }

    whisper_context *ctx_;
    Options opt_;
    size_t window_samples_;
    size_t step_samples_;
    std::string language_;

    std::vector<float> window_;
    std::string committed_;
    size_t new_since_step_ = 0;
};

}  // namespace

int main(int argc, char **argv) {
#if defined(_WIN32)
    // stdin/stdout carry raw binary framing + newline-delimited JSON; on Windows
    // they must be in binary mode to avoid CRLF translation corrupting frames.
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    Options opt;
    if (!parse_args(argc, argv, opt)) {
        return 2;
    }

    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu    = true;
    cparams.flash_attn = opt.flash_attn;

    whisper_context *ctx =
        whisper_init_from_file_with_params(opt.model_path.c_str(), cparams);
    if (ctx == nullptr) {
        log_line("failed to load model: " + opt.model_path);
        // Still emit a final so the app's reader never hangs waiting for one.
        emit_event("final", "");
        return 1;
    }

    StreamDecoder decoder(ctx, opt);

    // Main framing loop: [u32 LE count][count x f32 LE]; count==0 or EOF ends.
    std::vector<float> chunk;
    while (true) {
        uint32_t count = 0;
        if (!read_exact(&count, sizeof(count))) {
            break;  // EOF => finalize below
        }
        if (count == 0) {
            break;  // explicit finalize marker
        }
        chunk.resize(count);
        if (!read_exact(chunk.data(), static_cast<size_t>(count) * sizeof(float))) {
            log_line("short read on payload; finalizing");
            break;
        }
        decoder.push(chunk);
    }

    decoder.finalize();

    whisper_free(ctx);
    return 0;
}
