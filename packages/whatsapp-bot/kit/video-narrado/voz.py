"""Voz del patrón «Carrusel → vídeo narrado»: plan.json → public/voz.wav + tiempos.json.

Motor: OmniVoice (k2-fsa). Clona la voz de la persona a partir de voz/referencia.wav + voz/referencia.txt
(los deja preparar_voz.py) y copia también su forma de hablar: su acento, su «z», su entonación.

Cada ESCENA se genera de una vez (no frase a frase): así la voz encadena las frases como una persona.
Generadas por separado, cada frase empezaba «de cero» con la misma curva plana y sonaba robótica.
Whisper escucha después cada escena: comprueba que dice el texto (si no, la repite con otra semilla) y da
el segundo exacto en que empieza cada frase, que es lo que usan las animaciones y los subtítulos.

LICENCIA: el código de OmniVoice es Apache-2.0, pero sus MODELOS son CC-BY-NC (no comercial). Quien lo usa
para su negocio lo hace bajo su responsabilidad; avísale la primera vez.

Uso:  .venv/Scripts/python voz.py                     (Windows; en Mac/Linux .venv/bin/python)
      .venv/Scripts/python voz.py --prueba "Una frase"  (prueba rápida → public/voz.wav)
"""
import argparse, difflib, json, re, shutil, subprocess, sys, time, unicodedata
from pathlib import Path

import numpy as np
import soundfile as sf
import torch

RAIZ = Path(__file__).resolve().parent
P_ESCENA = 0.45                 # pausa (s) entre escenas (dentro de la escena, las pausas las pone la voz)
LOTE = 2                        # escenas por llamada (más = más rápido, pero más memoria de GPU)
PASOS, GUIA = 32, 1.5           # medido en A/B: 32 pasos + guía 1,5 = la entonación menos robótica
# Limpieza final (ffmpeg): ruido de fondo suave, compresión lenta, fuera retumbe (<80 Hz) y volumen estándar
# de redes (−16 LUFS, pico −1,5 dB). Medido: compresor rápido o deesser AÑADEN graves; cambiar el tono con
# rubberband suena «doble». Nada de eso.
MASTER = ("afftdn=nf=-45:nr=8,"
          "acompressor=threshold=-18dB:ratio=2:attack=20:release=250:knee=6,"
          "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11")
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
# Ritmo según la «energia» de la escena (la misma etiqueta que mueve la música). La subida de tono la da el
# propio texto: el modelo entona «¡…!» y «¿…?» como lo haría la persona.
VELOCIDAD = {"calma": 0.97, "tension": 1.0, "impulso": 1.05, "climax": 1.03}

def frases_de(t):
    fr = [f for f in re.split(r"(?<=[.!?…])\s+", t.strip()) if f]
    if len(fr) > 1 and len(fr[0].split()) == 1:  # «Dos.» va pegado a su frase
        fr[0:2] = [fr[0] + " " + fr[1]]
    return fr

def norma(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"\b(uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)\b", lambda m: str("uno dos tres cuatro cinco seis siete ocho nueve".split().index(m.group(1)) + 1), s)
    return re.sub(r"[^a-z0-9 ]", " ", s).split()

