import { customAlphabet } from "nanoid";

// Alfabeto sin caracteres ambiguos (0/O, 1/l), 24 caracteres — suficiente
// entropía para tokens de un solo uso en un piloto de laboratorio cerrado.
const nanoid = customAlphabet("23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz", 24);

export function generateAccessToken() {
  return nanoid();
}
