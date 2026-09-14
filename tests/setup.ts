// Test environment, applied before any module is evaluated. The config module reads process.env once.
process.env.AGENT_MODEL = "mock:echo";
process.env.AGENT_API_KEY = "secret-test-key";
process.env.RATE_LIMIT_RPM = "1000";
process.env.LOG_LEVEL = "silent";
