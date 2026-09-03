// 扫描规则（纯常量与纯函数）：目录忽略清单、venv 定点、二进制嗅探、manifest 特征。
// S5 批次自 ArchiveKeeper `shared/scanRules.ts` 全量移植（docs/10 §3，原样）。

/** 遍历时整棵跳过的目录名（小写比较；docs/10 §3「约 25 目录」） */
export const IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  '.nuxt',
  '.gradle',
  'obj',
  'vendor',
  'coverage',
  '.turbo',
  '.cache',
  'objects',
  'listings',
])

/** 虚拟环境目录（虽被忽略，但其激活脚本写死绝对路径，需定点扫描） */
const VENV_ACTIVATE_PATTERNS: RegExp[] = [
  /^pyvenv\.cfg$/i,
  /^[\\/]?(?:scripts|bin)[\\/]activate(\.bat|\.ps1|\.fish|\.zsh|\.csh)?$/i,
]

/**
 * 被忽略目录内的定点扫描：若文件相对该忽略目录的路径命中
 * venv 激活脚本/pyvenv.cfg，则仍然扫描（docs/10 §4 venv 例外定点）。
 */
export function isVenvActivationFile(relInsideIgnoredDir: string): boolean {
  const norm = relInsideIgnoredDir.replace(/^[\\/]+/, '')
  return VENV_ACTIVATE_PATTERNS.some((rx) => rx.test(norm))
}

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.ogg', '.mp4', '.mkv', '.avi', '.mov', '.webm',
  '.zip', '.7z', '.rar', '.gz', '.bz2', '.xz', '.zst', '.tar',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pdb', '.idb', '.wasm', '.class', '.jar', '.pyc', '.pyd', '.node',
  '.db', '.sqlite', '.sqlite3', '.parquet', '.arrow', '.pb',
  '.psd', '.ai', '.sketch', '.blend', '.fbx', '.glb', '.gltf',
])

export function hasBinaryExtension(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/** git 同款启发式：前 8KB 内出现 NUL 字节视为二进制（边界恰在 8KB 内） */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export interface ManifestInfo {
  file: string
  type: string
}

/** 项目类型识别用的 manifest 特征文件（按优先级排列） */
export const MANIFESTS: readonly ManifestInfo[] = [
  { file: 'package.json', type: 'Node.js' },
  { file: 'pyproject.toml', type: 'Python' },
  { file: 'requirements.txt', type: 'Python' },
  { file: 'setup.py', type: 'Python' },
  { file: 'Cargo.toml', type: 'Rust' },
  { file: 'go.mod', type: 'Go' },
  { file: 'pom.xml', type: 'Java · Maven' },
  { file: 'build.gradle', type: 'Java · Gradle' },
  { file: 'build.gradle.kts', type: 'Java · Gradle' },
  { file: 'composer.json', type: 'PHP' },
  { file: 'Gemfile', type: 'Ruby' },
  { file: 'CMakeLists.txt', type: 'C/C++ · CMake' },
  { file: 'mix.exs', type: 'Elixir' },
  { file: 'pubspec.yaml', type: 'Flutter/Dart' },
]
