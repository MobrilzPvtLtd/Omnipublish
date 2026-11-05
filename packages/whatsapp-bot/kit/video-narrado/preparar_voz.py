"""Prepara la muestra de voz de la persona: cualquier audio → voz/referencia.wav + voz/referencia.txt (una vez).

Uso:  .venv/Scripts/python preparar_voz.py "<audio>"      (mp3, m4a, wav, ogg, nota de voz de WhatsApp…)

OmniVoice clona a partir de 6-10 s de voz Y SU TEXTO EXACTO. Si el trozo empieza o acaba a mitad de palabra,
esa sílaba sin texto se cuela en todo lo que genera (p. ej. un «al» entre frases). Por eso el corte se hace
SOLO en pausas (≥ 0,25 s) y el texto lo saca Whisper de ese mismo trozo.
Mejor muestra = mejor clon: 1-3 min hablando con naturalidad, en una habitación callada, sin música.
"""
import re, shutil, subprocess, sys
from pathlib import Path

import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel

RAIZ = Path(__file__).resolve().parent
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
SR, MIN_S, MAX_S, PAUSA = 24000, 6.0, 10.0, 0.25
if len(sys.argv) < 2:
    sys.exit(__doc__)
ent = Path(sys.argv[1])
if not ent.exists():
    sys.exit(f"No existe {ent}")

def lee(sr):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(ent), "-af", "highpass=f=70,afftdn=nf=-40:nr=6",
                          "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32)

w16, w = lee(16000), lee(SR)
if len(w) / SR < 12:
    sys.exit(f"El audio dura {len(w)/SR:.0f} s: hacen falta al menos 15 s hablando (mejor 1-3 min).")
asr = WhisperModel("small", device="cpu", compute_type="int8")
segs, _ = asr.transcribe(w16, language="es", word_timestamps=True, vad_filter=True)
pal = [p for s in segs for p in s.words]

# Candidatos: tramos que empiezan tras una pausa y acaban antes de otra, de 6 a 10 s, sin pausas largas dentro.
# Gana el MÁS EXPRESIVO (mayor variación de tono, en semitonos): OmniVoice copia también la entonación de la
# muestra, y un tramo explicativo plano da una voz robótica (medido: 5,1 st sonó natural, 3,6 st robótica).
import librosa
f0, vo, _ = librosa.pyin(w16, fmin=70, fmax=300, sr=16000, frame_length=1024, hop_length=160)
semitonos = 12 * np.log2(np.where(vo, f0, np.nan) / 100)
def variacion(a, b):
    s = semitonos[int(a * 100): int(b * 100)]
    return float(np.nanstd(s)) if np.sum(~np.isnan(s)) > 50 else 0.0
pausa_antes = lambda i: i == 0 or pal[i].start - pal[i - 1].end >= PAUSA
pausa_despues = lambda j: j == len(pal) - 1 or pal[j + 1].start - pal[j].end >= PAUSA
mejor = None
for i in range(len(pal)):
    if not pausa_antes(i):
        continue
    for j in range(i, len(pal)):
        d = pal[j].end - pal[i].start
        if d > MAX_S or (j > i and pal[j].start - pal[j - 1].end > 0.8):
            break
        if d < MIN_S or not pausa_despues(j):
            continue
        txt = "".join(p.word for p in pal[i:j + 1]).strip()
        nota = variacion(pal[i].start, pal[j].end)
        if not mejor or nota > mejor[0]:
            mejor = (nota, pal[i].start, pal[j].end, txt)
if not mejor:
    sys.exit("No encuentro 6-10 s de voz seguida entre dos pausas: graba hablando con naturalidad, sin cortes.")
_, a, b, txt = mejor
# Margen DENTRO de las pausas (nunca dentro de una palabra vecina).
a, b = max(0.0, a - 0.12), min(len(w) / SR, b + 0.15)
trozo = w[int(a * SR): int(b * SR)]
trozo = trozo / (np.abs(trozo).max() + 1e-9) * 0.89
(RAIZ / "voz").mkdir(exist_ok=True)
sf.write(RAIZ / "voz" / "referencia.wav", trozo, SR)
(RAIZ / "voz" / "referencia.txt").write_text(txt, encoding="utf-8")
print(f"✓ voz/referencia.wav ({b - a:.1f} s, del segundo {a:.1f} al {b:.1f}, variación de tono "
      f"{mejor[0]:.1f} st) + voz/referencia.txt:\n  «{txt}»")
