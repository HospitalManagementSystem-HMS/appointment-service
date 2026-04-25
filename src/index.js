const env = require("./config/env");
const { connectMongo } = require("./db/mongoose");
const { createApp } = require("./app");

async function main() {
  await connectMongo({ mongoUri: env.MONGO_URI, dbName: env.MONGO_DB_NAME });
  const app = createApp();
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`appointment-service listening on :${env.PORT}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

