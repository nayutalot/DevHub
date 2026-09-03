// 归档剥离依赖的共享规则（纯数据，service 层与 smoke 共用）。
// S5 批次自 ArchiveKeeper `shared/depDirs.ts` 全量移植（docs/10 §3，原样）。
//
// 归档对象多为尘封项目，依赖目录（node_modules/venv）体积大且 pnpm/npm 的
// 链接是绝对路径，跨盘/改名后必然失效——归档副本不携带它们，恢复只需在有
// lockfile 的前提下重新安装。缓存目录同理可再生成。

/** 永远可剥离的构建/测试缓存目录（与工具链无关，均可再生成） */
export const CACHE_DIR_NAMES: ReadonlySet<string> = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.hypothesis',
  '.gradle-cache',
])

/** JS 依赖目录名（需根目录存在 lockfile 才剥离） */
export const JS_DEP_DIR = 'node_modules'

/** Python 虚拟环境目录名（含绝对路径，移动后必坏；有清单即剥离） */
export const VENV_DIR_NAMES: ReadonlySet<string> = new Set(['venv', '.venv'])

export const JS_LOCKFILES: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'npm-shrinkwrap.json',
]

export const PY_MANIFESTS: readonly string[] = [
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'uv.lock',
  'poetry.lock',
  'setup.py',
]
