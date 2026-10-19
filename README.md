# MaaDuty — 全自动日常（MAA + MaaEnd 无人值守关机）

电脑在你指定的时段自动开机后，**自动跑完《明日方舟》与《终末地》的全部日常，然后自动关机**——全程无人值守，专为「凌晨挂机跑日常」设计。

- MAA 负责《明日方舟》日常，MaaEnd 负责《终末地》日常，本脚本是把它们串起来并负责关机的主控。
- 你只需要：在 BIOS 里定时开机 + 本项目注册一次计划任务。之后每天到点自动执行，跑完即关机。

## 功能特性

- **自定义多时段触发**：开机时间落入任一时段即执行（默认凌晨 03–04 点与 07–08 点），时段可配 1–6 段。
- **严格的窗口判定**：基于本次开机时间三重把关，窗口外运行只会静默退出——白天开机、晚登录、重复登录都不会误跑。
- **关机看门狗兜底**：判定通过后先挂 1 小时兜底关机再启动任何程序，脚本崩溃也不会导致整夜开机。
- **全自动拉起全链路**：MAA → 静置等模拟器窗口稳定 → 终末地（自动绕过 1.6+「须经官方启动器」校验）→ MaaEnd。
- **双通道完成检测**：MAA（回调 flag + 日志尾随）与 MaaEnd（HTTP 状态轮询 + WebSocket 加速）均确认完成后立即关机。
- **每日成功配额**：每个自然日至多成功执行 `window.dailyMaxRuns` 轮（默认 2）。**仅成功计入**——失败/超时不占额度，下次开机落在时段内会自动重试；防止成功后关机再开机被反复执行。
- **出错也关机**：启动失败/进程崩溃/监测超时/任务错误收尾 → 执行错误处理接口（可自定义告警）→ 依旧关机，不存在「出错后整夜裸奔」。
- **配置容错**：`config.json` 缺失、损坏或写错时自动回退默认值并记日志，不会因笔误导致关机命令失败。
- **单实例锁**：防计划任务重复拉起或多开。

## 工作流程

```
计划任务拉起 daily.mjs（登录时 + 15s）
  ├─ 1. 单实例锁（原子创建；陈旧锁含时效与 PID 校验）
  ├─ 2. 时间窗判定（三重门，全部通过才继续）：
  │     ① 本次开机时间 ∈ 任一自定义时段（CIM × 事件 6005 双源交叉校验）
  │     ② 当前时刻 < 命中时段的结束时间 + 宽限（防晚登录/白天重跑）
  │     ③ 今日成功轮数未达 window.dailyMaxRuns（state/ran-日期.json，仅成功计入）
  │     任一不满足 → 记几行日志后静默退出（不启动程序、不设看门狗）
  ├─ 3. 挂看门狗：shutdown /a（清残留）→ shutdown /s /t 3600 /f
  ├─ 4. 向 MAA 配置注入「结束后脚本」回调（仅当该配置为空；自动备份+原子写入）
  ├─ 5. 启动 MAA.exe 并静置 30s（等模拟器窗口稳定，防焦点抢占）
  │     → 经计划任务提权拉起终末地 → 启动 MaaEnd.exe → 等待双方就绪
  ├─ 6. 轮询监测至双方均完成（或出错/超时 → 错误路径）
  └─ 7. 收尾（幂等）
        正常：取消看门狗 → 5 秒后关机
        错误：执行错误处理接口（三层，见下文）→ 同样关机
        兜底：关机命令失败 → 重新挂看门狗 + ERROR 告警
```

## 部署前准备

1. **Windows 10/11 + Node.js ≥ 18（推荐 ≥ 21）**。检查：`node --version`。
   旧版 Node 会导致端口探测恒失败 → 开机即走错误关机，且 `--self-test`/`--dry-run` 测试发现不了此问题。
