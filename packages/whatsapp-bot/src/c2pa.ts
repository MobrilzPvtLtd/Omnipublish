/**
 * QUITAR-C2PA-1 · quita la firma C2PA («Content Credentials», la marca de «hecho con IA» que
 * ponen ChatGPT, Adobe, etc.) de una imagen al subirla. Solo se tocan los contenedores de esa
 * firma; los píxeles, el perfil de color y el resto de metadatos quedan igual.
 *   · PNG:  bloque «caBX».
 *   · JPEG: segmentos APP11 con una caja JUMBF («jumb»).
 *   · WebP: bloque RIFF «C2PA».
 * Si el archivo no tiene firma o no se entiende su estructura, se devuelve tal cual.
 */

const PNG_FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSinC2pa(b: Buffer): Buffer {
  const partes: Buffer[] = [b.subarray(0, 8)];
  let o = 8, quitado = false;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    const fin = o + 12 + len;
    if (fin > b.length) return b;
    const tipo = b.toString("latin1", o + 4, o + 8);
    if (tipo === "caBX") quitado = true;
    else partes.push(b.subarray(o, fin));
    o = fin;
    if (tipo === "IEND") break;
  }
  return quitado ? Buffer.concat(partes) : b;
}

function jpegSinC2pa(b: Buffer): Buffer {
  const partes: Buffer[] = [b.subarray(0, 2)];
  let o = 2, quitado = false;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return b;
    const marca = b[o + 1];
    // Sin longitud: rellenos y marcadores sueltos.
    if (marca === 0xff) { partes.push(b.subarray(o, o + 1)); o += 1; continue; }
    if (marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) { partes.push(b.subarray(o, o + 2)); o += 2; continue; }
    // Inicio de los datos de imagen: a partir de aquí se copia todo.
    if (marca === 0xda || marca === 0xd9) { partes.push(b.subarray(o)); return quitado ? Buffer.concat(partes) : b; }
    const len = b.readUInt16BE(o + 2);
    const fin = o + 2 + len;
    if (len < 2 || fin > b.length) return b;
    if (marca === 0xeb && b.subarray(o + 4, fin).indexOf("jumb", 0, "latin1") >= 0) quitado = true;
    else partes.push(b.subarray(o, fin));
    o = fin;
  }
  return b;
}

function webpSinC2pa(b: Buffer): Buffer {
  if (b.length < 12) return b;
  const partes: Buffer[] = [];
  let o = 12, quitado = false;
  while (o + 8 <= b.length) {
    const tipo = b.toString("latin1", o, o + 4);
    const len = b.readUInt32LE(o + 4);
    const fin = o + 8 + len + (len & 1);
    if (o + 8 + len > b.length) return b;
    if (tipo === "C2PA") quitado = true;
    else partes.push(b.subarray(o, Math.min(fin, b.length)));
    o = fin;
  }
  if (!quitado) return b;
  const cuerpo = Buffer.concat(partes);
  const cab = Buffer.from(b.subarray(0, 12));
  cab.writeUInt32LE(cuerpo.length + 4, 4);
  return Buffer.concat([cab, cuerpo]);
}

/** Devuelve la imagen sin la firma C2PA (o la misma si no la lleva). */
export function quitarC2pa(data: Buffer, contentType: string): Buffer {
  try {
    const ct = String(contentType || "").toLowerCase();
    if (ct === "image/png" && data.subarray(0, 8).equals(PNG_FIRMA)) return pngSinC2pa(data);
    if (ct === "image/jpeg" && data[0] === 0xff && data[1] === 0xd8) return jpegSinC2pa(data);
    if (ct === "image/webp" && data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return webpSinC2pa(data);
  } catch { /* estructura rara: mejor subirla tal cual que fallar la subida */ }
  return data;
}
