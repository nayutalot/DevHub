# X11 批任务书：桌面收官重打包+常驻换装+ECS 更新 feed 部署+updater 首验

> 背景：main=739775d 含 D5（桌面收官六模块）+X-U（electron-updater）+X-L（本地命令协议②）+W2/W3，门禁全绿（typecheck 0/fast 117/full 211/:app 146/:core 301）。本批使全部桌面改进进在役，并部署 /updates/ feed 供 updater 消费。基线常驻=X10 版。

## 0. 工作区与纪律

- worktree：主仓根 `git worktree add worktrees/x11-repackage -b agent/x11-repackage main`；`npm install`。
- 每 commit 即 push 分支（直连 `git -c http.proxy= -c https.proxy= push` 当前可用；失败退 `git -c http.proxy=socks5h://127.0.0.1:1081 push` 重试循环）；绝不 push main；绝不 --no-verify；凭据三零。
- SSH：`ssh -i ~/.ssh/devhub_ecs root@59.110.149.11`（免密）。**ECS 资源本批独占**。

## 1. 重打包（主仓 main 干净树）

- `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist`（Git Bash；卡→HTTPS_PROXY=http://127.0.0.1:7897 重试一次；rename 残留→手工清 win-unpacked.tmp；勿死等超 10 分钟）。版本号保持 0.1.0 不动。

## 2. asar 验证（grep -F 逐条命中数）

1. D5 增量：`dialog:pickPath`/`ToastProvider`/`useMinuteTick`/`ConfirmDialog`/`row-hit`（键盘可达回归）。
2. X-U 增量：`updaterWire`/`DEVHUB_UPDATE_FEED_URL`/`updates:check`。
3. X-L 增量：`localCommand`/`workspace_link`。
4. 回归点：`LazyView`/`ensureZcodeCliConfig`/`zcode.z.ai`/`backupCollapsed`/`pruneStaleServices`/pdfjs-dist/@napi-rs/canvas。

## 3. 换装（常驻）

- taskkill DevHub.exe → Start-Process dist/win-unpacked/DevHub.exe → `curl http://127.0.0.1:8746/v1/health` ×3 同 PID 200（活性路由 /v1/health）→ tasklist 单实例。
- 顺手：主仓根 `.cdp-dist/` 残留目录重试删除（此前句柄占用；删不掉如实汇报留待）。

## 4. ECS feed 部署

1. 本地 `node scripts/build-updates-feed.mjs` 产 `dist-updates/`（X-U 批脚本，含 latest.yml path 归一化+sha512/size 断言）。
2. ECS 侦察：读 `/etc/caddy/Caddyfile` 现状（relay 443 配置）→ 追加 `/updates/*` 路由（`file_server`，root 指向新目录如 `/var/lib/devhub-updates/`，**只读静态、零执行、零索引**）——改动前备份 Caddyfile（含时间戳）→ `caddy validate` → `systemctl reload caddy`（不重启，亚秒零断流）→ scp 上传 dist-updates/* 到目标目录（权限 0644 root）。
3. 验证：ECS 本机 `curl -sk https://127.0.0.1/updates/latest.yml -H "Host: 59.110.149.11"` 200 且内容完整；目录清单四件（Setup exe/blockmap/latest.yml，portable 不入 feed）。

## 5. updater 首验（换装后的打包实例上，零注入）

- 常驻即打包实例（updater 已启用）：经设置卡「检查更新」或日志证据验证**静默检查链路**：到达 feed+latest.yml 解析成功+版本同为 0.1.0 判「最新」三态正确（设置卡若不可自动化，以 main 进程结构化日志+updates:status 查询为证据，如实记录取证方式）。
- **下载→quitAndInstall 全链本批不做**（同版本号安装语义不明；留 v0.1.1 真实发布时自然验证）——任务书红线。
- Caddyfile reload 后 relay 活性复核：常驻 ws 重连成功（health/连接态）+ `/etc/caddy/` 外零改动。

## 6. 边界

Android 零涉（不出 APK，不 gradle）；证书轮换归下一批（**本批零证书操作**）；dist 根五件新产物照常归一，`dist-cp6/` 勿动；不 bump 版本号。

## 7. 汇报

构建耗时+asar 逐条命中数/feed 装配清单+ECS Caddyfile diff 与 reload 证据+updater 首验证据（日志/状态）+health×3 含 PID+偏差如实。
