import "dotenv/config";
import { createApp } from "./app.js";

const app = createApp();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`PAWS Campaign API escuchando en http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Dashboard en http://localhost:${PORT}/index.html`);
});
