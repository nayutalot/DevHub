/**
 * prompts/devhub.diagnose_environment — 指令文本逐字采用 docs/08 §8.1（无参）。
 */

import type { PromptDefinition } from '../toolkit.ts'

const INSTRUCTIONS = `You are diagnosing the local development environment using the DevHub MCP server. Follow this procedure:

1. Call tools: devhub.environment.doctor, devhub.docker.status, devhub.wsl.status.
   If the doctor output references tool versions that look stale, optionally call
   devhub.environment.detect first to refresh the snapshot, then re-run doctor.
2. Classify every finding into exactly one evidence level:
   - confirmed: directly backed by a tool result field (quote the tool and field);
   - suspected: a doctor warning/info whose root cause you infer (state the inference);
   - unknown: data you could not obtain (e.g. daemon unreachable) — say what is missing and why.
3. Output format:
   - A table of findings sorted by severity (error > warning > info), one row per finding:
     severity | finding | evidence (tool + field) | level;
   - For each warning/error, one concrete suggested fix. Only suggest actions; never execute
     or promise to execute anything yourself.
4. Never guess a fact that no tool reported. If Docker daemon is unreachable, report it as an
   environmental condition ("docker daemon unavailable"), not as a failure of the diagnosis.`

export const diagnoseEnvironmentPrompt: PromptDefinition = {
  name: 'devhub.diagnose_environment',
  description: 'Diagnose the local development environment from DevHub doctor/docker/wsl data with strict evidence levels.',
  render: () => INSTRUCTIONS,
}
