# M3-C3b 批任务书（轮换宽限/离线投递 + disconnect 语义 + 桌面面板刷新——ecs-relay+renderer 批）

> 依据：M3-C2 问题清单 #2/#6/#4。前两项 ecs-relay 协议补全（docs/18 §3.14 判据），后一项桌面 renderer 微修。
> 工作目录主仓 `F:\Active_Project\DevHub`，分支 `agent/relay-protocol-fix`（自 main=973eeb3）。范围：`ecs-relay/` + `src/renderer/`。

## 0. 占用资源清单
- 本地：ecs-relay 自含门禁（node --test/selfcheck/loadtest 随机端口）+ 主仓门禁窗口（端口铁律 taskkill→恢复 curl 200）
- **ECS 59.110.149.11**：部署窗口（tar 上传+restart devhub-relay+selfcheck/loadtest 复验）；SSH `ssh -i ~/.ssh/devhub_ecs -o BatchMode=yes root@59.110.149.11`；不碰 caddy/frps/安全组
- 顺手清理：Windows remote_devices 测试残留行 #31/#32/#33 已 revoked 留观，ECS relay_devices #34 孤儿（win=34）——按 C2 证据 revoke 该行（sqlite3 单行 UPDATE，先 SELECT 佐证）；Windows 侧 #34 行 revoke 走桌面 UI 或留 C2b（说明选择）

## 1. 任务

### 修 1（阻断级）：token 轮换 300s 宽限 + 离线投递（C2 #2，docs/18 §3.14）
- **先读 docs/18 §3.14 + docs/19 §3.2 轮换节**，按契约为准实施：①ECS 侧旧 token 哈希宽限窗口 300s（新哈希生效后旧哈希仍认 300s，窗口过后 401）②rotation 帧对**离线设备**的可投递性——若契约定义为"设备重连后经 sync 补"则实现补发路径；若契约未覆盖离线场景或语义冲突 → **停下上报裁决**，勿自创契约
- relay_devices 表若需双哈希列（current+grace）：schema 变更走**新迁移文件**（append-only，0002_rotation_grace.sql 之类），不改建既有列
- node --test 新增：宽限三态（窗内旧 token 200/窗外 401/新 token 恒 200）+ 离线投递路径按所选契约

### 修 2：disconnect deviceId 兜底语义（C2 #6，docs/18 §3.15）
- 现 win_device_id 未命中时按行 id 兜底 → 两平面 id 空间重叠时 revoke 错位（实测撤销 Windows #1 级联掉 relay_devices.id=1）。修：deviceId 解析单一语义（按契约——win_device_id 命中才路由；未命中丢弃+审计 mismatch），加回归用例（重叠 id 场景不错位）

### 修 3：桌面 RelayPanel toggle 刷新（C2 #4/C1c 遗留）
- AgentsView refreshAllPanels 不回刷 RelayPanel enabledSetting（useAsync deps=[]）+ checkbox 显示态与 DB 真值漂移。修：relay 设置变更事件驱动面板刷新（最小改动：settings:set relay 键后失效该查询），显示态从查询真值渲染

## 2. 门禁
- ecs-relay：node --test（83+新增）+ selfcheck（64+新增）+ loadtest 本地全绿 → push 分支 → **ECS 部署+同套复验**（生产库不动，宽限逻辑对存量单哈希行兼容说明）
- 主仓：typecheck 0 + smoke 168/168（修 3 若动共享类型注意 append-only）+ build + mcp 27/27（先 commit 树净）
- 修 3 UI 验证：模拟器不需要；可用 CDP/computer-use 开 Agents 视图 toggle 后勾选态正确截图 1 张（acceptance/desktop/）

## 3. 铁律与汇报
- 契约不明即停（修 1 尤其）；ECS 生产库写操作仅限 #34 revoke 单行；凭据零打印；增量提交+push `origin agent/relay-protocol-fix`
- 汇报四分类+两处门禁数字+ECS 复验数字+契约解读依据（docs 行号）+#34 清理结果+推送状态
