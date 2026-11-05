# Kit «vídeo narrado» de Business Stack

Convierte un carrusel en un Reel / YouTube Short **narrado con la voz clonada de la persona**, con la
explicación **animada** escena a escena (no son las diapositivas pasando) y **música que cambia** según
el momento del vídeo. Todo gratis y en este ordenador: Business Stack (su MCP) solo da este kit, recibe
el vídeo terminado y lo publica.

Quien ejecuta los pasos es la IA de la persona (Claude Code, Cowork…) con acceso a la terminal.
Rutas relativas a esta carpeta. En Mac/Linux cambia `.venv/Scripts/python` por `.venv/bin/python`.

## Una sola vez por ordenador

1. `python preparar.py` — instala todo (~6 GB, 20-30 min la primera vez: PyTorch es enorme y el antivirus
   revisa cada archivo). Requisitos: Python 3.10-3.12, ffmpeg, Node 20+. Avisa a la persona de que tarda.
2. **Voz** (OmniVoice): pide a la persona un audio suyo de 1-3 min hablando con naturalidad (habitación
   callada, sin música; una nota de voz vale). `.venv/Scripts/python preparar_voz.py "<audio>"` →
   `voz/referencia.wav` (6-10 s cortados SOLO en pausas) + `voz/referencia.txt` (su texto exacto).
   OmniVoice copia la voz Y la forma de hablar (acento, «z»). Si el texto de la muestra no coincide con
   el audio, se cuelan sílabas sueltas («al») en todo lo generado: no edites esos dos archivos a mano.
   Haz una prueba (`voz.py --prueba "Las decisiones piden rapidez. ¿Cuántas veces has dicho mañana empiezo?"`)
   y que la persona la escuche antes del primer vídeo.
   **Licencia**: los modelos de OmniVoice son CC-BY-NC (no comercial). Díselo a la persona la primera vez;
   usarlo para su negocio es decisión suya.
3. **Marca**: crea `marca.json` preguntando lo que no sepas (el MCP: `resumen_negocio`):
   ```json
   { "nombre": "mi marca", "usuario": "@mimarca",
     "colores": { "fondo": "#111312", "texto": "#FFFFFF", "acento": "#D4E6A5", "secundario": "#9A9E9A" },
     "cta": "Si quieres saber más sobre …, síguenos", "evitar": ["temas que no quiere"], "idioma": "es-ES" }
   ```
   Foto de la persona (cara, vertical) → `public/autor.png`. Logo o mascota (PNG transparente,
   opcional) → `public/mascota.png`.

## Cada vídeo (~10-15 min con una GPU NVIDIA de 4 GB)

1. **Texto del carrusel**: lee cada diapositiva (si son imágenes, míralas tú).
2. **Guion** → `plan.json` siguiendo `prompt-plan.md` (ejemplo real: `plan.ejemplo.json`). Copia
   `marca.json` en `plan.marca`. Elige música: `node musica.mjs --buscar "calm ambient"` y
   `--buscar "upbeat motivational"`; pon los títulos en `plan.musica.calma` / `.impulso`.
   **Enseña el guion a la persona** y ajústalo antes de generar la voz.
3. `node musica.mjs` — descarga la música e imprime el **crédito** (obligatorio en el texto).
4. `.venv/Scripts/python voz.py --verificar` → `public/voz.wav` + `tiempos.json`. Whisper comprueba
   cada frase y la repite si sale mal; las que sigan mal salen marcadas con ↻: escúchalas (Whisper a veces
   se equivoca él) o reescríbelas y vuelve a generar. `--pasos 8` va el doble de rápido (algo menos fino),
   `--pasos 32` es la máxima calidad; por defecto 16.
5. `node generar.mjs` → `index.html` (escenas con los colores de la marca, subtítulos, música).
6. `npm run render` → `renders/video.mp4` (1080×1920, ~4 min). Ábreselo a la persona.
7. **Publicar** (con el MCP de Business Stack, cuando la persona lo apruebe):
   `subir_archivo` → sube el MP4 con el comando que te da → `programar_publicacion` con
   `tipo: reel`, el enlace devuelto, `redes: ["instagram","youtube"]`, `reel_prueba: "manual"` y el
   texto de cada red con el crédito de la música. Por defecto como **borrador** (`borrador: true`).

## Por qué así (no lo cambies sin motivo)

- **Voz frase a frase** con pausas fijas (0,28 s entre frases, 0,35 s entre escenas): cada animación
  y cada subtítulo sabe al milisegundo cuándo empieza su frase.
- **OmniVoice y no Chatterbox**: Chatterbox (MIT) copiaba el timbre pero NO el acento de la muestra
  (una voz castellana salía con seseo, «desisiones»); OmniVoice continúa la muestra y respeta cómo habla
  la persona. Limpieza final medida: sin compresor rápido, de-esser ni cambios de tono (suenan «doble»).
- **Plantillas cerradas** (`plantillas/`): la IA solo elige plantilla y textos; así el resultado es
  siempre correcto y con la marca. Una idea que no encaja → `idea_simple`.
- **Voz con vida**: el ritmo sigue la `energia` de cada escena (tabla `VELOCIDAD` en `voz.py`) y la
  entonación la marca el texto: el modelo sube el tono en «¡…!» y entona «¿…?», como la persona.
- **Música adaptativa**: `tension` = pista calma apagada (filtro), `impulso`/`climax` = pista impulso,
  la música sube en los respiros entre escenas y +3 dB en el clímax.
