// PRNG determinista sembrado — para repartir el vector de ataque entre
// participantes de forma reproducible (misma semilla => mismo reparto) y
// balanceada (cada vector se usa ~el mismo número de veces), evitando el
// sesgo de que todos en un mismo dispositivo/turno reciban el mismo estímulo.

// Hash de string -> uint32 (FNV-1a).
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: generador rápido y determinista en [0, 1).
export function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates sembrado: baraja una copia de `arr` de forma determinista.
export function seededShuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Reparte `optionIds` (p.ej. ids de plantilla, una por vector) entre `count`
// participantes de forma balanceada y reproducible a partir de `seed`.
// Devuelve un array de longitud `count` con el id asignado a cada posición.
//
// El orden de los participantes se ordena por su token antes de asignar, así
// el reparto no depende del orden de llegada a la base de datos.
export function assignBalanced(optionIds, count, seed) {
  if (optionIds.length === 0 || count === 0) return [];
  const rand = mulberry32(hash32(String(seed)));

  // Construye un "mazo" con cada opción repetida hasta cubrir count,
  // recortado exactamente a count, y lo baraja.
  const deck = [];
  while (deck.length < count) {
    for (const id of seededShuffle(optionIds, rand)) {
      deck.push(id);
      if (deck.length === count) break;
    }
  }
  return seededShuffle(deck, rand);
}
