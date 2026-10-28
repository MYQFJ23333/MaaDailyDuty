# MaaDailyDuty — 每日日常全自动，跑完自动关机

**电脑在你设定的时间自动开机后，自动跑完《明日方舟》和《终末地》的日常，然后自动关机**——全程不用管，适合凌晨挂机跑日常。

- [MAA](https://github.com/MaaAssistantArknights/MaaAssistantArknights) 负责《明日方舟》，[MaaEnd](https://github.com/MaaEnd/MaaEnd) 负责《终末地》；本项目把它们串起来，并负责「跑完关机、出错也关机」。
- 你只需要做两件事：**BIOS 里设好定时开机（或者使用其他方式）** + **按本文步骤设置一次**。之后每天到点自动执行。

## 它能做什么

- **到点自动开跑**：开机时间落在你设的时段内才执行（默认凌晨 3–4 点、7–8 点）。白天开机、重复登录都不会误跑。
- **跑完自动关机**：两边日常都确认完成后立刻关机。
- **出错也关机**：程序没起来、中途崩了、超时了……都会记日志后照样关机，不会让电脑整夜开着。
- **兜底保险**：一旦确认要开始跑，就先挂一个「到时强制关机」（出厂 90 分钟）。就算脚本自己崩了，电脑也跑不掉。
- **每天有上限**：每个自然日最多成功跑 2 轮（可改）。失败不占次数，下次开机落在时段内会自动重试；成功够次数后同一天再开也不会重复跑。
- **跑完顺手关模拟器**：《明日方舟》跑完后自动关掉 MuMu 释放内存，不影响《终末地》（它是电脑版游戏）。
- **配置写错不怕**：`config.json` 缺了、坏了、填错了，都会自动用安全默认值并写日志，不会导致该关机时不关机。

## 大致流程

```
你：BIOS 定时开机 → Windows 自动登录
        ↓
计划任务在登录后 15 秒启动本项目
        ↓
检查：是设定的开机时段吗？今天还没跑够次数吗？
  ├─ 不满足 → 静默退出（什么都不启动）
  └─ 满足   → 挂上「90 分钟后强制关机」的保险
                ↓
        启动 MAA（明日方舟）→ 等模拟器窗口稳定 → 启动 MaaEnd（终末地）
                ↓
        盯着两边进度，都完成后 → 关机
        （中途出错 / 超时 → 记日志 → 照样关机）
```

## 开始之前需要准备

1. **Windows 10/11 + [Node.js](https://nodejs.org/) 18 以上**（推荐 21 以上，「任务完成即时通知」需要）。
   安装后打开 PowerShell 输入 `node --version` 确认能看到版本号。
2. **MAA 已安装并调好**：模拟器、基建、日常计划都能手动一键跑通。
3. **MaaEnd 已安装并调好**：日常实例已建好，能手动一键跑通。
4. **《终末地》客户端 + 官方启动器**已安装并登录过。
5. **BIOS/UEFI 定时开机**（RTC Alarm）或网络唤醒：本项目只管「开机之后」的事，不管怎么开机。
   BIOS 开机时间必须落在 `window.slots` 的某个时段里。
6. **Windows 允许自动登录**：凌晨没人输密码，桌面程序必须能自己进系统。
   按 `Win+R` 输入 `netplwiz` → 取消勾选「要使用本计算机，用户必须输入用户名和密码」→ 确定并输入一次密码。

## 设置步骤

### 第 1 步：放置项目

把本项目解压/克隆到任意目录（下文用 `$dir` 指代），例如 `C:\Users\你\MaaDailyDuty`。
目录以后移动、改名都行；但若已经跑过，请先删掉 `state\` 下的 `ran-*.json` 再重新验证。

### 第 2 步：修改 config.json（必做）

用记事本打开 `config.json`，**至少核对 `paths` 是不是你电脑上的真实安装位置**（仓库里的是示例路径）：

```json
"paths": {
  "maaDir":    "D:\\Program Files\\MAA",
  "maaendDir": "D:\\Program Files\\MaaEnd",
  "muMuDir":   "D:\\Program Files\\YXArkNights-12.0"
}
```

- 只要填 3 个**安装目录**：MAA、MaaEnd、MuMu 模拟器。具体 exe、配置、日志在哪里，程序会自己找。
- 开机时段在 `window.slots` 里改（必须覆盖你的 BIOS 开机时间），见下方[配置说明](#配置说明configjson)。
- 填错了也没关系：非法值启动时自动改回默认并写警告日志。

### 第 3 步：MAA / MaaEnd 各设置一次

| 软件 | 要打开的开关 | 在哪里 |
|---|---|---|
| MAA | 启动后自动开跑（`RunDirectly = true`） | 设置 → 启动设置 |
| MaaEnd | 启动后自动开跑：`autoRunOnLaunch=true`，并用 `autoStartInstanceId` 指向你的日常实例 | 安装目录里的 `config\mxu-MaaEnd.json` |

MAA 的「结束后脚本」**不用你手动配**：本项目启动 MAA 前会自动填上（原来为空才会填，并自动备份）。
若想关掉这个行为：`config.json → maa.injectPostRunScript = false`。

### 第 4 步：注册计划任务（管理员 PowerShell）

右键开始菜单 →「终端(管理员)」，粘贴整段并回车：

```powershell
$dir  = "C:\Users\你\MaaDailyDuty"          # ← 改成你实际的项目目录
$node = "C:\Program Files\nodejs\node.exe"   # ← 不确定就先跑 where.exe node 核对

$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\daily.mjs`""
# 「登录时」触发并延迟 15 秒，等桌面就绪（用「启动时」会跑在后台会话，界面程序起不来）
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERNAME" -Delay (New-TimeSpan -Seconds 15)
# 上限 100 分钟：要比出厂看门狗 90 分钟更长，避免任务先把脚本杀掉
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 100) -StartWhenAvailable -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "MaaDailyDuty" -Action $action -Trigger $trigger -Settings $settings -Force
```

注意：

- 主控任务**不要**加 `--force`（那是调试开关，会跳过时段检查和每日次数限制）。
- 以后想看任务状态：`Get-ScheduledTask MaaDailyDuty | Get-ScheduledTaskInfo`。

### 第 5 步：测试

分三步测，**前两步不会关机、不会启动任何游戏**：

```powershell
cd $dir

node daily.mjs --self-test        # 1. 逻辑自检（66 项，纯计算，完全无副作用）
node daily.mjs --window-test      # 2. 打印本次开机时间、判断在不在时段内（只读；退出码 0 = 在时段内）
node daily.mjs --dry-run --force  # 3. 全流程演练：只打印「接下来会做什么」，不启动、不关机
```

三项都正常后，可以做一次**真机全流程**（⚠ **会真的启动游戏并关机**，请确认现在关机没关系再做）：

1. 临时改 `config.json`：`"watchdogSec": 3600`、`"monitorTimeoutSec": 2400`（缩短等待，方便快测）；
2. 临时改 `window.slots` 为单段且覆盖当前小时，例如 `[{ "startHour": <当前小时>, "endHour": <当前小时+1> }]`；
3. 运行 `node daily.mjs --force`（**必须带 `--force`**，否则不在时段内会直接退出）；
4. 看日志 `logs\daily-日期.log`：应依次出现 启动 MAA → 静置 → 启动 MaaEnd → 心跳 → 双方完成 → 关机；
5. 测完**立刻改回**正式配置，并删掉测试产生的 `state\ran-*.json`。

其他提示：

- 中途反悔：按 Ctrl+C。脚本只会取消自己挂的关机计划，不会动你手动排的关机。
- MAA / MaaEnd 本来就在跑的话，脚本会**接着用**，不会重复启动（日志里写「复用」）。
- 建议再故意让 MAA 失败一次，确认日志走的是错误收尾（`TASK_ERROR`）而不是正常完成（`ALL_DONE`）。

全部通过后保持正式配置即可——以后每次 BIOS 定时开机都会自动跑完并关机。

## 配置说明（config.json）

### 你可能想改的

| 配置项 | 出厂值 | 说明 |
|---|---|---|
| `paths.maaDir` | `D:\Program Files\MAA` | MAA 安装目录 |
| `paths.maaendDir` | `D:\Program Files\MaaEnd` | MaaEnd 安装目录 |
| `paths.muMuDir` | `D:\Program Files\YXArkNights-12.0` | MuMu 模拟器安装目录 |
| `window.slots` | 凌晨 3–4 点、7–8 点 | **开机时段**，1–6 段：`[{"startHour":3,"endHour":4}, ...]`。开机时间落在任一段内才执行；`endHour` 可填到 24（表示到次日 0 点），但一段不能跨零点。填错整组退回默认 |
| `window.dailyMaxRuns` | 2 | 每天最多**成功**跑几轮（1–10）。失败不占次数；达到上限后同一天再开不会重复跑。程序内置默认是 1，出厂 `config.json` 为 2 |
| `window.nowGraceMin` | 60 | 登录宽限：从时段结束算起，再多等这么多分钟。超过就视为「晚登录/白天误开」，直接退出 |

### 高级选项（出厂已调好，一般不用动）

| 配置项 | 出厂值 | 说明 |
|---|---|---|
| `watchdogSec` | 5400 | 兜底强制关机（秒）。**是保险不是正常路径**：Windows 关机前约 10 分钟会弹全屏提示，设太短会在任务还在跑时弹出来抢焦点。日常总时长接近 90 分钟再考虑调大 |
| `monitorTimeoutSec` | 5278 | 最多盯多久（秒），超时 → 记日志后关机。会自动限制在看门狗预算内，不用手动算 |
| `readyTimeoutSec` | 30 | 等 MAA / MaaEnd 启动成功的上限（秒） |
| `maaReadyStableSec` | 5 | MAA 进程活着多久算启动成功（秒） |
| `maa.settleSec` | 30 | 新启动 MAA 后先等一会儿再启动 MaaEnd（MAA 会拉起模拟器，窗口乱跳会抢焦点）。0 = 关闭；复用已在跑的 MAA 时跳过 |
| `maa.injectPostRunScript` | true | 自动给 MAA 填「结束后脚本」。想彻底不注入就改 `false`（只删配置里的值的话，下次运行又会填上） |
| `emulator.closeWhenMaaDone` | true | 《明日方舟》跑完后立刻关 MuMu 释放内存（失败只记警告，不影响流程） |
| `emulator.vmIndex` | 0 | MuMu 多开编号（0–99） |
| `maaend.portScan` | 12701–12710 | MaaEnd 网页端口探测范围（默认端口被占会自动试下一个） |
| `maaend.wsEnabled` | true | 用 WebSocket 监听「任务完成」，关机更及时（Node ≥ 21 时生效，否则自动改为普通轮询） |
| `shutdownGraceSec` | 5 | 关机前再等几秒（让日志写完） |
| `pollIntervalMs` | 2000 | 检查完成信号的间隔（毫秒） |
| `heartbeatLogSec` | 60 | 日志里多久记一次「还在跑」（秒） |
| `onError.command` / `args` | 空 | 出错时额外执行的命令（比如弹通知脚本），见下文 |
| `onError.timeoutSec` | 1 | 上面这条命令最多允许跑多久（秒） |

所有数值填错（类型不对、超范围）都会在启动时自动改回默认并写警告，不会把流程带崩。

## 出错了会怎样

以下情况会进入错误处理：保险挂失败、exe 不存在、进程起来又立刻退出、MaaEnd 端口一直连不上、进程中途崩溃、盯超时、任务以错误收尾（MAA 报「以下任务出现错误」或 MaaEnd 报失败）。

出错后依次做三件事，**做完无论结果都关机**：

1. 在 `logs\` 里写一条 ERROR 日志（默认就有）；
2. 若存在 `errorHandler.mjs`：调用它的 `handle(err, ctx)`——可在此发 Server酱 / Bark / Webhook 等通知（复制 `errorHandler.example.mjs` 为 `errorHandler.mjs` 即启用）。超过 `onError.timeoutSec` 没返回就跳过，不耽误关机；
3. 若 `config.json → onError.command` 非空：执行该命令（同样有超时）。

**什么时候绝不会关机**：还没通过时段检查就出的错（比如白天误触发、锁冲突），只写日志退出，绝不执行关机。

## 文件都是干什么的

| 文件 / 目录 | 作用 |
|---|---|
| `daily.mjs` | 主程序，计划任务调用的就是它 |
| `config.json` | 全部配置（写错会自动纠正并记日志） |
| `VERSION` | 版本号 |
| `errorHandler.example.mjs` | 出错通知的示例；复制为 `errorHandler.mjs` 后生效 |
| `logs\daily-日期.log` | 运行日志，**排障先看这里** |
| `state\lock.json` | 防止重复运行的锁 |
| `state\ran-日期.json` | 当天跑了几轮（成功才计数） |
| `state\maa_done.flag` | MAA 跑完的内部信号文件 |

## 常见问题与注意事项

- **每天到底能跑几次？** 出厂配置是最多成功 2 次。失败、超时不占次数，下次开机落在时段内会自动重试。想强制重跑：删 `state\ran-*.json`，或手动执行 `node daily.mjs --force`（会真的关机）。
- **白天开机会怎样？** 什么都不发生，日志里记一行就退出——这是故意的。
- **我手动取消过关机（`shutdown /a`）会怎样？** 脚本还活着的话，跑完会重新发起关机；脚本已经退出的话就不会关了。这是 Windows 的行为，拦不住。
- **日志里出现「MaaEnd 启动器进程已退出……转为周期探活」？** 正常现象，MaaEnd 本体会换成新进程继续跑。
- **《明日方舟》中途掉线 / 被手动停止？** 会被识别为失败，等《终末地》结束后按错误流程关机；如果 MaaEnd 也没信号，最多盯到超时照样关机。
- **断网时 MaaEnd 可能先检查更新**，实测最多能卡十几分钟才开始干活。网络差就把 `monitorTimeoutSec`、`watchdogSec` 调大（程序会自动保持两者匹配）。
- **复用了「今天已经跑完」的旧进程？** 完成信号对不上时会等到超时再按错误流程关机——慢，但不会失控。
- **出问题先看** `logs\daily-日期.log`：时段判断、保险、启动、每条完成信号、心跳、错误、关机命令结果都在里面。

## 命令行参数（一般用不到）

```powershell
node daily.mjs                    # 正常运行（计划任务调用的就是这个，平时不用手动跑）
node daily.mjs --help             # 显示帮助
node daily.mjs --self-test        # 逻辑自检（66 项，无副作用）
node daily.mjs --window-test      # 只读打印开机时间与时段判断
node daily.mjs --dry-run --force  # 全流程演练：只打印将执行的动作
node daily.mjs --force            # 调试：跳过时段与每日次数（⚠ 会真的启动并关机）
node daily.mjs --maa-done         # MAA「结束后脚本」回调入口（内部使用）
```

## 许可证

本项目采用 [MIT 许可证](LICENSE) 
