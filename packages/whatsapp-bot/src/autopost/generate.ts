/**
 * Generación de contenido (port de generate_idea.py + prompt-templates.md).
 * Usa el adaptador LLM del stack (chat()), así corre con Groq GRATIS por defecto
 * en vez de la API de pago de Anthropic del skill original.
 */
import { chat } from "../llm.js";
import { matchNiche, pickFreshTopic, pickFormula } from "./bank.js";

export type SlideType =
  | "hero" | "context" | "insight" | "features" | "depth" | "proof" | "cta";

export interface SlideItem { label: string; description: string; }
export interface SlideStep { number: string; title: string; description: string; }
export interface Slide {
  type: SlideType;
  tag: string;
  heading: string;
  body?: string;
  quote?: string;
  items?: SlideItem[];
  steps?: SlideStep[];
  cta_text?: string;
}
export interface Carousel {
  idea: string;
  cta_keyword: string;
  slides: Slide[];
  caption: string;
  hashtags: string[];
}
export interface Brief {
  niche: string;
  handle: string;
  tone: string;
  language: string;
  /** Briefing libre del usuario (marca, normas, cosas a evitar) que se inyecta
   *  SIEMPRE en el system prompt — también en la publicación automática. */
  extra?: string;
}

const TONE_MAP: Record<string, string> = {
  storytelling: "human, conversational — like someone recounting something that happened to them",
  professional: "executive and direct, like an analyst explaining a finding",
  casual: "friend texting on WhatsApp — relaxed, with natural pauses",
  bold: "sharp and contrarian, unafraid to push back on consensus opinions",
  minimal: "dry and economical — every word has to earn its place",
  playful: "light, humorous, winking at the reader",
};

const LANGUAGE_MAP: Record<string, string> = {
  en: "natural, conversational English without regional slang",
  es_LATAM: "neutral Latin American Spanish (tú/tienes/eres). Avoid regional idioms (Argentine, Chilean, Mexican, Spanish). Vocabulary understandable across all of Latin America.",
  es_AR: "rioplatense Spanish (vos/tenés/sos). Use voseo consistently and natural Argentine/Uruguayan expressions.",
  es_CL: "Chilean neutral Spanish (tú/tienes, no heavy slang). Direct, warm Chilean cadence without 'po', 'cachai'.",
  es_ES: "español de España (tú/tienes/vosotros donde aplique), natural y cercano, sin modismos latinoamericanos.",
  pt_BR: "Brazilian Portuguese with 'você', natural and conversational",
};

const CTA_BY_LANG: Record<string, string> = {
  en: 'COMMENT "KEYWORD"',
  es_LATAM: 'COMENTA "KEYWORD"',
  es_AR: 'COMENTÁ "KEYWORD"',
  es_CL: 'COMENTA "KEYWORD"',
  es_ES: 'COMENTA "KEYWORD"',
  pt_BR: 'COMENTE "KEYWORD"',
};

