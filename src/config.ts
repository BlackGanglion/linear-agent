import "dotenv/config";

export type LLMProvider = "kimi" | "gpt";

export interface AppConfig {
  port: number;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenStorePath: string;
  defaultDir?: string;
  // LLM config for triage (OpenAI-compatible API)
  llmProvider: LLMProvider;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
}

function resolveLLMConfig(): {
  llmProvider: LLMProvider;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
} {
  const provider = (process.env["LLM_PROVIDER"] ?? "gpt") as LLMProvider;

  if (provider === "kimi") {
    return {
      llmProvider: "kimi",
      llmBaseUrl:
        process.env["KIMI_BASE_URL"] ?? "https://api.moonshot.cn/v1",
      llmModel: process.env["KIMI_MODEL"] ?? "kimi-k2.5",
      llmApiKey: process.env["KIMI_API_KEY"] ?? "",
    };
  }

  return {
    llmProvider: "gpt",
    llmBaseUrl:
      process.env["GPT_BASE_URL"] ?? "https://api.laozhang.ai/v1",
    llmModel: process.env["GPT_MODEL"] ?? "gpt-5.4-nano",
    llmApiKey: process.env["GPT_API_KEY"] ?? "",
  };
}

export function loadConfig(): AppConfig {
  const webhookSecret = process.env["LINEAR_WEBHOOK_SECRET"] ?? "";
  const clientId = process.env["LINEAR_CLIENT_ID"] ?? "";
  const clientSecret = process.env["LINEAR_CLIENT_SECRET"] ?? "";
  const redirectUri = process.env["LINEAR_REDIRECT_URI"] ?? "";
  const tokenStorePath =
    process.env["TOKEN_STORE_PATH"] ?? ".data/oauth-token.json";
  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  const defaultDir = process.env["DEFAULT_DIR"];
  const llm = resolveLLMConfig();

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
    defaultDir,
    ...llm,
  };
}
