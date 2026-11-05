/**
 * Motor de contenido (port de generate_idea.py). Carga content_bank.json,
 * empareja el nicho del brief con un banco por keywords, elige un ángulo fresco
 * (history-aware) y una fórmula de hook. Si no hay match → modo abierto (la IA
 * elige el tema). Si el JSON no se puede leer → modo abierto también.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BankTopic {
  angle: string;
  pillar: string;
}
export interface BankFormula {
  name: string;
  description: string;
  template: string;
}
interface NicheObj {
  label: string;
  keywords: string[];
  pillars: string[];
  topics: BankTopic[];
}
interface Bank {
  niches?: Record<string, NicheObj>;
  hook_formulas?: BankFormula[];
}

let BANK: Bank = {};
try {
  BANK = JSON.parse(readFileSync(path.join(__dirname, "content_bank.json"), "utf8"));
} catch {
  BANK = {};
}

function normalize(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function matchNiche(brandNiche: string): { key: string; obj: NicheObj } | null {
  const niches = BANK.niches;
  if (!niches) return null;
  const target = normalize(brandNiche);
  if (!target) return null;
  for (const [key, obj] of Object.entries(niches)) {
    for (const kw of obj.keywords || []) {
      if (target.includes(normalize(kw))) return { key, obj };
    }
  }
  return null;
}

export function pickFreshTopic(obj: NicheObj, recentIdeas: string[]): BankTopic | null {
  const topics = obj.topics || [];
  if (!topics.length) return null;
  const recent = recentIdeas.map(normalize);

  const isUsed = (angleNorm: string): boolean => {
    if (!angleNorm) return false;
    for (const ri of recent) {
      if (!ri) continue;
      if (ri.includes(angleNorm) || angleNorm.includes(ri)) return true;
      const aw = angleNorm.split(" ");
      for (let n = 0; n <= aw.length - 5; n++) {
        if (ri.includes(aw.slice(n, n + 5).join(" "))) return true;
      }
    }
    return false;
  };

  const fresh = topics.filter((t) => !isUsed(normalize(t.angle)));
  const pool = fresh.length ? fresh : topics;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function pickFormula(): BankFormula | null {
  const formulas = BANK.hook_formulas || [];
  if (!formulas.length) return null;
  return formulas[Math.floor(Math.random() * formulas.length)];
}

// Para el selector del panel: nichos disponibles con su etiqueta.
export function bankNiches(): { key: string; label: string }[] {
  return Object.entries(BANK.niches || {}).map(([key, o]) => ({ key, label: o.label }));
}