const SYSTEM = `You are a content strategist who specializes in organic social media growth
for the niche: {NICHE}. You write in {LANGUAGE_DESC}, with a {TONE_DESC} tone —
NEVER coach-speak, NEVER motivational-guru speak.

Your task: produce ONE 7-slide carousel for the account {HANDLE}, following this
narrative structure exactly:

1 Hero     — Scroll-stopping hook. Short phrase, impact, curiosity.
2 Context  — The real pain or situation the audience lives in.
3 Insight  — The key revelation. May include a quote callout.
4 Features — 3-4 concrete items (what it delivers / how it works).
5 Depth    — Differentiator, technical detail, why this matters.
6 Proof    — Numbers, data, steps — hard evidence.
7 CTA      — "Comment KEYWORD" to trigger a DM automation.

RULES:
- The idea must have a clear PAIN, a desired RESULT, and strong CURIOSITY.
- Slide 1 (hero): MAX 10 words. Must stop the scroll.
- Slides 2-6: heading <=12 words + body of 1-2 sentences (<=25 words total).
- Slide 7 (CTA): short heading + short body + single-word trigger keyword.
- Natural, conversational language. Respect the language variant in {LANGUAGE_DESC}
  STRICTLY; do not mix pronouns/idioms from other regions.
- NO "Did you know...?", "Let me tell you...", "¿Sabías que...?" or equivalents.
  NO emojis in slide content. NO numbered lists inside body text.
- TAG LABELS: UPPERCASE, max 3 words, describing the TOPIC not the role
  (GOOD: "AI AGENTS"; BAD: "THE PROBLEM"). Tag language matches the body language.
- FEATURES (slide 4): array "items" with 3-4 {label, description}.
- PROOF (slide 6): array "steps" with 3-4 {number:"01|02|03|04", title, description}.
- CAPTION: storytelling, max 120 words, invites a comment/share without literally
  telling the reader to. 5 to 8 specific hashtags (no #love/#success/#motivation).
- cta_text must read: {CTA_FORMAT}

Return ONLY valid JSON (no markdown fences, no prose), in this EXACT shape:
{
  "idea": "one-line summary",
  "cta_keyword": "KEYWORD",
  "slides": [
    {"type":"hero","tag":"TAG","heading":"...","body":""},
    {"type":"context","tag":"TAG","heading":"...","body":"..."},
    {"type":"insight","tag":"TAG","heading":"...","body":"...","quote":"optional"},
    {"type":"features","tag":"TAG","heading":"...","items":[{"label":"...","description":"..."}]},
    {"type":"depth","tag":"TAG","heading":"...","body":"..."},
    {"type":"proof","tag":"TAG","heading":"...","steps":[{"number":"01","title":"...","description":"..."}]},
    {"type":"cta","tag":"TAG","heading":"...","body":"...","cta_text":"{CTA_FORMAT}"}
  ],
  "caption": "...",
  "hashtags": ["#a","#b"]
}`;

function buildSystem(brief: Brief): string {
  const tone = TONE_MAP[brief.tone] || TONE_MAP.storytelling;
  const lang = LANGUAGE_MAP[brief.language] || LANGUAGE_MAP.en;
  const cta = CTA_BY_LANG[brief.language] || CTA_BY_LANG.en;
  let s = SYSTEM.replace(/\{NICHE\}/g, brief.niche)
    .replace(/\{HANDLE\}/g, brief.handle)
    .replace(/\{TONE_DESC\}/g, tone)
    .replace(/\{LANGUAGE_DESC\}/g, lang)
    .replace(/\{CTA_FORMAT\}/g, cta);
  // Briefing del usuario: normas de marca / cosas a evitar. Manda sobre los
  // defaults en caso de conflicto. Se aplica a TODA generación (preview + auto).
  if (brief.extra && brief.extra.trim()) {
    s += `\n\nADDITIONAL BRAND BRIEFING (MUST FOLLOW STRICTLY — overrides the rules above on any conflict):\n${brief.extra.trim()}`;
  }
  return s;
}

