# M3-D 窗内尾巴批 W1 任务书（dist 根 NSIS 归一 + worktree 清理）

> 背景：主仓 dist/win-unpacked=main 桌面全量包正在被常驻运行（M3-D 观察窗对象，**绝不可动**）；dist 根四件仍是 9-6 v3 旧件（与运行包不一致）。本批在 worktree 重建归一根件。
> 基线：main @ 06e96b4。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/dist-final`（**detached**：`git worktree add --detach ... main`）；npm install（无 node_modules）
- **无端口**（不跑门禁——8746 归常驻）；**不启动任何产物**；不碰 ECS/模拟器
- **主仓 dist/ 根四件部署段独占**；主仓 dist/win-unpacked 与三个 bak 目录**只读勿动**

## 1. 任务

1. worktree 内 npm install → `npm run typecheck`（0 错）→ `npm run dist`（electron-builder 缓存机器级共享；latest.yml 生成用 `-c.publish.provider=generic -c.publish.url=<dummy>` 既定解法）
2. 产物核验：NSIS Setup/portable exe + latest.yml + blockmap 齐全；sha256 记录；构建时间戳确认晚于 06e96b4
3. **部署（只动根四件）**：主仓 `dist/` 根的 `DevHub Setup 0.1.0.exe`/`DevHub 0.1.0.exe`/`DevHub Setup 0.1.0.exe.blockmap`/`latest.yml` 用新件覆盖（旧件即 9-6 v3 件，覆盖前记录旧 sha256）；builder-debug.yml 一并换新。**绝不触碰 dist/win-unpacked/**（常驻运行中；新 worktree 的 win-unpacked 留在 worktree 内即可）
4. 收尾核验：常驻无扰动（`tasklist` DevHub.exe 4 进程仍在、主 PID 39856、curl 8746 health 200——前后对照）；零 electron 残留；8746 监听者仍为 39856
5. **worktree 清理**：`git worktree remove F:/Active_Project/DevHub-worktrees/dist-v3`（旧基线 detached，使命已毕）；重试 `rm -rf F:/Active_Project/DevHub-worktrees/gate-fix`（core.jar 句柄或已释放；仍锁=如实上报留观）；本批 dist-final worktree 保留（产物在 git 外，留主控处置）
6. 零仓内提交（dist gitignored；detached 无分支）

## 2. 铁律

不为打包启动产物；主仓工作区零修改；磁盘变化记录（+/-MB）；失败重试 ≤2。

## 3. 汇报（四分类）

新根四件 sha256+时间戳、旧件 sha256 对照、常驻无扰动前后对照、worktree 清理结果、磁盘变化。
