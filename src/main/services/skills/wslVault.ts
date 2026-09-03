/**
 * skills/wslVault.ts — WSL 侧 vault 挂载点常量与路径换算
 * （docs/09 §2 模块映射：Skill-Manager src/shared/paths.ts 的 DevHub 归宿）。
 * 与 wslBridge.runCompanion、companion skm（skm-src/skm.mjs）的 VAULT 保持一致。
 */

/** WSL 侧 vault 挂载点（companion 维护的 git clone）。 */
export const WSL_VAULT = '/root/skill-vault'

/** Windows 路径 → WSL 路径（/mnt/<盘符小写>/...）；非盘符路径原样返回。 */
export function winPathToWslPath(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):[\\/](.*)$/)
  if (m === null) return winPath
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '')
  return rest.length > 0 ? `/mnt/${m[1].toLowerCase()}/${rest}` : `/mnt/${m[1].toLowerCase()}`
}

/** Windows 侧可打开的 WSL 路径（\\wsl.localhost\<distro>\root\skill-vault\skills\<name>）。 */
export function wslUncSkillDir(distro: string, skillName: string): string {
  return `\\\\wsl.localhost\\${distro}\\root\\skill-vault\\skills\\${skillName}`
}
