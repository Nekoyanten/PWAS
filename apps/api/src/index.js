import "dotenv/config";
import os from "node:os";
import { createApp } from "./app.js";

const app = createApp();
const PORT = process.env.PORT || 3000;

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// Escucha en 0.0.0.0 para que los PC de los participantes lleguen por la red local.
app.listen(PORT, "0.0.0.0", () => {
  const ips = lanAddresses();
  /* eslint-disable no-console */
  console.log(`\nPAWS Campaign — servidor en marcha (puerto ${PORT})\n`);
  console.log(`  Este PC (admin):   http://localhost:${PORT}/admin.html`);
  console.log(`  Dashboard:         http://localhost:${PORT}/index.html`);
  if (ips.length) {
    console.log(`\n  Para los participantes, usa esta dirección de red local:`);
    for (const ip of ips) console.log(`      http://${ip}:${PORT}/t/<token>`);
    console.log(`\n  (si Windows lo pide, permite el acceso en el cortafuegos)`);
  } else {
    console.log(`\n  No se detectó red local. Los participantes deben estar en la misma red que este PC.`);
  }
  console.log("");
  /* eslint-enable no-console */
});
