// Command registry. Each module registers its command group on the root.
import type { Command } from "commander";
import { registerAuthCommands } from "./auth.js";
import { registerConfigCommands } from "./config-cmd.js";
import { registerMetaCommands } from "./meta.js";
import { registerHelpTopics } from "./help-topics.js";
import { registerApiCommand } from "./api.js";
import { registerConvertCommands } from "./convert.js";
import { registerUrlSiteCommands } from "./url-site.js";
import { registerJobsCommands } from "./jobs.js";
import { registerFormatsCommands } from "./formats.js";
import { registerPerceiveCommands } from "./perceive.js";
import { registerDiscoverCommands } from "./discover.js";
import { registerLookupCommands } from "./lookup.js";
import { registerDistillCommands } from "./distill.js";
import { registerIngestCommands } from "./ingest.js";
import { registerCompletionCommand } from "./completion.js";
import { registerMcpCommand } from "./mcp.js";
import { registerUpgradeCommand } from "./upgrade.js";

export function registerCommands(program: Command): void {
  // v1 file conversion (convert is the default command: `enconvert a.docx --to pdf`)
  registerConvertCommands(program);
  registerUrlSiteCommands(program);
  // v2 web data
  registerPerceiveCommands(program);
  registerDiscoverCommands(program);
  registerLookupCommands(program);
  registerDistillCommands(program);
  registerIngestCommands(program);
  // resources & meta
  registerJobsCommands(program);
  registerFormatsCommands(program);
  registerMetaCommands(program);
  registerAuthCommands(program);
  registerConfigCommands(program);
  registerApiCommand(program);
  registerCompletionCommand(program);
  registerUpgradeCommand(program);
  registerMcpCommand(program);
  registerHelpTopics(program);
}
