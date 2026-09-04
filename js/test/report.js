/* report.js —— 自检页共用的报告通道（跑者侧对应 tools/lib/run.mjs）。
 *
 * 页面在长链路里用 step() 上报「卡点」：跑者轮询同一份冻结文件时读到
 * {done:false, step}，超时诊断就能打印「卡在哪一步」而不是哑超时；
 * 结束时 final() 发整份报告（done:true，跑者以此判定完成）。
 * POST 串行化：ThreadingHTTPServer 并发写同一文件不保证到达序，
 * 链式追加保证磁盘上看到的心跳单调推进。 */
export function reporter(scene) {
  const post = (body) => fetch(`/freeze?scene=${scene}`, {
    method: 'POST', body: JSON.stringify(body),
  }).catch(() => {});
  let chain = Promise.resolve();
  const send = (body) => { chain = chain.then(() => post(body)); return chain; };
  return {
    step: (step) => send({done: false, step}),
    final: (report) => send({...report, done: true}),
  };
}
