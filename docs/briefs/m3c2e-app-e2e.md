# M3-C2e 终验批任务书（C7a/C7b 活体验证 + R-B 表收口→M3-D 决断）

> C7a（ECS 轮换投递两腿，已部署）/C7b（桌面 host 腿三处理器+grace 镜像+error 回程+崩溃包裹）已合 main。判据权威=docs/20 §3 原文。目标：R-B 表收口至无用户裁决可及的最大程度→M3-D 决断。
> 基线：main 门禁绿（smoke 172/mcp 27/:core 183/:app 47/ecs-relay 97+selfcheck 77 root）。

## 0. 占用资源清单

- **模拟器 1 台全新无 CA**（用毕即关；SDK CLI 起+adb 真身路径见 HANDOFF §7）
- **常驻必须重打包换装**：C7b 动了桌面代码——⓪ 步用 main 重建 win-unpacked（时间戳晚于 da3fd5a 合入；C5a 同法：备份现包→拷入→起常驻→curl 200+connected 复验+**migration 006 自动应用确认**）
- **APK 重建**（时间戳晚于 da3fd5a）
- ECS 只读（SELECT 可/写零容忍，SSH `~/.ssh/devhub_ecs`）；8746 归本批
- 截图 `acceptance/agents-mobile/m3c2e-*.png`；证据分支 `agent/m3c2e-evidence`

## 1. 任务（聚焦序）

**⓪** 重打包换装常驻→gateway 200→m3d-watch connected=true→migration 006 应用确认（真库 schema v6）。
**① R-B2 收口两残面**：App 侧列表可见（agent_list 经 host 腿处理器→200 真数据）；**rotation v2 到达 App**（pair 窗冲刷或重连补偿，C7a）——App 诊断面/SecureStore 佐证+连接不因 grace 墙断。
**② R-B3 头号判据**：连接存活 **>300s** 跨过 grace 窗（C7a 投递+C7b 镜像双保险下自毁链应断；若再确定性复现=修复失效实锤原样上报）+waiting_input 可得面。
**③ R-B4 收口**：合法 200（agents/sessions 列表经 ECS→host 腿处理器真实响应，C2d 的 504 应转 200）。
**④ R-B5**：observed command→command_ack rejected COMMAND_NOT_EXECUTABLE（C7b error 回程面，设备应收回执不再 90s 挂起）；managed send_message→真实推理回流（尽力面：需真实 agent 会话，环境受限如实标注）。
**⑤ R-B6 收口**：杀 App→桌面 ≥3 事件（本地夹具/agent job）→重连 sync 零丢失（sequence 断言）；host 断链→queued→relayed→**result 回流设备**（C7b grace 镜像+error 回程后应闭环）。
**⑥ R-B8**：桌面解锁时 UI revoke 主链（含 401 DEVICE_REVOKED 新口径活体）；仍锁屏=援引 #9 待用户裁决如实标注（协议通道空白）。
**⑦ 本轮配对应零孤儿**：连接存活即无孤儿；若配对再确定性失败→新缺陷如实上报。

## 2. 铁律

同前：凭据零入截图/历史/汇报；每条独立小节（判据原文→证据→PASS/部分/未达）；卡死 ≤2 换条；三次卡死=中断四分类；ECS 零写；绝不 --no-verify；零代码提交（截图入证据分支）。

## 3. 汇报（四分类）

逐条 R-B 表+**R-B 总表终态与 M3-D 决断建议**（R-B3/4/6+R-B2 全过=建议启动 M3-D，R-B8 主链/R-B7 标注为用户裁决项不阻塞稳定期观察）+截图清单+环境恢复声明（常驻终态=新包运行/模拟器关/临时文件删/ECS 账面）+新发现问题清单+证据分支 push 状态。