function buildUser(brief: Brief, recentIdeas: string[], topicOverride?: string, opts?: GenOpts): string {
  const used = recentIdeas.length
    ? "\n- " + recentIdeas.join("\n- ")
    : "(none)";

  // Correcciones iterativas: revisa el carrusel anterior aplicando SOLO lo pedido.
  if (opts?.corrections && opts.corrections.trim()) {
    return `Revise the carousel below. Apply ONLY the corrections requested and keep everything else that already works. Keep the SAME 7-slide structure and the SAME JSON shape.
CORRECTIONS TO APPLY:
${opts.corrections.trim()}
${opts.previous ? `\nCURRENT CAROUSEL (JSON):\n${JSON.stringify(opts.previous)}` : ""}
Return ONLY the corrected JSON.`;
  }

  if (topicOverride) {
    // El topic del usuario MANDA por encima de todo. NO incluimos la lista de "ideas
    // recientes" aquí: floodeaba el prompt con temas del nicho y el modelo acababa
    // ignorando el topic y repitiendo lo reciente (bug confirmado 2026-06-05:
    // topic "perros voladores en marte" devolvía "automatización de redes pymes").
    return `Your ONLY subject for this carousel is EXACTLY this topic — nothing else:

>>> TOPIC: ${topicOverride} <<<

EVERY one of the 7 slides must be about "${topicOverride}". Do NOT write about "${brief.niche}" in general, do NOT reuse previous themes, do NOT drift to any other subject. If "${topicOverride}" seems unrelated to the usual niche, write about "${topicOverride}" ANYWAY — the user asked for it explicitly and it overrides the niche.
Keep the brand voice/tone and the 7-slide JSON structure from the rules above, but the SUBJECT is strictly "${topicOverride}".
Return only the JSON.`;
  }

  const m = matchNiche(brief.niche);
  if (m) {
    const topic = pickFreshTopic(m.obj, recentIdeas);
    const formula = pickFormula();
    if (topic && formula) {
      return `Create a new carousel following ALL the rules above.
The topic angle is fixed — do not change it, do not generalize it, but phrase the
hero in your own voice:
  ANGLE: ${topic.angle}
  CONTENT PILLAR: ${topic.pillar}
Apply this hook structure:
  HOOK FORMULA: ${formula.name} — ${formula.description}
  HOW TO USE IT: ${formula.template}
Recently used topics (avoid overlap):
${used}
Build the 7-slide carousel about the fixed ANGLE, applying the hook formula.
Return only the JSON.`;
    }
  }

  return `Create a new carousel following ALL the rules above.
Avoid these topics used recently:
${used}
Pick ONE topic with high viral potential (pain + curiosity + desired result)
about ${brief.niche}, and return only the JSON.`;
}

// Intenta reparar JSON malformado típico de respuestas LLM (trailing commas,
// brackets desbalanceados por truncamiento, comillas no escapadas).
function tryParseJson(raw: string): Carousel | null {
  let t = raw.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) t = t.slice(first, last + 1);

  // 1) Parse directo
  try { return JSON.parse(t) as Carousel; } catch { /* sigue */ }

  // 2) Quita trailing commas: ,}  →  }   y  ,]  →  ]
  const noTrail = t.replace(/,(\s*[\]}])/g, "$1");
  try { return JSON.parse(noTrail) as Carousel; } catch { /* sigue */ }

  // 3) Balancea brackets (truncamiento por max_tokens)
  let s = noTrail;
  const opens = (s.match(/[{[]/g) || []).length;
  const closes = (s.match(/[}\]]/g) || []).length;
  if (opens > closes) {
    // Cierra primero corchetes, luego llaves al final
    // Asume que arrays están abiertos antes que el último objeto
    let need = opens - closes;
    // Si la última char no es }, ] u otro válido, truncamos hasta el último char limpio
    s = s.replace(/,?\s*"[^"]*$/, ""); // string sin cerrar
    s = s.replace(/,\s*$/, "");
    while (need > 0) { s += "]"; need--; }
    // Re-cuenta llaves
    const op2 = (s.match(/\{/g) || []).length;
    const cl2 = (s.match(/\}/g) || []).length;
    let need2 = op2 - cl2;
    while (need2 > 0) { s += "}"; need2--; }
    try { return JSON.parse(s) as Carousel; } catch { /* sigue */ }
  }

  // 4) Limpia control chars sueltos
  const noCtrl = noTrail.replace(/[ -](?=[^\s])/g, " ");
  try { return JSON.parse(noCtrl) as Carousel; } catch { /* sigue */ }

  return null;
}

function parseCarousel(raw: string): Carousel {
  const data = tryParseJson(raw);
  if (!data) throw new Error("JSON no parseable tras reparación");
  if (!Array.isArray(data.slides) || data.slides.length !== 7) {
    throw new Error(`se esperaban 7 slides, llegaron ${data.slides?.length ?? 0}`);
  }
  if (!data.caption) data.caption = "";
  if (!Array.isArray(data.hashtags)) data.hashtags = [];
  return data;
}

