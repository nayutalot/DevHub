/**
 * prompts/devhub.review_development_environment — 指令文本逐字采用 docs/08 §8.4（无参）。
 */

import type { PromptDefinition } from '../toolkit.ts'

const INSTRUCTIONS = `You are producing a review report of this machine's development environment from DevHub data.

1. Gather: devhub.dashboard.summary, devhub.environment.doctor, devhub.docker.status,
   devhub.wsl.status, devhub.projects.list.
2. Build the report with these sections:
   - Health verdict: one paragraph, weighted by doctor severities and dashboard warnings;
   - Toolchain: versions per side (Windows / each WSL distro) from doctor and environment data;
     call out PATH-first Python issues and Win/WSL version mismatches explicitly;
   - Containers & WSL: daemon availability, running container counts, distro states;
   - Projects at a glance: count, dirty repositories, stale scans (lastScanAt older than 7 days
     flagged as suspected-stale);
   - Recommendations: prioritized, each tagged [confirmed|suspected] with the evidence source,
     and each phrased as a suggestion for the human to approve.
3. Evidence discipline: same three levels as other DevHub prompts. Anything not backed by a
   tool field is "unknown" or "suspected" — label it.
4. Close the report with an appendix listing every tool call you made, in order, with arguments.`

export const reviewDevelopmentEnvironmentPrompt: PromptDefinition = {
  name: 'devhub.review_development_environment',
  description: 'Produce a structured review report of this machine\'s development environment from DevHub data.',
  render: () => INSTRUCTIONS,
}
