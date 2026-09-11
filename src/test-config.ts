import { type CliConfig, loadCliConfig } from "./config";

const TEST_ENV = {
  WEGO_AUTH_AUTHORIZE_URL: "https://auth.test/authorize",
  WEGO_AUTH_TOKEN_URL: "https://auth.test/token",
  WEGO_CLI_CLIENT_ID: "test-client",
  WEGO_API_URL: "https://api.test",
};

export function loadTestCliConfig(
  overrides: Record<string, string> = {},
): CliConfig {
  return loadCliConfig({ ...TEST_ENV, ...overrides });
}
