import { mkdirSync } from "fs";
import { join } from "path";

import { createApp } from "./app";

const SERVICE_ROOT = join(__dirname, "..");
process.chdir(SERVICE_ROOT);

mkdirSync("input", { recursive: true });
mkdirSync("output", { recursive: true });

const PORT = parseInt(process.env.SERVER_PORT ?? "3000", 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`docker-download-service listening on port ${PORT}`);
});
