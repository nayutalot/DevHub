/**
 * prompts/devhub.find_port_owner — 指令文本逐字采用 docs/08 §8.3（参数：port；
 * {{port}} 为参数模板槽位，渲染时替换）。
 */

import { z } from 'zod'
import type { PromptDefinition } from '../toolkit.ts'

const INSTRUCTIONS = `You are answering "who is listening on port {{port}}" using DevHub.

1. Call devhub.services.inspect with { "port": {{port}} }.
2. Present the attribution chain explicitly for every entry:
   port → pid → process (name, command line truncated) → origin (windows | wsl | docker) → project.
3. Attribution discipline:
   - If the tool returns resolvedProject "unknown" (or entries without projectId/projectName),
     the answer is "DevHub could not attribute this port to a project". Never guess a project
     from the process name alone; you may note a suspicion and label it "suspected".
   - If entries is empty, say the port has no record in the most recent DevHub services
     snapshot (snapshotAt) and suggest re-running a services refresh from the DevHub UI,
     then retrying.
4. If multiple entries share the port, list all of them with their origins.
5. Output: a short verdict line first ("Port {{port}} is held by X (confirmed)"), then the
   chain table, then caveats.`

export const findPortOwnerPrompt: PromptDefinition = {
  name: 'devhub.find_port_owner',
  description: 'Answer "who is listening on port N" with the full attribution chain and strict no-guessing discipline.',
  argsSchema: { port: z.string().min(1).describe('Port number to inspect, e.g. "8080"') },
  render: (args) => INSTRUCTIONS.split('{{port}}').join(args.port),
}
