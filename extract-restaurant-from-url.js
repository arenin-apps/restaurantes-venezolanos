// extract-restaurant-from-url.js
//
// Recibe una URL (pasada por variable de entorno RESTAURANT_URL o como
// primer argumento de línea de comandos), extrae el texto de la página,
// le pide a Gemini que identifique los datos del restaurante, y agrega
// el resultado a restaurants.json evitando duplicados.
//
// Uso local:   RESTAURANT_URL="https://..." GEMINI_API_KEY="..." node extract-restaurant-from-url.js
// Uso en CI:    disparado por .github/workflows/extract-restaurant-from-url.yml

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'restaurants.json');
const MODEL = 'gemini-3.5-flash-lite'; // gemini-1.5-flash está muerto (404); gemini-3.5-flash a secas tiene cuota muy chica

const PAISES_VALIDOS = ['Inglaterra', 'Escocia', 'Gales', 'Irlanda del Norte'];

function getUrl() {
  const url = process.env.RESTAURANT_URL || process.argv[2];
  if (!url) {
    console.error('Falta la URL. Pasala como RESTAURANT_URL o como primer argumento.');
    process.exit(1);
  }
  return url.trim();
}

function normalize(str) {
  return (str || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(name) {
  return normalize(name).replace(/\s+/g, '-');
}

// Extrae texto legible de un HTML crudo, sin dependencias externas.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function fetchPageText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9,es;q=0.8'
      }
    });
    if (!res.ok) {
      throw new Error(`No se pudo acceder a ${url} (status ${res.status})`);
    }
    const html = await res.text();
    return htmlToText(html).slice(0, 12000);
  } catch (err) {
    // FIX: algunos sitios (sobre todo con Cloudflare u otro firewall)
    // bloquean el fetch directo por completo — a veces por el
    // User-Agent, a veces por bloquear tráfico de IPs de datacenter
    // como las de GitHub Actions. En ese caso el error ni siquiera es
    // un status HTTP, es un fallo de conexión ("fetch failed"). Antes
    // de rendirse, reintentamos a través del mismo proxy de
    // renderizado que ya usa la agenda para sitios difíciles.
    console.log(`⚠️ Fetch directo falló (${err.message}). Reintentando vía proxy de renderizado...`);
    const proxyRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VENenINBot/1.0)' }
    });
    if (!proxyRes.ok) {
      throw new Error(`El proxy de renderizado tampoco pudo acceder a ${url} (status ${proxyRes.status})`);
    }
    const html = await proxyRes.text();
    return htmlToText(html).slice(0, 12000);
  }
}

