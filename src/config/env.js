const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.string().optional().default("development"),
  PORT: z.coerce.number().int().positive().default(4003),
  MONGO_URI: z.string().min(1),
  MONGO_DB_NAME: z.string().min(1).default("hms_appointment"),
  JWT_SECRET: z.string().min(16),
  INTERNAL_API_KEY: z.string().min(8),
  AUTH_SERVICE_URL: z.string().url(),
  USER_SERVICE_URL: z.string().url(),
  NOTIFICATION_SERVICE_URL: z.string().url(),
  API_GATEWAY_URL: z.string().url().optional().default("http://api-gateway:8080")
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = parsed.data;
