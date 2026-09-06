# M3-C2d 聚焦复跑批任务书（C6c/C6d 修复活体验证 + R-B 表收口）

> C2c 未达项的收口批。C6c（六项）+C6d（REST TLS）已合 main，判据权威仍=docs/20 §3 原文。目标：R-B 表全过→M3-D。
> 基线：main 门禁绿（smoke 169/mcp 27/:core 183/:app 40/ecs-relay 91）。

## 0. 占用资源清单

- **模拟器 1 台·全新无 CA**（上批 CA workaround 模拟器已消亡——**本次 TLS pin 面首次可真测**；用毕即关）
- **常驻=现有 fe306b9 win-unpacked**（C6c/C6d 均为 Android/脚本面，**桌面零改动无需重打包**）——⓪ 步拉起即可；除 R-B6 host 断链外不动
- **APK 必须重建**（时间戳晚于 C6d 合入；JAVA_HOME jbr）
- ECS 只读（SELECT 可/写零容忍，SSH `~/.ssh/devhub_ecs`）；8746 归本批
- 截图 `acceptance/agents-mobile/m3c2d-*.png`；证据分支 `agent/m3c2d-evidence`
- 工作站锁屏面：REST 签发免疫；桌面 UI 证据仅解锁可用——不可用时以等价证据（DB/REST/audit）替代并如实标注

## 1. 任务（聚焦序；判据 docs/20 §3）

**⓪** 拉起常驻→gateway 200→m3d-watch connected=true（顺带验 #5 修复后 relay_enabled 不再 unknown）。
**① R-B2 完整收口（三修联验主战场）**：REST 签发→App（新 APK）真实 WS pair→**TLS pin 握手应过**（C6d+勘误语义：pin-TM 单点信任无 pinner）→pair_accepted→SecureStore（含 **pair 腿捕获的 rotation v2**，C6c bug#3）→双侧列表可见（App 侧=C6d GatewayApi/ApiProvider 修后面；桌面侧=REST/audit/截图）→origin=relay→token_version=2 双侧一致。
**② R-B3**：≥5 分钟零断连（**自毁应消**——连接跨过 grace 窗 300s 存活即为 C6c bug#3 活体闭环证据，把"连接存活时长>300s"明确写进证据）+waiting_input 可得面。
**③ R-B4（协议腿 stand-in 允许）**：App token 明文按凭据红线不可取——用 C2 夹具 `acceptance/agents-mobile/m3c2-standin-device.mjs`（协议对等 stand-in，token 在夹具内存/临时文件）对公网 443 验：同 nonce 重放 401/窗外 401/合法 200/命令帧 AUTH_REPLAYED；token 经环境变量或临时文件用毕删。
**④ R-B5**：observed 会话 command→COMMAND_NOT_EXECUTABLE；managed 会话 send_message→真实推理回流（事件到 App；R5.3 事件驱动 <2s 顺带记录）。
**⑤ R-B6**：杀 App→期间桌面产生 ≥3 事件（本地夹具/agent job 驱动面生成，锁屏不影响 headless agent）→重连 sync_request 补齐零丢失（sequence 连续断言）；host 断链（重启常驻）→期间 App 发命令→queued→上线投递→result 回流。
**⑥ R-B7**：核查结论已立（触发面未实现=selfcheck §11 覆盖，不算失败）——只确认 C6c 后无新增触发面即可。
**⑦ R-B8 主链**：优先桌面 revoke（解锁时 UI；否则桌面侧 L3/夹具通道 m3c2-revoke-row.ps1 模式）；App 自撤销（C6c 修后真实生效）作补充路径——revoke 当前被试设备→disconnect(revoked) 停止重连→再连 401 **DEVICE_REVOKED**（新口径）→ECS+桌面注册表 revoked 一致。**顺带清账**：ECS #2/3/4 与桌面 #38/39/40 遗留行经桌面侧通道逐个撤销（等价 R-B8 重复验证）；不可行=如实上报留主控处置。
**⑧ TLS 拒面收口**：正确指纹握手过（①已覆盖，单独标注）；错误指纹→PinTrustManager 结构化拒不崩；host 错指纹面 C2c 已 PASS（复测可选，不复测则援引 C2c 证据）；过期证书=selfcheck 日历覆盖标注。

## 2. 铁律

同 C2c 版：凭据零入截图/历史/汇报；每条独立小节（判据原文→证据→PASS/部分/未达）；卡死 ≤2 轮换条；三次卡死=中断四分类；ECS 零写；绝不 --no-verify；零代码提交（截图入证据分支）。

## 3. 汇报（四分类）

逐条 R-B 表 + 三修联验结论独立小节（bug#1/2/3+GatewayApi TLS 各自活体证据）+ **R-B 总表终态（全过与否）** + 截图清单 + 环境恢复声明（常驻终态/模拟器关/临时文件删/ECS 账面终态）+ 新发现问题清单 + 证据分支 push 状态。
