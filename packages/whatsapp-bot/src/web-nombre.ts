/**
 * VENTAS-WEB-1 · nombre legible de una web de checkout (cuenta de systeme.io) para el Panel de control.
 *
 * Las cuentas se dan de alta con el email como etiqueta, y un email a la vista del cliente no dice
 * «qué web» es. Regla: la etiqueta si no es un email; si lo es, el dominio del panel propio (cuando
 * no es systeme.io) y, si no, el dominio del email cuando no es un proveedor genérico (gmail…).
 * Sin ninguna pista, el email; sin cuenta, «Otra web».
 */

export interface PistaWeb { id: string; label?: string; panelBaseUrl?: string; accountEmail?: string }

const GENERICOS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es", "live.com",
  "yahoo.com", "yahoo.es", "icloud.com", "me.com", "proton.me", "protonmail.com", "msn.com", "aol.com",
]);

const esEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

const host = (u?: string): string => {
  if (!u) return "";
  try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
};

export function nombreWebCheckout(a: PistaWeb | undefined | null): string {
  if (!a) return "Otra web";
  const label = String(a.label || "").trim();
  if (label && !esEmail(label)) return label;
  const dominioPanel = host(a.panelBaseUrl);
  if (dominioPanel && !/(^|\.)systeme\.io$/.test(dominioPanel)) return dominioPanel;
  const email = (label || String(a.accountEmail || "").trim()).toLowerCase();
  const dominioEmail = email.includes("@") ? email.split("@")[1] : "";
  if (dominioEmail && !GENERICOS.has(dominioEmail)) return dominioEmail;
  return email || dominioPanel || a.id;
}