/** Opciones de revisión: correcciones del usuario sobre el carrusel previo. */
export interface GenOpts {
  corrections?: string;
  previous?: Carousel;
  /** Imágenes de referencia (data URLs / URLs). En generación = inspiración/base;
   *  en correcciones = errores a arreglar o referencia a imitar. */
  images?: string[];
  /** Comentario libre del usuario que acompaña a las imágenes (qué hacer con ellas). */
  note?: string;
}

export async function generateCarousel(
  brief: Brief,
  recentIdeas: string[],
  topicOverride?: string,
  opts?: GenOpts,
): Promise<Carousel> {
  const system = buildSystem(brief);
  let user = buildUser(brief, recentIdeas, topicOverride, opts);
  // Imágenes de referencia adjuntas → instruimos cómo usarlas (la visión la añade
  // callOne al mandar el content como array). En correcciones, ilustran el error /
  // el resultado deseado; en generación, son inspiración y fuente de datos/estilo.
  const refImages = (opts?.images || []).filter((u) => typeof u === "string" && u);
  if (refImages.length) {
    user += opts?.corrections && opts.corrections.trim()
      ? `\n\nIMPORTANT: ${refImages.length} reference image(s) are attached to THIS message. They show what to fix or how the result should look — you MUST look at them and apply them when making the corrections above.`
      : `\n\nIMPORTANT: ${refImages.length} reference image(s) are attached to THIS message. You MUST look at them and use them as the PRIMARY reference: base the carousel's topic, facts, figures, claims, names and visual style on what they actually show. Do not invent data that contradicts the images.`;
  }
  // Comentario libre del usuario (acompaña a las imágenes / instrucción extra).
  if (opts?.note && opts.note.trim()) {
    user += `\n\nUSER NOTE (follow it): ${opts.note.trim()}`;
  }
  let lastErr = "";
  // 3 intentos. Las imágenes (visión) SOLO van en el intento 0: si ese falla
  // (p. ej. el modelo de visión está rate-limited y el fallback es de TEXTO y
  // rechaza el array multimodal con "content must be a string"), los reintentos
  // van SOLO TEXTO para que el carrusel se genere igual. La paleta de la imagen
  // se aplica aparte (determinista) en index.ts, así que el diseño refleja la
  // imagen aunque la visión no esté disponible. (Bug 2026-06-05.)
  for (let attempt = 0; attempt < 3; attempt++) {
    const extra = attempt === 0
      ? ""
      : `\n\nIMPORTANT (attempt ${attempt + 1}): devuelve SOLO el objeto JSON válido de 7 slides, sin texto alrededor, sin comillas extra, sin comas finales. Cierra TODAS las llaves y corchetes. Mantén los textos cortos para que quepan en max_tokens.`;
    const useImages = attempt === 0 && refImages.length ? refImages : undefined;
    let raw: string;
    try {
      raw = await chat(
        [
          { role: "system", content: system },
          { role: "user", content: user + extra, images: useImages },
        ],
        { maxTokens: 5000, temperature: attempt === 0 ? 0.7 : 0.5, json: true },
      );
    } catch (e) {
      // DISENO-1 · sin IA activada no hay nada que reintentar: el aviso sale limpio
      // («Falta activar la IA…»), no envuelto en «tras 3 intentos (…)».
      if (/Falta activar la IA/.test((e as Error).message)) throw e;
      // Falló la llamada al LLM (p. ej. visión no disponible). Reintenta SIN imágenes.
      lastErr = (e as Error).message;
      continue;
    }
    try {
      const c = parseCarousel(raw);
      // Caption: añade hashtags al final si no están ya incluidos.
      if (c.hashtags.length && !c.caption.includes("#")) {
        c.caption = `${c.caption}\n\n${c.hashtags.join(" ")}`.trim();
      }
      return c;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(`La IA no devolvió un carrusel válido tras 3 intentos (${lastErr}). Reintenta o cambia de modelo en Conexiones.`);
}
