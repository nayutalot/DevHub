/**
 * prompts/index.ts — 4 个 prompt 的注册清单（docs/08 §8，指令文本逐字实现）。
 */

import { diagnoseEnvironmentPrompt } from './diagnoseEnvironment.ts'
import { findPortOwnerPrompt } from './findPortOwner.ts'
import { inspectProjectPrompt } from './inspectProject.ts'
import { reviewDevelopmentEnvironmentPrompt } from './reviewDevelopmentEnvironment.ts'
import type { PromptDefinition } from '../toolkit.ts'

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  diagnoseEnvironmentPrompt,
  inspectProjectPrompt,
  findPortOwnerPrompt,
  reviewDevelopmentEnvironmentPrompt,
]
