function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export const config = {
  providers: {
    retries: boundedInteger('PROVIDER_RETRIES', 1, 1, 2),
    timeoutMs: boundedInteger('PROVIDER_TIMEOUT_MS', 45_000, 1_000, 125_000),
  },
};
