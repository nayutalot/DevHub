# M3-D 窗内尾巴批 W2 任务书（docs/18 三处实现层增补注入册）

> C6c/C7a/C7b/C8a 四批的协议实现层语义已在代码 KDoc 标注，本批将其正式入册 docs/18——**勘误/增补注风格（同 docs/19 §10.2 先例）：不动规范性原文、不宣告新帧、可裁决后撤改**。
> 基线：main @ 06e96b4。

## 0. 占用资源

- worktree `F:/Active_Project/DevHub-worktrees/docs18-notes`（分支 `agent/docs18-notes`，自 main 切；纯 docs 无需 npm）
- 无端口/ECS/常驻触碰；每 commit 即 push

## 1. 三处增补注（内容要点；措辞对齐 docs/19 §10.2 勘误注先例）

1. **§3.14 token_rotation**：增补注「M3-C7a 实现层增补（2026-09-07）」——投递通道=E→D 允许于该设备**任一活跃 device-leg 连接**（含裸 pair 连接的配对完成窗口：pair_accepted 后短窗 5s 内 flush 未投递轮换帧再关闭）；设备 grace 窗内重连（viaGrace 准入）时服务端**补投**当前 token（compensation）；帧形不变、无新帧。引 C7a 实现（forwarder.ts）与 selfcheck §11。
2. **§3.0 #16 error 帧**：增补注「M3-C7b 实现层现状（2026-09-07，待裁决）」——协议未定义 H 生成 error 如何回程设备（跨腿通道空白，C2d 实证 90s 挂起）；现行最小实现**复用 §3.9 command_ack{rejected, errorCode}（中继=是）承载错误码回程**，errorCode 同 §8.2 命名域；H→E error 帧保留主机腿诊断。**若后续按契约修订流程定义专用回程帧形，应迁移并撤除 command_ack 载体**。
3. **§3.11 sync_request**：增补注「M3-C8a 实现层澄清（2026-09-07）」——requestId 为必填 uuid（ECS asString 校验强制，BAD_PAYLOAD 拒绝）；fresh 设备 after=0 合法且**必须发出**（§6.1.2 引导语义，M3-C8a 修复早退违约并实证全量回填）；已知实现空白一处如实注明：ECS 缓存全空（hello.sequence=0）+ fresh 设备的 live 流基线对齐未定义、依赖重连再引导（RelaySyncEngine.kt 类注释）。

## 2. 任务

1. worktree 自建 → 三处增补注落 docs/18 对应节（**只加注不改正文**；每处标批次号+日期+实现锚点文件）
2. 自查：不改任何规范性句子、不新增帧宣告、与 docs/19 勘误注风格一致
3. commit+push `agent/docs18-notes`

## 3. 铁律

docs/18 是协议权威——宁可保守勿扩权；#9/离线补投等**未裁决项不得借增补注夹带**；绝不 --no-verify。

## 4. 汇报（四分类）

三处增补注原文+所在节行号+自查声明+push 状态。
