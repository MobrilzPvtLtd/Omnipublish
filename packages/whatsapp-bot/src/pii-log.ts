/** PII-LOGS-1 · Los logs de Railway los lee cualquiera con acceso al proyecto (y el 21-oct
 * pudo leerlos un tercero). Un teléfono o un correo completo en una línea de log es un dato
 * personal fuera de la base. Se deja lo justo para correlacionar: 3 primeros + 3 últimos
 * dígitos, y las dos primeras letras del correo con su dominio. */
export function telLog(valor: unknown): string {
  const s = String(valor ?? "");
  const d = s.replace(/\D/g, "");
  if (d.length < 7) return d ? "***" : (s ? "***" : "");
  return d.slice(0, 3) + "…" + d.slice(-3);
}

export function emailLog(valor: unknown): string {
  const s = String(valor ?? "").trim();
  const at = s.lastIndexOf("@");
  if (at < 1) return s ? "***" : "";
  return s.slice(0, Math.min(2, at)) + "***" + s.slice(at);
}