2. **已安装并配置好 MAA**：模拟器、基建、日常计划等都已调好，能手动一键跑通。
3. **已安装并配置好 MaaEnd**：日常实例已建好，能手动一键跑通。
4. **《终末地》客户端 + 官方启动器（Hypergryph Launcher）**已安装并登录过。
5. **BIOS/UEFI 定时开机**（RTC Alarm）或 Wake-on-LAN：本项目负责「开机之后」的一切，
   不负责让电脑开机本身。BIOS 开机时间必须落入 `window.slots` 的某一时段。
6. **Windows 自动登录**：凌晨无人值守，GUI 程序必须运行在用户会话中。
   `Win+R → netplwiz` → 取消勾选「要使用本计算机，用户必须输入用户名和密码」。

## 快速开始

### 第 1 步：放置项目

把本项目放到任意目录（下文以 `$dir` 指代），例如 `C:\Users\你\MaaDuty`。
目录被移动/改名后无需其他操作，但若曾运行过，请删除 `state\ran-*.json` 以便重新验证。

### 第 2 步：修改 config.json（必做）

打开 `config.json`，**至少核对 `paths` 段指向你本机的实际安装位置**（仓库自带值是示例路径）：

```json
"paths": {
  "maaExe":     "D:\\Program Files\\MAA\\MAA.exe",
  "maaConfig":  "D:\\Program Files\\MAA\\config\\gui.new.json",
  "maaLog":     "D:\\Program Files\\MAA\\debug\\gui.log",
  "maaendExe":  "D:\\Program Files\\MaaEnd\\MaaEnd.exe"
}
```

