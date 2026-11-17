"""Speech-to-text worker for the Hub's voice dictation.

Runs local Whisper (mlx-whisper on Apple silicon), so audio never leaves the Mac.
The Hub server starts it on first use and talks to it over stdin/stdout, one JSON
object per line:

  in : {"id": "...", "path": "/abs/file.pcm", "lang": "en", "prompt": "hint words"}
       the file is mono 16 kHz signed 16-bit little-endian PCM
  out: {"id": "...", "text": "...", "ms": 412}
       or {"id": "...", "error": "..."}

It prints {"ready": true} once the model is loaded.
"""

import json
import os
import re
import sys
import time

MODEL = os.environ.get("HUB_VOICE_MODEL", "mlx-community/whisper-large-v3-turbo")

# Phrases Whisper is known to invent on silence or noise. Dropped when they are the whole result.
HALLUCINATIONS = {
    "thank you", "thank you.", "thanks for watching", "thanks for watching!", "thank you for watching",
    "thank you for watching.", "you", "bye", "bye.", "so", ".", "okay.", "subtitles by the amara.org community",
}


def words(s):
    return re.sub(r"[^a-z0-9 ]+", "", s.lower()).split()


def drop_prompt_echo(text, prompt):
    """On near-silent audio Whisper can repeat the hint text. Drop sentences of 4+ words lifted from it."""
    if not prompt:
        return text
    hint = " ".join(words(prompt))
    keep = []
    for sent in re.split(r"(?<=[.!?])\s+", text):
        w = words(sent)
        if len(w) >= 4 and " ".join(w) in hint:
            continue
        keep.append(sent)
    return " ".join(keep).strip()


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    import numpy as np
    import mlx_whisper

    def transcribe(audio, lang, prompt):
        r = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=MODEL,
            language=lang or "en",
            initial_prompt=prompt or None,
            condition_on_previous_text=False,
            temperature=0.0,
            no_speech_threshold=0.6,
            verbose=None,
        )
        parts = []
        for seg in r.get("segments", []):
            if seg.get("no_speech_prob", 0) > 0.8 and seg.get("avg_logprob", 0) < -0.7:
                continue
            parts.append(seg.get("text", ""))
        text = drop_prompt_echo(" ".join(p.strip() for p in parts).strip(), prompt)
        if text.lower() in HALLUCINATIONS:
            return ""
        return text

    # Load and warm the model so the first real request is fast.
    transcribe(np.zeros(16000, dtype=np.float32), "en", "")
    out({"ready": True, "model": MODEL})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id", "")
        try:
            t0 = time.time()
            pcm = np.fromfile(req["path"], dtype="<i2")
            audio = pcm.astype(np.float32) / 32768.0
            text = transcribe(audio, req.get("lang") or "en", req.get("prompt") or "") if audio.size >= 4800 else ""
            out({"id": rid, "text": text, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001  report any failure back to the server
            out({"id": rid, "error": str(e)[:300]})


if __name__ == "__main__":
    main()
