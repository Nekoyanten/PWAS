import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAccessToken } from "../../src/lib/tokens.js";

test("generateAccessToken produce tokens de 24 caracteres", () => {
  const t = generateAccessToken();
  assert.equal(t.length, 24);
});

test("generateAccessToken no repite en 1000 llamadas consecutivas", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const t = generateAccessToken();
    assert.ok(!seen.has(t), `token duplicado: ${t}`);
    seen.add(t);
  }
});

test("generateAccessToken no usa caracteres ambiguos (0,O,1,l,I)", () => {
  for (let i = 0; i < 200; i++) {
    const t = generateAccessToken();
    assert.doesNotMatch(t, /[0O1lI]/);
  }
});
