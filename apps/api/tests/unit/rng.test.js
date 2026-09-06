// Pruebas unitarias de assignBalanced (lib/rng.js) — el mecanismo que ya
// repartía el vector de ataque por equipo (ver campaigns.js GET /:id/plan) y
// que POST /api/campaigns/:id/assign-groups reutiliza para repartir
// group_assignment (control/experimental). Se prueban aquí, sin Postgres,
// las dos propiedades de las que depende esa reutilización: balance real
// (nunca una diferencia mayor a 1 entre las dos opciones) y determinismo
// (misma semilla -> mismo reparto, sin importar cuándo se llame).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignBalanced } from "../../src/lib/rng.js";

test("assignBalanced reparte 2 opciones balanceadas (diferencia máxima de 1) en conteos pares e impares", () => {
  for (const count of [2, 4, 10, 11, 49, 50, 101]) {
    const assigned = assignBalanced(["control", "experimental"], count, `semilla-${count}`);
    assert.equal(assigned.length, count);
    const control = assigned.filter((x) => x === "control").length;
    const experimental = assigned.filter((x) => x === "experimental").length;
    assert.equal(control + experimental, count);
    assert.ok(Math.abs(control - experimental) <= 1, `count=${count}: control=${control} experimental=${experimental}`);
  }
});

test("assignBalanced es determinista: misma semilla y count -> exactamente el mismo arreglo", () => {
  const a = assignBalanced(["control", "experimental"], 37, "campana-fija:group");
  const b = assignBalanced(["control", "experimental"], 37, "campana-fija:group");
  assert.deepEqual(a, b);
});

test("assignBalanced con semillas distintas produce repartos distintos (no siempre cae en el mismo patrón)", () => {
  const a = assignBalanced(["control", "experimental"], 20, "semilla-A");
  const b = assignBalanced(["control", "experimental"], 20, "semilla-B");
  assert.notDeepEqual(a, b, "dos semillas distintas no deberían producir el mismo orden exacto");
});

test("assignBalanced con count=0 devuelve un arreglo vacío sin lanzar", () => {
  assert.deepEqual(assignBalanced(["control", "experimental"], 0, "cualquier-semilla"), []);
});
