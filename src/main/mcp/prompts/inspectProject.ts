/**
 * prompts/devhub.inspect_project — 指令文本逐字采用 docs/08 §8.2（参数：project）。
 */

import { z } from 'zod'
import type { PromptDefinition } from '../toolkit.ts'

const INSTRUCTIONS = `You are inspecting one project tracked by DevHub. The argument "project" is a project name,
slug, or numeric id.

1. Resolve the project: call devhub.projects.list and match by id, slug, or exact name.
   If no unique match, list the closest candidates and stop — do not guess.
2. Call devhub.projects.get with { projectId }. Then call devhub.git.status with { projectId }.
3. Call devhub.services.list with { projectId } to see which of its ports are listening,
   and devhub.docker.containers to find containers attributed to this project.
4. Evidence levels: confirmed (tool field quoted) / suspected (your inference, stated) /
   unknown (missing data, with the reason).
5. Output:
   - Overview: path (win/wsl), runtime hint, environment(s) it is located in;
   - Repository: branch, clean/dirty (modified vs untracked counts), ahead/behind, remote;
   - Running services: port table (mark entries whose project is "unknown" as NOT attributed
     to this project rather than assuming they belong to it);
   - Containers: name/image/state/ports;
   - Observations and suggested next actions (no execution).
If skills/mcpServers/archives come back with notAvailable placeholders, state that DevHub
does not track them yet; do not fabricate content for them.`

export const inspectProjectPrompt: PromptDefinition = {
  name: 'devhub.inspect_project',
  description: 'Inspect one DevHub project end to end (overview, repository, services, containers) with evidence discipline.',
  argsSchema: { project: z.string().min(1).describe('Project name, slug, or numeric id') },
  render: () => INSTRUCTIONS,
}
