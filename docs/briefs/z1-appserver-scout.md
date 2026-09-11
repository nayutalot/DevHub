# Z1 批任务书：zcode CLI 托管可行性侦察（app-server 协议 + 无头面）

> 背景事实链（主控已查明，从结论续做）：
> - zcode 桌面版安装目录藏有 CLI：`C:/Users/sakuya/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs`（v0.16.5，node 运行；系统 node 24.15 可用）。`zcode --help` 实测有：`app-server`（"Run the ZCode Protocol stdio app server"）、`-p/--print` 无头单发、`--prompt <text>`、`--cwd <path>`、`commands/doctor/login/logout/plugins/skills` 子命令、`--disallowedTools` 等参数。
> - `app-server` 已初步实测：stdin 接 /dev/null 立即干净退出（exit 0）= 真 stdio 服务。
> - DevHub 参照系：codex 托管 = `app-server`（JSON-RPC over stdio）+ `exec.spawnManaged`（src/main/services/agentControl/providers/codexProvider.ts L515 起为通道实现，`input:[{type:'text',text}]` 发消息）；能力探针（probe）成功后 caps.mode=managed → App「启动托管会话」门数据驱动自动开。zcodeProvider 现状=纯读九方法（转录投影），observed 只读。
> - 目标：判定 zcode 能否复刻 codex 托管模式（=T2 实现批的可行性依据），产出协议事实与实现路径建议。

## 1. 侦察四问

1. **app-server 协议形态**：JSON-RPC 还是别的？初始化握手（方法名/params）？会话生命周期方法（新建/发消息/收流式事件/中断/结束）？事件帧类型枚举？
   - 首选路径=**静态侦查**：grep/反混淆 `zcode.cjs` 源码里的协议字符串（方法名、事件类型、错误码），同目录 `packages/` 一并查；这比盲发协议猜测稳且零配额。
   - 辅以最小活体：起 app-server 发探到的 initialize 握手，验证一问一答即止（**不发推理任务**）。
2. **无头单发**：`-p/--print` 跑**一个**最小任务（例：`--prompt "Reply with exactly: Z1_OK"`），记录 stdout 形态（纯文本/JSON/ndjson）、退出码、耗时。配额克制：全批推理任务 ≤2 次。
3. **会话落盘**：CLI 会话（app-server/-p）写 `~/.zcode/v2` 何处？与桌面版会话同库同格式吗（转录面可见性=托管会话能否被现有 zcodeProvider 投影读到）？方法：跑 -p 前后对 `~/.zcode/v2` 做 mtime/文件 diff（只列结构，**绝不复制凭据文件内容入证据**）。
4. **发现面与运行面**：zcode.cjs 的稳定发现方式（安装目录枚举？注册表？版本目录命名规律？）；运行依赖（node 版本下限、cjs 是否自包含）；`doctor` 子命令输出可否当探针（probeHealth 候选）。

## 2. 红线

- **令牌三零**：遥控 URL（sid/hash/mid）、登录凭据、完整会话内容绝不入证据/汇报——日志采样一律 masked（R 批 zcode-url-source 先例）。
- 只读侦察：不改仓内任何产品代码；探测脚本放证据目录（脱敏后入册）。
- 探测进程用毕即杀（不留孤儿 stdio 服务）。
- 配额克制（上述 ≤2 次推理任务）；失败如实记录不硬试。

## 3. 交付

- 证据+报告落 `acceptance/agents-mobile/zcode-appserver-scout-20260912/`（masked）；结论直接写进报告头四问四答 + **T2 可行性判定**（go/no-go + 建议实现路径：对照 codexProvider app-server 模式列差异点）。
- Worktree：`F:/Active_Project/DevHub-worktrees/z1scout`，分支 `agent/zcode-appserver-scout`；证据 commit+push 分支（墙期 SOCKS 配方同 T1 任务书 §2）；绝不 --no-verify。
- 汇报：四问四答摘要、T2 判定、证据文件清单、push 回执。
