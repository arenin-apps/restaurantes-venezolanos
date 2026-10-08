// geocode-restaurants.js
//
// Recorre restaurants.json y le agrega "latitude"/"longitude" a cada
// restaurante que todavía no las tenga, usando Nominatim (el geocodificador
// gratuito de OpenStreetMap — no requiere API key).
//
// Se puede correr las veces que haga falta: solo geocodifica los que les
// falten coordenadas, así que es seguro correrlo de nuevo después de
// agregar restaurantes nuevos con extract-restaurant-from-url.js.
//
// Uso: node geocode-restaurants.js

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, 'restaurants.json');

// Nominatim pide como máximo 1 solicitud por segundo y un User-Agent
// identificable — si no se respeta, empieza a bloquear pedidos.
const DELAY_MS = 1100;
const USER_AGENT = 'VENenIN-RestaurantesVenezolanosUK/1.0 (venenin.uk)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocodeUna(consulta) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=gb&q=${encodeURIComponent(consulta)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const results = await res.json();
  if (!results.length) return null;
  return {
    latitude: parseFloat(results[0].lat),
    longitude: parseFloat(results[0].lon)
  };
}

// Si la direccion completa no da resultados (ej. lleva el nombre de un
// mercado o centro comercial), reintenta solo con el codigo postal.
async function geocode(direccion) {
  const porDireccion = await geocodeUna(direccion);
  if (porDireccion) return porDireccion;
  const cp = direccion.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i);
  if (!cp) return null;
  await sleep(DELAY_MS);
  return geocodeUna(cp[0] + ', UK');
}

async function main() {
  const restaurants = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

  const pendientes = restaurants.filter(
    (r) => r.direccion && (r.latitude == null || r.longitude == null)
  );
  console.log(`Total restaurantes: ${restaurants.length}`);
  console.log(`Con dirección pero sin coordenadas: ${pendientes.length}`);

  let geocodificados = 0;
  let fallidos = 0;

  for (let i = 0; i < pendientes.length; i++) {
    const r = pendientes[i];
    if (i > 0) await sleep(DELAY_MS);

    try {
      const coords = await geocode(r.direccion);
      if (coords) {
        r.latitude = coords.latitude;
        r.longitude = coords.longitude;
        geocodificados++;
        console.log(`✅ (${i + 1}/${pendientes.length}) ${r.nombre} → ${coords.latitude}, ${coords.longitude}`);
      } else {
        fallidos++;
        console.log(`⚠️ (${i + 1}/${pendientes.length}) ${r.nombre}: sin resultados para "${r.direccion}"`);
      }
    } catch (err) {
      fallidos++;
      console.log(`❌ (${i + 1}/${pendientes.length}) ${r.nombre}: error — ${err.message}`);
    }
  }

  fs.writeFileSync(DATA_PATH, JSON.stringify(restaurants, null, 2) + '\n', 'utf-8');

  console.log(`\nGeocodificados: ${geocodificados}`);
  console.log(`Fallidos (revisar dirección a mano): ${fallidos}`);
}

main();
