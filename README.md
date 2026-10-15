# 全自动日常（MAA + MaaEnd 无人值守关机）

凌晨 3–4 点或 7–8 点开机时自动执行日常任务并在完成后关机的主控脚本（触发时段为自定义多段式，见 `window.slots`）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `daily.mjs` | 主控脚本（唯一需要被计划任务调用的入口） |
| `config.json` | 全部可调参数（缺失/损坏/非法时自动回退或修正默认值并记日志） |
| `errorHandler.example.mjs` | 错误处理接口示例，复制为 `errorHandler.mjs` 后生效 |
| `logs\daily-YYYY-MM-DD.log` | 运行日志（UTF-8，按天切分，自动创建） |
| `state\lock.json` | 单实例锁（含时效校验，防重复运行） |
| `state\ran-YYYY-MM-DD.json` | 当日已执行标志（每个自然日至多完整执行一轮） |
| `state\maa_done.flag` | MAA 完成回调标志（由 MAA 结束后脚本写入） |

## 工作流程

```
计划任务拉起 daily.mjs（登录时 + 15s）
  ├─ 1. 单实例锁（O_EXCL 原子创建；陈旧锁含 90min 时效与 PID 校验）
  ├─ 2. 时间窗判定（三重门，全部通过才继续）：
  │     ① boot ∈ 任一自定义时段（默认 [03:00,04:00) 与 [07:00,08:00)；
  │        boot = CIM LastBootUpTime × 事件6005 交叉校验）
  │     ② now < 命中时段的 end + nowGraceMin(60min)  ← 防「开机后晚登录/白天重跑」
  │     ③ 今日尚未完整执行过（state/ran-日期.json）
  │     任一不满足 → 数行判定日志后静默退出（不启动程序、不设看门狗）
  ├─ 3. 挂看门狗 shutdown /a（清残留）→ shutdown /s /t 1800 /f
  │     ← 先于启动一切外部程序；脚本崩溃也有 30 分钟兜底
  ├─ 4. 向 MAA 配置注入「结束后脚本」回调（仅当该配置为空；原子备份+写入）
  ├─ 5. 启动 MAA.exe 与 MaaEnd.exe，等待就绪（120s）
  │       MAA：进程存活 5s 即就绪 + 信号通道确认日志
  │       MaaEnd：探测 12701–12710 实际 web 端口（被占用会自动回退）
  ├─ 6. 监测至双方均完成（轮询 2s；预算链保证超时点+错误处理 < 看门狗）
  │       MAA 完成信号：① --maa-done 回调写 flag ② gui.log 增量尾随（成功/错误收尾都识别）
  │       MaaEnd 完成信号：① GET /api/maa/state 轮询（先见过 running 才认终态）
  │                        ② ws /api/ws 的 tasks-completed 加速
  │       任一进程意外退出（含复用进程的 10s 探活）/ 监测超时 / 任务错误收尾 → 错误路径
  └─ 7. 收尾（幂等）
        正常：shutdown /a && shutdown /s /t 5 /d p:4:1 /f → 关机
        错误：执行预留错误处理接口（三层）→ 同样关机
        兜底：若 /s 两次失败 → 立即重挂看门狗 + ERROR 告警（绝不存在「无计划裸奔」状态）
```

## 前提条件（部署前确认）

1. **Node.js ≥ 18（推荐 ≥ 21）**：脚本使用原生 `fetch`/`AbortSignal.timeout`（≥18）与原生
   `WebSocket`（≥21，缺失时自动降级为纯轮询）。本机实测 v26.7.0。
   检查：`node --version`。**旧版 Node 会导致端口探测恒失败 → 就绪超时 → 开机即走错误关机**，
   且 `--self-test`/`--dry-run` 测试全绿发现不了此问题。
2. **Windows 自动登录**：凌晨无人值守，GUI 程序必须运行在用户会话中。
   `Win+R → netplwiz` → 取消勾选「要使用本计算机，用户必须输入用户名和密码」。
3. **MAA 侧已配置启动后自动开跑**：设置 → 启动设置，`RunDirectly = true`（你本机现为 `true`）。
4. **MaaEnd 侧已配置启动后自动开跑**：`config\mxu-MaaEnd.json` 中 `autoRunOnLaunch=true` +
   `autoStartInstanceId` 指向「全套日常」（你本机现为 `e7powy7`，已确认）。
5. **写入权限**：脚本启动 MAA 前会向 `D:\Program Files\MAA\config\gui.new.json` 注入回调。
   权限不足时记 WARN 并自动降级为 gui.log 通道（功能不受影响）。
6. **Windows 快速启动**：你本机实测未启用（`HibernateEnabled=0`）。时间窗判定已做
   CIM × 事件6005 双源交叉校验，快速启动导致的过期值会被自动纠正。

## 注册计划任务（管理员 PowerShell）

