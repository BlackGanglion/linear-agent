import "dotenv/config";

export type LLMProvider = "moonshot" | "claude";

interface ProviderDefaults {
  baseUrl: string;
  model: string;
  envPrefix: string;
}

const PROVIDER_DEFAULTS: Record<LLMProvider, ProviderDefaults> = {
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.6",
    envPrefix: "MOONSHOT",
  },
  claude: {
    baseUrl: "https://api.laozhang.ai/v1",
    model: "claude-sonnet-4-6",
    envPrefix: "CLAUDE",
  },
};

export interface AppConfig {
  port: number;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStorePath: string;
  llmProvider: LLMProvider;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  triageMinIssueNumber: number;
}

export function loadConfig(): AppConfig {
  const webhookSecret = process.env["LINEAR_WEBHOOK_SECRET"] ?? "";
  const clientId = process.env["LINEAR_CLIENT_ID"] ?? "";
  const clientSecret = process.env["LINEAR_CLIENT_SECRET"] ?? "";
  const redirectUri = process.env["LINEAR_REDIRECT_URI"] ?? "";
  const tokenStorePath =
    process.env["TOKEN_STORE_PATH"] ?? ".data/oauth-token.json";
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const triageMinIssueNumber = parseInt(
    process.env["TRIAGE_MIN_ISSUE_NUMBER"] ?? "0",
    10,
  );

  // LLM provider resolution: LLM_PROVIDER -> provider-specific env vars -> generic LLM_* fallback
  const llmProvider = (process.env["LLM_PROVIDER"] ?? "moonshot") as LLMProvider;
  const defaults = PROVIDER_DEFAULTS[llmProvider] ?? PROVIDER_DEFAULTS.moonshot;
  const prefix = defaults.envPrefix;

  const llmBaseUrl =
    process.env[`${prefix}_BASE_URL`] ?? process.env["LLM_BASE_URL"] ?? defaults.baseUrl;
  const llmModel =
    process.env[`${prefix}_MODEL`] ?? process.env["LLM_MODEL"] ?? defaults.model;
  const llmApiKey =
    process.env[`${prefix}_API_KEY`] ?? process.env["LLM_API_KEY"] ?? "";

  if (!webhookSecret || !clientId || !clientSecret || !redirectUri) {
    console.error(
      "Missing required env vars: LINEAR_WEBHOOK_SECRET, LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_REDIRECT_URI",
    );
    process.exit(1);
  }

  return {
    port,
    webhookSecret,
    clientId,
    clientSecret,
    redirectUri,
    tokenStorePath,
    llmProvider,
    llmBaseUrl,
    llmModel,
    llmApiKey,
    triageMinIssueNumber,
  };
}
