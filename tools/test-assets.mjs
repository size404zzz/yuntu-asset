/**
 * M8 素材库浏览器回归跑者：serve.py 宿主 + 无头 Chrome 打开
 * selftest-assets.html（IndexedDB 往返 / 上传覆盖 / 标定持久化 / R13），
 * 随后同一宿主上跑编辑器冒烟（index.html?smoke=1）。
 * 用法：node tools/test-assets.mjs [--port=0] [--timeout=300]
 */
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {browserTest, findChrome, freshProfile, launchPage, waitForReport,
  ROOT} from './lib/run.mjs';

const SMOKE = join(ROOT, 'data', 'fixtures', 'expected-editor_smoke.json');

const {code} = await browserTest({
  label: 'M8 素材库',
  scene: 'assets_report',
  page: 'selftest-assets.html',
  probe: 'data/index/backgrounds.json',
  timeout: Number(process.env.ASSETS_TIMEOUT ?? 300),
  statsOf: (report) => [`断言 ${report.asserts}`],
  /* 编辑器冒烟：boot（含 IDB 注册表）+ 首帧 seek + 顶栏状态行。
     宿主必须还活着——这一段曾在 finally 之后跑，POST 进了死端口。 */
  after: async (report, host) => {
    if (existsSync(SMOKE)) rmSync(SMOKE);
    const chrome2 = launchPage({
      chrome: findChrome(), port: host.port,
      page: 'index.html?smoke=1', profile: freshProfile('editor-smoke'),
      windowSize: '1400,1400',
      extraFlags: ['--hide-scrollbars', '--mute-audio'],
    });
    let smoke = null;
    try {
      smoke = await waitForReport({out: SMOKE, timeoutS: 60, chrome: chrome2,
        step: '编辑器冒烟'});
    } catch (e) {
      report.ok = false;
      (report.failures ??= []).push('编辑器冒烟：' + (e.message ?? e));
      return;
    }
    const bad = [];
    /* 默认页 = 序章 cpt00_e_01_01（游戏本体语料），wiki 夹具 scene1 已退役。 */
    if (smoke.story !== 'cpt00_e_01_01') bad.push(`默认剧本=${smoke.story}`);
    if (!smoke.pos.startsWith('#1')) bad.push(`tp-pos=${smoke.pos}`);
    if (!smoke.storage.includes('731')) bad.push(`storage=${smoke.storage}`);
    if (smoke.shots !== 48) bad.push(`shots=${smoke.shots}`);
    if (smoke.storylib?.error) bad.push(`剧本库装载：${smoke.storylib.error}`);
    if (smoke.storylib?.id !== 'cpt00_e_01_01') {
      bad.push(`storylib.id=${smoke.storylib?.id ?? '缺席'}`);
    }
    if (smoke.storylib?.shots !== 48) bad.push(`storylib.shots=${smoke.storylib?.shots}`);
    if (!smoke.storylib?.brief?.startsWith('“绿洲”扇区')) {
      bad.push(`storylib.brief=${smoke.storylib?.brief}`);
    }
    if (smoke.storylib?.logCloses !== true) {
      bad.push(`storylib.logCloses=${smoke.storylib?.logCloses}`);
    }
    /* M23 退场建议：按钮接线 + 面板可开（行数随映射结果浮动，不硬断）。 */
    if (smoke.fadeAdvice?.error) bad.push(`退场建议：${smoke.fadeAdvice.error}`);
    if (!smoke.fadeAdvice?.opened) bad.push('退场建议面板没开');
    /* 录制面板：模态能开 + 设置行在（无头环境不真采集）。 */
    if (smoke.recorder?.error) bad.push(`录制面板：${smoke.recorder.error}`);
    if (!smoke.recorder?.opened) bad.push('录制面板没开');
    if ((smoke.recorder?.rows ?? 0) < 6) bad.push(`录制设置行=${smoke.recorder?.rows}`);
    if (!smoke.recorder?.cap) bad.push('录制能力探测行缺席');
    if (bad.length) {
      report.ok = false;
      (report.failures ??= []).push('编辑器冒烟：' + bad.join(' | '));
    } else {
      console.log(`  编辑器冒烟：${smoke.storage} · 剧本库 ${smoke.storylib.id}`
          + ` ${smoke.storylib.shots} 镜 · log 收起 · 退场建议面板 ✓`
          + ` · 录制面板 ✓`);
    }
  },
});
process.exit(code);