```powershell
$node   = "C:\Program Files\nodejs\node.exe"
$script = "C:\Users\13199\Documents\其他工作区\全自动日常\daily.mjs"

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
# 「登录时」触发 + 15 秒延迟：等桌面就绪（系统启动触发在未登录时跑在会话0，GUI 起不来）
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME" -Delay (New-TimeSpan -Seconds 15)
# 防重复实例；45 分钟强杀兜底（看门狗 30 分钟更早，正常情况轮不到它）
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 45) -StartWhenAvailable -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName "DailyAutoRoutine" -Action $action -Trigger $trigger -Settings $settings -Force
```

要点：
- **必须用「登录时」触发或「启动时 + 仅当用户登录时运行」**，绝不能跑在 SYSTEM 会话。
- 任务**不要**加 `--force` 参数（那是调试开关，会绕过时间窗与当日配额）。
- 检查：`Get-ScheduledTask DailyAutoRoutine | Get-ScheduledTaskInfo`

## 测试（分层，前两层不会误关机）

```powershell
cd "C:\Users\13199\Documents\其他工作区\全自动日常"

node daily.mjs --self-test       # 1. 逻辑自检（44 例：多时段边界/同日重跑/回拨/配置校验/预算clamp/MaaEnd判定/命令格式）
node daily.mjs --window-test     # 2. 打印开机时间、窗口、nowLimit、ranToday（只读；exit 0=在窗口内）
node daily.mjs --dry-run --force # 3. 全链路演练：打印将执行的全部动作，不真关机/不启动程序/不写当日标志
```

真机全流程验证（**会真的关机**，请确认可关机时再做）：

1. 临时改 `config.json`：`"watchdogSec": 600`、`"monitorTimeoutSec": 480`
   （预算链会自动校验，`600-120-120-60=300`，monitor 超 300 会被 clamp 并 WARN——这是预期行为）；
2. 临时改 `"window": { "slots": [{ "startHour": <当前小时>, "endHour": <当前小时+1> }] }`
   （slots 为多时段数组，测试时改成单段最直观）；
3. 运行 `node daily.mjs --force`（**用 --force**：绕过时间窗与「当日已执行」配额，避免被挡）；
4. 观察日志：启动 → 就绪（含信号通道确认行）→ 心跳 → 双完成 → 关机命令；
5. 测完**立即改回** `3/4` 与 `1800/1500`，并删除 `state\ran-*.json`（若测试时没用 --force）。
   - 测试中途想中止：Ctrl+C——脚本仅在「自己挂起过关机计划」时执行 `shutdown /a`，
     既不会留下看门狗，也不会误取消你自己排程的关机。
   - 若 MAA/MaaEnd 已在运行：脚本**复用**而不重复启动（日志记「复用」），复用进程由 10s 周期探活监测。

建议首跑做一次**错误收尾场景**验证：观察 MAA 部分任务失败时，日志是 `TASK_ERROR`（错误处理）
而非 `ALL_DONE`——这依赖 MAA「先写错误日志、后执行结束后脚本」的内部顺序（常规实现如此，实测确认一次更稳）。

## 错误处理接口（预留）

三层机制，全部执行完毕后**无论结果如何都关机**：

