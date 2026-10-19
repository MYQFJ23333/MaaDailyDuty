/**
 * errorHandler.example.mjs — 错误处理接口示例
 *
 * 生效方式：复制本文件为同目录下的 errorHandler.mjs 并按需修改。
 *   cp errorHandler.example.mjs errorHandler.mjs
 *
 * 当 daily.mjs 走错误路径（启动失败/端口超时/进程意外退出/监测超时/任务错误收尾等）时：
 *   1. 先写 ERROR 日志（内置）
 *   2. 再调用本模块导出的 handle(err, ctx) —— 超过 onError.timeoutSec 未返回则视为超时，不阻塞关机
 *   3. 最后执行 config.json 里 onError.command 指定的外部命令（若非空）
 *   以上全部结束后，无论结果如何都会执行关机收尾。
 *
 * 这里就是「预留的错误处理接口」——告警、清场、状态回写等逻辑写在 handle 里即可。
 *
 * @param {Error} err   触发错误路径的原因
 * @param {object} ctx  { stage: 错误阶段, config: 合并后的配置, log: 写日志函数, startedAt: 启动时间戳 }
 */
export async function handle(err, ctx) {
  ctx.log('ERROR', 'onError-handler', `[自定义错误处理] stage=${ctx.stage} message=${err?.message}`)

  // 示例 1：Windows 弹窗通知（会阻塞，注意控制时长，仅作演示）
  // spawnSync('msg', ['*', '/TIME:10', `MaaDuty 出错：${err?.message}`], { windowsHide: true })

  // 示例 2：写一份错误快照供事后分析
  // import fs from 'node:fs'
  // fs.appendFileSync('error-history.log', `${new Date().toISOString()} ${ctx.stage} ${err?.message}\n`)

  // 示例 3：调用 Server酱/Bark/Webhook 等推送告警（自行实现）
  // await fetch('https://...', { method: 'POST', body: JSON.stringify({ err: err?.message, stage: ctx.stage }) })

  await new Promise(r => setTimeout(r, 100)) // 演示：真实逻辑直接写在这里
}