function buildPrompt(url, pageText) {
  return `Sos un asistente que extrae datos de restaurantes venezolanos en el Reino Unido a partir del texto de su sitio web.

URL de origen: ${url}

Texto de la página (puede incluir menú, contacto, footer, etc.):
"""
${pageText}
"""

IMPORTANTE: esta página puede mencionar UN SOLO local, o VARIOS locales de la misma cadena/marca (por ejemplo una página "Locations" o "Our Locations" con varias sucursales, cada una con su propia dirección). Identificá TODOS los locales físicos distintos que aparezcan, cada uno como una entrada separada.

Devolvé EXCLUSIVAMENTE un arreglo JSON (sin markdown, sin texto adicional), con un objeto por cada local físico encontrado, con esta forma exacta:
[
  {
    "nombre": "Nombre del restaurante — si hay más de un local, agregá el barrio/zona para diferenciarlos, ej: 'Arepera Ejemplo – Notting Hill'",
    "direccion": "Dirección completa de ESE local incluyendo código postal, o null si no se encuentra",
    "pais": "uno de: Inglaterra, Escocia, Gales, Irlanda del Norte, o null si no se puede determinar",
    "county": "condado/county del Reino Unido correspondiente a la dirección de ESE local, o null si no se puede determinar",
    "telefono": "número de teléfono de ESE local si se especifica uno distinto, o el general si es el único que hay, o null",
    "sitioWeb": "${url}",
    "redes": [{"plataforma": "Instagram", "handle": "@usuario"}],
    "categoria": "tipo de cocina/oferta si es identificable, ej: Arepas, Cachapas, Parrilla, Café/Pastelería, Panadería, Delivery, Restaurante, o null"
  }
]

Reglas:
- Si hay un solo local, el arreglo tiene un solo elemento igual.
- Si el sitio menciona explícitamente el county/condado, usalo. Si no, inferilo de la ciudad/código postal si es posible con certeza razonable; si no estás seguro, dejalo en null.
- "redes" es un array vacío si no se encuentra ninguna red social (mismas redes para todos los locales si son las de la marca en general).
- No inventes datos que no aparezcan en el texto.
- No incluyas locales marcados como "próximamente"/"coming soon" que todavía no tengan dirección física.`;
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Falta la variable de entorno GEMINI_API_KEY.');
  }
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Error de Gemini (${res.status}): ${body}`);
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    throw new Error('Gemini no devolvió contenido utilizable.');
  }
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  // FIX: a veces el modelo envuelve el arreglo en un objeto (ej.
  // {"locales": [...]}) aunque el prompt pida el arreglo directo. Si
  // pasa eso, buscamos la primera propiedad que sea un arreglo y la
  // usamos. Si en cambio devolvió un solo objeto (formato viejo, un
  // restaurante sin arreglo), lo envolvemos en un arreglo de uno.
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const arrayProp = Object.values(parsed).find((v) => Array.isArray(v));
    if (arrayProp) return arrayProp;
    if (parsed.nombre) return [parsed];
  }
  return parsed;
}

function buildMapsUrl(direccion) {
  if (!direccion) return null;
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(direccion);
}

function loadExisting() {
  if (!fs.existsSync(DATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}

function findDuplicate(list, candidate) {
  const nameKey = normalize(candidate.nombre);
  const addrKey = normalize(candidate.direccion);
  return list.find(r => {
    const rName = normalize(r.nombre);
    const rAddr = normalize(r.direccion);
    if (addrKey && rAddr && rName === nameKey && rAddr === addrKey) return true;
    // mismo nombre normalizado + mismo county alcanza también como señal fuerte
    if (rName === nameKey && r.county && candidate.county && normalize(r.county) === normalize(candidate.county)) return true;
    return false;
  });
}

async function main() {
  const url = getUrl();
  console.log(`Extrayendo datos de: ${url}`);

  const pageText = await fetchPageText(url);
  const prompt = buildPrompt(url, pageText);
  const extractedList = await callGemini(prompt);

  if (!Array.isArray(extractedList) || extractedList.length === 0) {
    throw new Error('Gemini no devolvió ningún local válido para esta página.');
  }
  console.log(`Locales encontrados en la página: ${extractedList.length}`);

  const existing = loadExisting();
  const slugsExistentes = new Set(existing.map(r => r.id));

  let agregados = 0;
  let duplicados = 0;
  let invalidos = 0;

  for (const extracted of extractedList) {
    if (!extracted.nombre) {
      console.warn('⚠️ Local sin nombre, se descarta.');
      invalidos++;
      continue;
    }
    if (extracted.pais && !PAISES_VALIDOS.includes(extracted.pais)) {
      console.warn(`País "${extracted.pais}" no reconocido para "${extracted.nombre}", se guarda igual como texto libre.`);
    }

    const dup = findDuplicate(existing, extracted);
    if (dup) {
      console.log(`⏭️ Ya existe un local similar a "${extracted.nombre}" (id: ${dup.id}). No se agrega duplicado.`);
      duplicados++;
      continue;
    }

    let slug = slugify(extracted.nombre);
    let finalSlug = slug;
    let n = 2;
    while (slugsExistentes.has(finalSlug)) {
      finalSlug = `${slug}-${n}`;
      n++;
    }
    slugsExistentes.add(finalSlug);

    const nuevo = {
      id: finalSlug,
      nombre: extracted.nombre,
      pais: extracted.pais || null,
      county: extracted.county || null,
      direccion: extracted.direccion || null,
      mapsUrl: buildMapsUrl(extracted.direccion),
      telefono: extracted.telefono || null,
      sitioWeb: extracted.sitioWeb || url,
      redes: Array.isArray(extracted.redes) ? extracted.redes : [],
      categoria: extracted.categoria || null,
      fechaAgregado: new Date().toISOString().slice(0, 10)
    };

    existing.push(nuevo);
    agregados++;
    console.log(`✅ Agregado: ${nuevo.nombre} (${nuevo.direccion || 'sin dirección'})`);
  }

  existing.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  fs.writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf-8');

  console.log(`\nResumen: ${agregados} agregados, ${duplicados} ya existentes, ${invalidos} inválidos.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
