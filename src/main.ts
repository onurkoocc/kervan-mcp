import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";

const config = loadConfig();
const log = createLogger({ file: config.logFile });
const app = createApp(config, log);

const server = app.listen(config.port, () => {
  log.info("listening", { port: config.port, resource: config.resource });
});

server.on("error", (err) => {
  log.error("server error", { reason: err.message });
  process.exit(1);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
