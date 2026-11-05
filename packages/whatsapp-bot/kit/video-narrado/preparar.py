"""Instala el kit «vídeo narrado» en este ordenador (una sola vez; ~6 GB y ~20-30 min).

Uso:  python preparar.py            (Python 3.10-3.12)

Comprueba ffmpeg y Node, crea .venv/, instala PyTorch (con CUDA si hay tarjeta NVIDIA), OmniVoice (voz) y
Whisper (revisión de la voz), y descarga los modelos. Tarda sobre todo por el tamaño de PyTorch y porque
el antivirus revisa cada archivo: es solo la primera vez.

Voz: OmniVoice (k2-fsa). Código Apache-2.0; MODELOS CC-BY-NC (no comercial): díselo a la persona.
Velocidad medida en una GTX 1650 (4 GB): ~4-8 s de cálculo por segundo de voz; con GPU de 8 GB+, mucho menos.
Sin GPU NVIDIA funciona, pero lento.
"""
import os, shutil, subprocess, sys, venv
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
VENV = RAIZ / ".venv"
PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

def paso(t): print(f"\n▶ {t}", flush=True)
def falla(t): print(f"\n✗ {t}"); sys.exit(1)

if not (3, 10) <= sys.version_info[:2] <= (3, 12):
    falla(f"Hace falta Python 3.10, 3.11 o 3.12 (tienes {sys.version.split()[0]}).")
for prog, como in (("ffmpeg", "https://ffmpeg.org/download.html (Windows: winget install Gyan.FFmpeg)"),
                   ("node", "https://nodejs.org (versión 20 o más)")):
    if not shutil.which(prog):
        falla(f"Falta {prog}. Instálalo: {como}")

gpu = bool(shutil.which("nvidia-smi")) and subprocess.run(["nvidia-smi"], capture_output=True).returncode == 0
if not PY.exists():
    paso("Creando .venv")
    venv.create(VENV, with_pip=True)
pip = [str(PY), "-m", "pip", "install", "--disable-pip-version-check", "-q"]
paso("Instalando PyTorch " + ("con CUDA (GPU NVIDIA)" if gpu else "solo CPU") + " — es lo que más tarda")
subprocess.run(pip + ["torch", "torchaudio", "--index-url",
                      "https://download.pytorch.org/whl/" + ("cu124" if gpu else "cpu")], check=True)
paso("Instalando OmniVoice y Whisper")
subprocess.run(pip + ["omnivoice", "faster-whisper", "soundfile", "librosa"], check=True)

paso("Descargando los modelos (voz + Whisper)")
subprocess.run([str(PY), "-c", (
    "import torch; from omnivoice import OmniVoice; OmniVoice.from_pretrained('k2-fsa/OmniVoice');"
    "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8');"
    "print('GPU' if torch.cuda.is_available() else 'CPU')")], check=True)

paso("Comprobando el render de vídeo (HyperFrames)")
subprocess.run("npx --yes hyperframes@0.8.146 --version", shell=True, check=True, cwd=RAIZ)
print("\n✓ Kit listo." + ("" if gpu else " Sin GPU NVIDIA: la voz irá lenta (CPU)."))
print("  Siguiente: .venv/Scripts/python preparar_voz.py \"<audio de la persona>\"")