1. **默认**：写 `logs\` 下 ERROR 日志；
2. **可替换模块**：复制 `errorHandler.example.mjs` 为 `errorHandler.mjs`，实现
   `export async function handle(err, ctx)`（`ctx = { stage, config, log, startedAt }`），
   超过 `onError.timeoutSec` 未返回则视为超时，不阻塞关机；
3. **外部命令**：`config.json → onError.command` 非空则以子进程执行（shell 方式，60s 超时）。

进入错误路径的条件：看门狗挂载失败、exe 不存在、进程启动后立即退出、MaaEnd 端口 120s 未就绪、
任一进程意外退出（含复用进程消失）、监测超时、任务错误收尾（MAA「以下任务出现错误」/
MaaEnd `overall_status=Failed`）。

**关机授权状态机**：只有时间窗判定通过后（`runPhase=armed`）发生的异常才会进入「错误处理→关机」。
初始化阶段（锁、时间窗判定）与 `--maa-done` 回调入口的异常只记日志退出，**绝不关机**。

## 关键配置（config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `window.slots` | `[{3,4},{7,8}]` | **自定义多时间段**：`[{"startHour":3,"endHour":4},{"startHour":7,"endHour":8}]`，开机时间落入任一段（左闭右开）即触发；1–6 段，start∈0–23、end∈1–24、start<end（end=24 仅当日该段生效，不支持跨零点段），非法则整组回退默认双时段 |
| `window.nowGraceMin` | 60 | 每段的当前时刻上限 = 该段 endHour + 此值（分钟）。开机后晚于此时登录 → 静默退出 |
| `watchdogSec` | 1800 | 兜底关机（30 分钟）。**是兜底不是正常路径**——若日常实测总时长接近/超过 30 分钟，调大它 |
| `monitorTimeoutSec` | 1500 | 监测超时 → 走错误处理后关机。启动时强制满足预算链：`watchdog ≥ ready + monitor + 2×onError + 60s`，越界自动 clamp 并 WARN |
| `readyTimeoutSec` | 120 | 两进程启动就绪上限（MaaEnd 端口探测也在其中） |
| `shutdownGraceSec` | 5 | 关机前宽限秒数（给日志 flush；>0 时 shutdown 自动隐含 `/f`）。必须是非负整数（非法值会被校验回退） |
| `maa.injectPostRunScript` | true | 自动注入 MAA「结束后脚本」回调。**要彻底移除注入就把它改为 `false`**（仅删 gui.new.json 里的值会被下次运行重新注入） |
| `maend.portScan` | 12701–12710 | MaaEnd web 端口探测范围（端口被占它会自动回退） |
| `onError.command / timeoutSec` | 空 / 60 | 错误时执行的外部命令与其超时 |

所有数值字段启动时校验：非法类型/越界 → 回退默认值并 WARN（不会因手改笔误导致关机命令失败）。

## 运行须知与已知边界

- **日志是第一诊断依据**：`logs\daily-*.log` 覆盖时间判定（含 bootOk/nowOk/上限）、看门狗、注入、
  启动/复用、信号通道确认、每条信号、心跳、错误、关机命令退出码与兜底结果。
- **MaaEnd 是启动器(stub)模式**：spawn 出的进程约 0.3s 内以 code=0 退出，真实 GUI 进程以新 PID
  接管（父进程仍为 stub）。脚本收到 stub 退出事件后立即 tasklist 复核：存在存活 MaaEnd.exe →
  视同交接成功转周期探活（与复用进程同路径，真实应用崩溃由 10s 探活兜底）；三次复核（约 2s）
  均无进程才记为真实退出，启动失败仍能快速进错误路径。
  （2026-10-15 修复：此前把 stub 退出直接判为「MaaEnd 启动后退出」→ SETUP_ERROR → 开机 2s 即
  关机，真实应用被关机命令连带杀死——当日 17:11 窗口轮次即因此失败。）
- **每个自然日只执行一轮**：完成/出错关机后，同日再登录、再手动运行都会被
  「当前时刻上限」或「当日执行标志」静默拦下。需要重跑：`--force` 或删 `state\ran-*.json`。
  （取舍说明：若首轮被断电/硬杀中止，同日重启也会被拦——这是为防「正常关机后用户凌晨手动开机
  又被执行一轮并关机」而接受的保守行为。）
- **窗口内启动会先 `shutdown /a` 清除残留关机计划**（上一轮遗留看门狗/你手动排程的关机都会被
  替换为本脚本的 30 分钟看门狗）——凌晨窗口内机器本就归脚本接管。
- **复用「当日任务已跑完的存活进程」**（force 调试时常见）：完成行在基线之前，信号通道看不到，
  会等满监测超时走错误路径后关机（fail-safe，慢但不失控）。
- **手动 `shutdown /a` 会取消看门狗**。取消后若脚本仍活着，完成时会重新发起关机；
  若脚本已死，关机不再发生——这是 Windows 语义，无法从脚本侧阻止。
- **Ctrl+C 语义**：仅当本实例挂起过关机计划（看门狗或最终关机）才执行 `/a`，
  测试入口/窗口外运行不会碰你自己排程的关机。
- **MaaEnd 启动先检查更新**：断网时实测可阻塞 16.5 分钟才开始任务（网络正常时秒级）。
  端口本身约 1 秒即监听（不受更新检查影响，就绪门不会因此超时）；但这段等待消耗监测预算，
  网络环境差时调大 `monitorTimeoutSec`/`watchdogSec`（预算链会自动重新 clamp）。
- **MAA 异常停止不发完成信号**（游戏掉线/手动停止未勾「手动停止时启用脚本」）→ 监测超时走错误
  路径；**MAA 进程崩溃** → 下一轮监测立即报 `MAA_EXIT`（不等超时），两种都最终关机。
- **MAA 配置注入时机**：仅在 MAA 未运行时写入（备份 `gui.new.json.bak-dailyauto`，原子写入）。
  想彻底移除注入：`config.json → maa.injectPostRunScript = false`。
- **RemoteControl 自定义端口**：MAA 官方唯一双向通道（你本机两个 URI 当前为空）。本方案未使用——
  启动自动开跑由 `RunDirectly`/`autoRunOnLaunch` 解决，完成信号由 PostRunScript + gui.log 解决，
  无需下发指令。若将来需要远程下发 `LinkStart`，协议见 MAA 设置页「远程控制」开发者文档
  （`docs.maa.plus`；配置须在 MAA 启动前写入才生效）。
- **关于「MAA 自定义端口」的查证结论**：源码、二进制字符串（含 UTF-16）、运行日志三重验证，
  官方 MAA v6.19 **不存在**任务状态监听端口（`8768` 系第三方 GUI 传言，其全部 git 历史中仅为
  SVG 坐标）；本机带 web/ws 端口的软件是 MaaEnd 的 12701（本方案已用）。
