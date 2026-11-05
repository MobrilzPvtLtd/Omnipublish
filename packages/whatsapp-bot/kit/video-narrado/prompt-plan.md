# Cómo escribir `plan.json` (lo hace la IA)

Lees el texto del carrusel diapositiva a diapositiva y escribes `plan.json`: el guion del vídeo, escena
por escena. **No escribes HTML ni animaciones**: cada escena usa una plantilla del catálogo y tú solo das
sus textos. Mira `plan.ejemplo.json` (un vídeo real de 11 escenas) antes de empezar.

## Reglas del guion

1. Español de España (salvo que `marca.json` diga otro `idioma`), segunda persona, cercano y directo,
   como lo diría el dueño de la marca en voz alta.
2. **No leas las diapositivas**: explica cada idea con tus palabras en 1-3 frases cortas (6-20 palabras).
   Cada frase es una pista para la animación: la 1.ª plantea, la última remata.
3. Escena 1 = gancho (pregunta o situación que el público reconoce) con `gancho_foto_sello`.
   Última escena = `cierre_marca`: pide que lo compartan + la llamada de `marca.cta`.
   No hables de nada de `marca.evitar`.
4. Lista numerada → cada punto empieza por su número en palabra («Uno.», «Dos.»…) y lleva
   `campos.numero` (la barra de progreso de arriba se rellena con él).
5. Duración objetivo 60-90 s (≈ 2,3 palabras por segundo de narración). Con más de 10 ideas, junta o
   resume; no superes 100 s.
6. Para cada idea elige la plantilla que mejor la DEMUESTRE (no la que más se parezca al texto):

| plantilla | úsala cuando la idea es… | campos |
|---|---|---|
| gancho_foto_sello | (solo escena 1) el gancho | titular, sello_repetido |
| comparacion | dos cosas que se confunden o se contraponen | a{etiqueta,visual,velocidad?}, b{…}, desenlace |
| contador | un número que cambia el sentido | desde, hasta, etiqueta, destacado?, remate |
| carrera | lo que parece ganar frente a lo que gana | lento{etiqueta}, rapido{etiqueta}, remate |
| repeticion_excepcion | algo repetido mil veces frente a la excepción | frase_repetida, frase_destacada |
| frase_corregida | una creencia que se corrige tachando una palabra | frase, palabra_tachada (literal de frase), correccion |
| destacado_en_grupo | salirse de lo normal pese a las críticas | etiqueta_grupo, objeciones[1-3], remate |
| acumulacion_ruptura | excusas u obstáculos que se apilan y se rompen | pieza_repetida, ruptura |
| idea_simple | (comodín) nada de lo anterior encaja | titular, apoyo |
| cierre_marca | (solo la última) despedida | sello_repetido, sello_final, pedir_compartir, firma, usuario |

   Los nombres exactos de cada campo y sus valores por defecto están arriba de cada
   `plantillas/<plantilla>.html` (bloque de variables): úsalos tal cual.
   Visuales de `comparacion`: cronometro, barra, pedestal, lupa, silueta, reloj_arena, rayo, semilla.
   Etiquetas en MAYÚSCULAS y de 1-2 palabras. Textos en pantalla ≤ 45 caracteres.
7. **Lo que se ve tiene que ser lo que se está oyendo** (si la voz dice «cientos» y en pantalla pone «1»,
   está mal). En `contador` y `comparacion` pon SIEMPRE `anclas`, con palabras literales de la `narracion`:
   - `contador`: `{ "t1": <palabra donde se dice la cantidad>, "t2": <1.ª palabra del remate> }`
     (p. ej. «…no los cientos de intentos… Date más intentos» → `{ "t1": "cientos", "t2": "Date" }`).
   - `comparacion`: `{ "t1": <palabra que nombra el lado B>, "t2": <1.ª palabra del desenlace> }`.
   En el resto de plantillas no hacen falta: se sincronizan con las frases (1.ª plantea, última remata).
8. **Entonación**: la voz SUBE el tono en las frases escritas con «¡…!» y en las escenas `impulso`/`climax`.
   Úsalo donde un locutor subiría: el remate de una idea fuerte, el clímax, la llamada final. Como mucho una
   exclamación por escena y no en frases de reflexión (`calma`); si todo sube, nada destaca.
9. `energia` de cada escena (mueve la música y la expresividad de la voz): `tension` (problema, duda), `calma` (reflexión),
   `impulso` (acción, avance), `climax` (como mucho UNA: la más emotiva, casi al final).
   Evita más de dos escenas seguidas con la misma energía.

## Forma

```json
{
  "marca": "← copia aquí el contenido de marca.json",
  "musica": { "calma": "Título Incompetech", "impulso": "Título Incompetech" },
  "escenas": [
    { "plantilla": "gancho_foto_sello", "campos": { "...": "según la tabla" },
      "narracion": "1-3 frases", "anclas": { "t1": "palabra", "t2": "palabra" } (contador y comparacion),
      "energia": "tension|calma|impulso|climax" }
  ]
}
```