def recorta_silencio(w, sr, umbral=0.01):
    """Quita el silencio del principio y del final, con fundidos (sin «clics»). Devuelve (audio, desplazamiento s)."""
    idx = np.where(np.abs(w) > umbral)[0]
    if not len(idx):
        return w, 0.0
    a, b = max(0, idx[0] - int(0.03 * sr)), min(len(w), idx[-1] + int(0.08 * sr))
    w = w[a:b].copy()
    fi, fo = min(len(w) // 4, int(0.012 * sr)), min(len(w) // 4, int(0.05 * sr))
    if fi: w[:fi] *= np.sin(np.linspace(0, np.pi / 2, fi)) ** 2
    if fo: w[-fo:] *= np.cos(np.linspace(0, np.pi / 2, fo)) ** 2
    return w, a / sr

def masteriza(cruda, final):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(cruda), "-af", MASTER,
                    "-ar", "48000", "-ac", "1", str(final)], check=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default=str(RAIZ / "voz" / "referencia.wav"), help="muestra de voz (preparar_voz.py)")
    ap.add_argument("--plan", default="plan.json")
    ap.add_argument("--solo", default="")
    ap.add_argument("--prueba", default="")
    ap.add_argument("--pasos", type=int, default=PASOS, help="32 = máxima calidad (por defecto), 16 u 8 = más rápido y más plano")
    ap.add_argument("--salida", default="public/voz.wav")
    ap.add_argument("--umbral", type=float, default=0.8, help="parecido mínimo texto/lo que oye Whisper")
    ap.add_argument("--sin-master", action="store_true")
    a = ap.parse_args()

    ref = Path(a.ref)
    ref_txt = ref.with_suffix(".txt")
    if not ref.exists() or not ref_txt.exists():
        sys.exit(f"Falta {ref} o {ref_txt}: prepara la voz con preparar_voz.py \"<audio de la persona>\".")
    from omnivoice import OmniVoice
    from faster_whisper import WhisperModel
    cuda = torch.cuda.is_available()
    t0 = time.time()
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0" if cuda else "cpu",
                                      dtype=torch.float16 if cuda else torch.float32)
    prompt = model.create_voice_clone_prompt(ref_audio=str(ref), ref_text=ref_txt.read_text(encoding="utf-8").strip())
    sr = model.sampling_rate
    asr = WhisperModel("small", device="cpu", compute_type="int8")
    print(f"modelo en {'cuda' if cuda else 'cpu'} · {time.time() - t0:.1f}s", flush=True)

    def escucha(w):
        n = int(len(w) * 16000 / sr)
        a16 = np.interp(np.linspace(0, len(w) - 1, n), np.arange(len(w)), w).astype(np.float32)
        return [p for s in asr.transcribe(a16, language="es", word_timestamps=True)[0] for p in s.words]

    def analiza(texto, w):
        """→ (parecido 0-1, lo oído, inicio en s de cada frase). Alinea las palabras del texto con las de Whisper."""
        pal = escucha(w)
        oido = [(t, p.start) for p in pal for t in norma(p.word)]
        txt = norma(texto)
        sm = difflib.SequenceMatcher(None, txt, [t for t, _ in oido], autojunk=False)
        mapa = {}
        for bl in sm.get_matching_blocks():
            for k in range(bl.size):
                mapa[bl.a + k] = oido[bl.b + k][1]
        inicios, k = [], 0
        for f in frases_de(texto):
            n = len(norma(f))
            hit = next((mapa[j] for j in range(k, k + n) if j in mapa), None)
            inicios.append(hit)
            k += n
        # Frase sin palabra reconocida: se interpola entre sus vecinas (o por longitud de texto).
        dur = len(w) / sr
        for i, t in enumerate(inicios):
            if t is None:
                prev = inicios[i - 1] if i else 0.0
                nxt = next((x for x in inicios[i + 1:] if x is not None), dur)
                inicios[i] = prev + (nxt - prev) * 0.5 if i else 0.0
        inicios[0] = 0.0
        return sm.ratio(), " ".join(p.word.strip() for p in pal), [round(max(0.0, t - 0.05), 3) for t in inicios]

    def genera(textos, velocidades, semilla):
        torch.manual_seed(semilla)
        outs = []
        for i in range(0, len(textos), LOTE):
            t, v = textos[i:i + LOTE], velocidades[i:i + LOTE]
            r = model.generate(text=t, language=["es"] * len(t), voice_clone_prompt=[prompt] * len(t), speed=v,
                               num_step=a.pasos, guidance_scale=GUIA)
            outs += [recorta_silencio(np.asarray(x, np.float32).squeeze(), sr)[0] for x in r]
        return outs

    def di(textos, velocidades):
        """Genera las escenas (en lotes) y repite con otra semilla solo las que Whisper no reconoce bien."""
        ws = genera(textos, velocidades, 1234)
        mejor = [None] * len(textos)
        for semilla in (77, 2026, None):
            mal = []
            for k, (txt, w) in enumerate(zip(textos, ws)):
                if mejor[k] and mejor[k][0] >= a.umbral:
                    continue
                r, oido, inicios = analiza(txt, w)
                if not mejor[k] or r > mejor[k][0]:
                    mejor[k] = (r, w, inicios)
                if r < a.umbral:
                    mal.append(k); print(f"    ↻ {r:.2f} «{oido}»\n      ← {txt}", flush=True)
            if not mal or semilla is None:
                break
            otra = genera([textos[k] for k in mal], [velocidades[k] for k in mal], semilla)
            ws = list(ws)
            for k, w in zip(mal, otra):
                ws[k] = w
        return [(m[1], m[2]) for m in mejor]

    def guarda(audio):
        final = RAIZ / a.salida
        final.parent.mkdir(parents=True, exist_ok=True)
        if a.sin_master:
            sf.write(final, audio, sr); return
        cruda = final.with_name(final.stem + ".cruda.wav")
        sf.write(cruda, audio, sr)
        masteriza(cruda, final)

    if a.prueba:
        t = time.time(); w, _ = di([a.prueba], [1.0])[0]
        guarda(w)
        print(f"prueba: {len(w)/sr:.1f}s de audio en {time.time()-t:.1f}s → {a.salida}")
        return

    plan = json.loads((RAIZ / a.plan).read_text(encoding="utf-8-sig"))
    solo = [int(x) for x in a.solo.split(",") if x] or None
    escs = [(i, e) for i, e in enumerate(plan["escenas"], 1) if not solo or i in solo]
    t = time.time()
    res = di([e["narracion"] for _, e in escs], [VELOCIDAD.get(e.get("energia"), 1.0) for _, e in escs])
    print(f"voz generada en {time.time() - t:.0f}s", flush=True)
    trozos, escenas, reloj = [], [], 0.0
    for (i, e), (w, inicios) in zip(escs, res):
        trozos += [w, np.zeros(int(P_ESCENA * sr), np.float32)]
        dur = len(w) / sr + P_ESCENA
        escenas.append({"inicio": round(reloj, 3), "dur": round(dur, 3), "frases": inicios})
        reloj += dur
        print(f"  e{i:02d} {len(w)/sr:4.1f}s · frases en {inicios} · {e['narracion'][:60]}", flush=True)
    audio = np.concatenate(trozos)
    guarda(audio)
    (RAIZ / "tiempos.json").write_text(json.dumps({"voz": a.salida, "escenas": escenas}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"✓ {len(audio)/sr:.1f}s de voz → {a.salida} · tiempos.json")

if __name__ == "__main__":
    main()
