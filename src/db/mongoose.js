const mongoose = require("mongoose");

async function connectMongo({ mongoUri, dbName }) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(mongoUri, { dbName });
}

module.exports = { connectMongo };

