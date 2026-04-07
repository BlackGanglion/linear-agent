/**
 * 手动批量触发 triage
 * 用法: npx tsx scripts/triage-batch.ts YOU-100 YOU-110
 */
import { loadConfig } from "../src/utils/config";
import { createLogger } from "../src/utils/logger";
import { getAccessToken, type OAuthConfig } from "../src/infra/linear/oauth";
import { LinearApiClient } from "../src/infra/linear/client";
import { createLinearTriageAgent } from "../src/agent/sub/linear-triage";

function parseIdentifier(identifier: string): { prefix: string; number: number } | null {
  const match = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return { prefix: match[1]!, number: parseInt(match[2]!, 10) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    console.error("用法: npx tsx scripts/triage-batch.ts <FROM> [TO]");
    console.error("  例: npx tsx scripts/triage-batch.ts YOU-100 YOU-110");
    console.error("  例: npx tsx scripts/triage-batch.ts YOU-100  (单个 issue)");
    process.exit(1);
  }

  const fromStr = args[0]!;
  const toStr = args[1] ?? fromStr;

  const fromParsed = parseIdentifier(fromStr);
  const toParsed = parseIdentifier(toStr);

  if (!fromParsed || !toParsed) {
    console.error("无效的 identifier 格式，期望如 YOU-100");
    process.exit(1);
  }
  if (fromParsed.prefix !== toParsed.prefix) {
    console.error("前缀不一致: from 和 to 必须属于同一个 team");
    process.exit(1);
  }
  if (fromParsed.number > toParsed.number) {
    console.error("from 编号必须 <= to 编号");
    process.exit(1);
  }

  const config = loadConfig();
  const logger = createLogger("log");

  const oauthConfig: OAuthConfig = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    webhookSecret: config.webhookSecret,
    tokenStorePath: config.tokenStorePath,
  };

  const tokenResult = await getAccessToken(oauthConfig);
  if (!tokenResult) {
    console.error("无可用的 OAuth token，请先通过 /oauth/authorize 授权");
    process.exit(1);
  }

  const linearClient = new LinearApiClient(async () => {
    const result = await getAccessToken(oauthConfig);
    if (!result) throw new Error("OAuth token 失效");
    return result.accessToken;
  });

  const llmConfig = {
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    apiKey: config.llmApiKey,
  };

  const triageAgent = createLinearTriageAgent(linearClient, llmConfig, logger);

  const prefix = fromParsed.prefix;
  const total = toParsed.number - fromParsed.number + 1;
  console.log(`开始批量 triage: ${fromStr} ~ ${toStr}，共 ${total} 个 issue\n`);

  for (let n = fromParsed.number; n <= toParsed.number; n++) {
    const identifier = `${prefix}-${n}`;
    try {
      const issueId = await linearClient.getIssueIdByIdentifier(identifier);
      if (!issueId) {
        console.log(`  ${identifier} — 未找到，跳过`);
        continue;
      }
      console.log(`  ${identifier} — 开始 triage (id=${issueId})`);
      const result = await triageAgent.invoke({ issueId });
      console.log(`  ${identifier} — ${result.success ? "完成" : "失败"}: ${result.message}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${identifier} — 出错: ${msg}`);
    }
  }

  console.log("\n批量 triage 完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