- `maaConfig` / `maaLog` 与 `maaExe` 同属 MAA 安装目录，跟随你的实际路径改。
- 触发时段在 `window.slots` 里改（须覆盖 BIOS 开机时间），全部配置项见下文[配置详解](#配置详解configjson)。
- 改错了也不怕：非法值启动时自动回退默认并写 WARN 日志。

### 第 3 步：MAA / MaaEnd 侧一次性配置

| 软件 | 需要设置 | 位置 |
|---|---|---|
| MAA | 启动后自动开跑（`RunDirectly = true`） | 设置 → 启动设置 |
| MaaEnd | 启动后自动开跑：`autoRunOnLaunch=true` + `autoStartInstanceId` 指向你的日常实例 | 安装目录 `config\mxu-MaaEnd.json` |

「结束后脚本」回调**无需手动配置**：脚本启动 MAA 前会自动注入（仅当该项为空，
自动备份为 `gui.new.json.bak-dailyauto`）。若想彻底移除注入：`config.json → maa.injectPostRunScript = false`。

### 第 4 步：注册计划任务（管理员 PowerShell）

```powershell
$dir  = "C:\Users\你\MaaDuty"          # ← 改成你实际的项目目录
$node = "C:\Program Files\nodejs\node.exe"  # ← 用 `where.exe node` 核对

# ① 主控任务：登录后 15 秒拉起 daily.mjs
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\daily.mjs`""
# 「登录时」触发 + 15s 延迟等桌面就绪（「启动时」触发跑在会话 0，GUI 程序起不来）
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME" -Delay (New-TimeSpan -Seconds 15)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 75) -StartWhenAvailable -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "MaaDuty" -Action $action -Trigger $trigger -Settings $settings -Force

# ② 游戏启动任务：仅由 daily.mjs 经 schtasks /Run 触发，本身无自动触发器
#    （终末地 1.6+ 校验父进程须为官方 Games.exe，需提权运行 launch-endfield.ps1）
$psAction    = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\launch-endfield.ps1`""
$psPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -RunLevel Highest
Register-ScheduledTask -TaskName "MaaDutyLaunchGame" -Action $psAction -Principal $psPrincipal -Force
```

要点：

- 游戏安装路径与本机不同时，编辑 `launch-endfield.ps1` 顶部的 `$GameDir` / `$LauncherRoot` 默认参数
  （或在计划任务的启动命令后追加 `-GameDir "..." -LauncherRoot "..."`）。
- 游戏任务名必须与 `config.json → game.taskName` 一致（默认 `MaaDutyLaunchGame`）。
- 主控任务**不要**加 `--force` 参数（那是调试开关，会绕过时间窗与当日配额）。
- 若不需要本项目代管游戏启动（例如你的终末地版本无父进程校验），设 `game.enabled=false` 即可跳过第 ② 步。
- 检查任务状态：`Get-ScheduledTask MaaDuty, MaaDutyLaunchGame | Get-ScheduledTaskInfo`。

### 第 5 步：测试验证

分层测试，**前两层不会误关机**：

```powershell
cd $dir

node daily.mjs --self-test       # 1. 逻辑自检（60 例，纯计算，不影响系统）
node daily.mjs --window-test     # 2. 打印本次开机时间、窗口判定（只读；exit 0 = 在窗口内）
node daily.mjs --dry-run --force # 3. 全链路演练：打印将执行的全部动作，不关机/不启动/不注入
```

真机全流程验证（**会真的关机**，请确认可以关机时再做）：

1. 临时改 `config.json`：`"watchdogSec": 3600`、`"monitorTimeoutSec": 2400`
   （监测上限 40 分钟，看门狗 60 分钟硬兜底；预算链 cap=3120，不会触发 clamp WARN）；
2. 临时改 `window.slots` 为单段且覆盖当前小时，如 `[{ "startHour": <当前小时>, "endHour": <当前小时+1> }]`；
3. 运行 `node daily.mjs --force`（**必须带 --force**：绕过时间窗与当日成功配额）；
4. 观察日志（`logs\daily-*.log`）：启动 MAA → 静置 → 拉起终末地 → 启动 MaaEnd → 心跳 → 双完成 → 关机；
5. 测完**立即改回**正式配置，并删除测试产生的 `state\ran-*.json`。

测试相关提示：

- 中途想中止：Ctrl+C——脚本仅在「自己挂起过关机计划」时执行 `shutdown /a`，
  不会取消你自己排程的关机。
- MAA/MaaEnd 已在运行时脚本会**复用**而不重复启动（日志记「复用」）。
- 建议首跑额外验证一次错误收尾：观察 MAA 部分任务失败时日志走 `TASK_ERROR`（错误处理）
  而非 `ALL_DONE`。

全部通过后，恢复正式配置即完成部署——之后每次 BIOS 定时开机都会自动执行并关机。

## 配置详解（config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `window.slots` | `[{3,4},{7,8}]` | **触发时段（数组，1–6 段）**：`[{"startHour":3,"endHour":4},...]`，本次开机时间落入任一段（左闭右开）即触发。`start`∈0–23、`end`∈1–24、`start<end`；`end=24` 表示到次日零点，不支持跨零点段。非法则整组回退默认 |
| `window.nowGraceMin` | 60 | 当前时刻上限 = 命中时段的 `endHour` + 此值（分钟）。开机后登录晚于此上限 → 静默退出（防白天误跑） |
| `window.dailyMaxRuns` | 2 | 每日至多**成功**执行轮数（1–10）。仅成功计入：失败/超时/崩溃不占额度，下次开机落在时段内自动重试；成功次数达上限后同日重跑被静默拦下。非法回退内置值 1 |
| `paths.maaExe` | `D:\Program Files\MAA\MAA.exe` | MAA 主程序路径 |
| `paths.maaConfig` | `D:\Program Files\MAA\config\gui.new.json` | MAA 配置文件（注入「结束后脚本」回调的目标） |
| `paths.maaLog` | `D:\Program Files\MAA\debug\gui.log` | MAA 日志（完成信号的第二通道） |
| `paths.maaendExe` | `D:\Program Files\MaaEnd\MaaEnd.exe` | MaaEnd 主程序路径 |
| `watchdogSec` | 3600 | 兜底关机（秒）。**是兜底不是正常路径**，不能设太短：Windows 关机前约 10 分钟会弹全屏提示，过短的看门狗会在任务仍在跑时弹出抢焦点、干扰 MaaEnd。日常实测总时长接近 1 小时再调大 |
| `monitorTimeoutSec` | 1380 | 监测总时限（秒），超时 → 错误处理后关机。启动时强制满足预算链：`watchdog ≥ ready + gameReady + maaSettle + monitor + 2×onError + 60s`，越界自动 clamp 并 WARN |
| `readyTimeoutSec` | 120 | MAA / MaaEnd 启动就绪上限（秒；MaaEnd 端口探测也在其中） |
| `maaReadyStableSec` | 5 | MAA 进程持续存活多久算启动成功（秒） |
| `maa.settleSec` | 30 | 新启动 MAA 后的静置秒数：MAA 会拉起模拟器，其窗口弹出抢焦点会干扰随后启动的 MaaEnd，故先等窗口稳定（0=禁用；复用已在运行的 MAA 时跳过） |
| `maa.injectPostRunScript` | true | 自动注入 MAA「结束后脚本」回调。要彻底移除注入改 `false`（仅删配置里的值会被下次运行重新注入） |
| `maend.portScan` | `[12701..12710]` | MaaEnd web 端口探测范围（默认端口被占时自动回退试下一个） |
| `maend.wsEnabled` | true | WebSocket `tasks-completed` 事件加速完成检测（Node ≥ 21 时生效，缺失自动降级纯轮询） |
| `game.enabled` | true | 是否由本脚本拉起终末地（经提权计划任务，绕过 1.6+ 父进程校验）。设 `false` 则跳过，游戏需自行保证在运行 |
| `game.taskName` | `MaaDutyLaunchGame` | 拉起游戏用的计划任务名（须与第 4 步注册的任务名一致） |
| `game.readyTimeoutSec` | 180 | 触发后等待游戏窗口就绪上限（秒，含提权编译与游戏启动耗时） |
| `shutdownGraceSec` | 5 | 关机前宽限秒数（给日志 flush；>0 时 shutdown 自动隐含 `/f`） |
| `pollIntervalMs` | 2000 | 完成信号轮询间隔（毫秒） |
| `heartbeatLogSec` | 60 | 监测心跳日志间隔（秒） |
| `onError.command` / `args` | 空 | 出错时执行的外部命令及其参数（如 `powershell` + `["-File", "C:\\...\\alert.ps1"]`） |
| `onError.timeoutSec` | 30 | 错误处理单次执行上限（秒；预算链内占 2 份） |

所有数值字段启动时校验：非法类型/越界 → 回退默认值并 WARN。

## 命令行参数

```powershell
node daily.mjs                 # 正常运行（由计划任务调用，日常无需手动执行）
node daily.mjs --help          # 显示帮助
node daily.mjs --self-test     # 逻辑自检（60 例，不影响系统）
node daily.mjs --window-test [ISO时间]  # 只读打印开机时间与窗口判定（exit 0 = 在窗口内）
node daily.mjs --dry-run --force  # 全链路演练：只打印将执行的动作，不真执行
node daily.mjs --force         # 调试：跳过时间窗与当日配额（⚠ 会真的启动程序并关机）
node daily.mjs --maa-done      # MAA「结束后脚本」回调入口（内部使用）
```

## 错误处理接口

进入错误路径的条件：看门狗挂载失败、exe 不存在、游戏拉起失败（计划任务未注册 / 就绪超时 /
停在启动校验弹窗）、进程启动后立即退出、MaaEnd 端口超时、任一进程意外退出、监测超时、
任务错误收尾（MAA「以下任务出现错误」/ MaaEnd `overall_status=Failed`）。

出错后依次执行三层处理，**全部结束后无论结果如何都关机**：

1. **默认**：写 `logs\` 下的 ERROR 日志；
2. **自定义模块**：复制 `errorHandler.example.mjs` 为 `errorHandler.mjs`，实现
   `export async function handle(err, ctx)`（`ctx = { stage, config, log, startedAt }`）。
   可在此写告警推送（Server酱/Bark/Webhook 等）。超过 `onError.timeoutSec` 未返回视为超时，不阻塞关机；
3. **外部命令**：`config.json → onError.command` 非空则以子进程执行（超时上限 `onError.timeoutSec`，默认 30s）。

**关机授权状态机**：只有时间窗判定通过后发生的异常才会进入「错误处理 → 关机」。
初始化阶段（单实例锁、时间窗判定）与 `--maa-done` 回调入口的异常只记日志退出，**绝不关机**。

## 文件说明

| 文件 | 作用 |
|---|---|
| `daily.mjs` | 主控脚本（唯一需要被计划任务调用的入口） |
| `config.json` | 全部可调参数（缺失/损坏/非法时自动回退或修正默认值并记日志） |
| `VERSION` | 当前版本号（纯文本，随发布更新） |
| `launch-endfield.ps1` | 终末地 1.6+ 提权启动脚本（挂起创建官方 Games.exe 作父进程再拉起游戏） |
| `errorHandler.example.mjs` | 错误处理接口示例，复制为 `errorHandler.mjs` 后生效 |
| `logs\daily-YYYY-MM-DD.log` | 运行日志（UTF-8，按天切分，自动创建）——**排障第一依据** |
| `state\lock.json` | 单实例锁（含时效校验，防重复运行） |
| `state\ran-YYYY-MM-DD.json` | 当日运行记录（成功/失败/挂起各轮；成功次数达 `window.dailyMaxRuns` 后拦截） |
| `state\maa_done.flag` | MAA 完成回调标志（由「结束后脚本」写入） |

## 运行须知与已知边界

- **每个自然日至多成功执行两轮**：成功次数达到 `window.dailyMaxRuns`（默认 2）后，同日再登录、再手动运行都会被静默拦下。
  **失败/超时不计入配额**——下次开机落在时段内会自动重试（例如凌晨失败，早上 07–08 点窗口内重开机会自动再跑一轮）。
  需要强制重跑：`node daily.mjs --force` 或删 `state\ran-*.json`。
- **窗口内启动会先 `shutdown /a` 清除残留关机计划**——凌晨窗口内机器本就归脚本接管。
- **手动 `shutdown /a` 会取消看门狗**。取消后若脚本仍活着，完成时会重新发起关机；
  若脚本已死，关机不再发生——这是 Windows 语义，无法从脚本侧阻止。
- **MaaEnd 启动器（stub）交接**：日志出现「MaaEnd 启动器进程已退出……真实应用仍在运行——
  转为周期探活」属正常现象（MaaEnd 本体以新进程接管）。
- **MAA 被中止**（游戏掉线/手动停止）→ gui.log 中止收尾会被识别为失败（「游戏掉线，停止任务」/
  「已停止」），待 MaaEnd 结束后按 `TASK_ERROR` 错误收尾关机；MaaEnd 迟迟无信号则由监测超时兜底。
  **MAA 进程崩溃** → 下一轮监测立即报错。两种最终都会关机。
- **断网时 MaaEnd 启动先检查更新**，实测可阻塞 16.5 分钟才开始任务。网络环境差时
  调大 `monitorTimeoutSec` / `watchdogSec`（预算链会自动重新 clamp）。
- **复用「当日任务已跑完的存活进程」**（`--force` 调试时常见）：完成信号在基线之前，
  会等满监测超时走错误路径后关机（fail-safe，慢但不失控）。
- **排障从日志开始**：`logs\daily-*.log` 覆盖时间判定、看门狗、注入、启动/复用、
  每条完成信号、心跳、错误、关机命令退出码。
- 完成信号不依赖 MAA 的任何网络端口：官方 MAA v6.19 不存在任务状态监听端口，
  本方案由「结束后脚本」回调 + gui.log 尾随双通道解决。

## 许可证

本项目采用 [MIT 许可证](LICENSE) 开源，版权所有 © 2026 明月清风酱。
`launch-endfield.ps1` 中的父进程创建技术移植自 Xel-Launcher 的 `ParentProcessLauncher.cs`（Apache-2.0）。
