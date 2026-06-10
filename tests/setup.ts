process.env.MONGO_URL ??= "mongodb://localhost:27017";
process.env.REDIS_HOST ??= "localhost";
process.env.REDIS_PORT ??= "6379";
process.env.PLATFORM_KEY ??= "1".repeat(65);
process.env.JWT_SECRET ??= "test-jwt";
process.env.WEBHOOK_SECRET ??= "test-wh";
process.env.SEED_USER_PASSWORD ??= "password123";
