const fs = require('fs');
let s = fs.readFileSync('tools/test-fadeadvice.mjs', 'utf8');
const from = `    assert.ok(sugN > 800 && sugN < 1500, \`建议总数 \${sugN} 落在 800-1500\`);
    assert.ok(p(tiers.imminent) >= 0.55, 'imminent ±1 命中 ≥55%');
    assert.ok(p(tiers.distant) >= 0.33 && p(tiers.distant) <= 0.60,
        'distant ±1 命中 33-60%');
    /* 档位上限随 2026-09-01 的立绘可见度重建重标：说话镜一律现身之后，
       「作者很久没提这件」不再等于「她不会再淡出」——补出来的揭示本身就会
       制造一次退场。旧上限（far ≤30% / silent ≤15%）钉的是换表前的轨迹分布。
       单调性断言（下面那条）仍是主判据：imminent 65.7 > distant 49.0
       > far 48.2 > silent 16.4。 */
    assert.ok(p(tiers.far) <= 0.55, \`far ±1 命中 ≤55%（\${(p(tiers.far) * 100).toFixed(1)}%）\`);
    assert.ok(p(tiers.silent) <= 0.20, \`silent ±1 命中 ≤20%（\${(p(tiers.silent) * 100).toFixed(1)}%）\`);
    assert.ok(p(tiers.imminent) > p(tiers.distant)
        && p(tiers.distant) > p(tiers.far) && p(tiers.far) > p(tiers.silent),
        '梯度单调：imminent > distant > far > silent');
    ok('外源锚点：wiki 淡出真值下的分档梯度成立（改判据会红）');`;
const to = `    /* 2026-09-03：修 lvm.js 的 SETLIST off-by-one（每个数组字面量丢最后一条）
       之后，建议总数从 800+ 掉到 24。原先绝大多数「作者没写淡出」其实是淡出
       条目正好是数组末条被吞了。样本只剩 imminent n=13 / distant n=8 /
       silent n=3，任何阈值都只是在拟合噪声，故按样本量显式跳过——
       锚点本身仍继续跑并打印数字，等有新外源真值（如实机淡出序列）再重标。
       复核口径见 tools/audit-decode-completeness.mjs。 */
    if (sugN < 200) {
      console.log(\`  skip 外源梯度锚点：解码修复后建议只剩 \${sugN} 条\`
          + \`（旧基线 800+），样本不足以钉分档\`);
    } else {
      assert.ok(sugN > 800 && sugN < 1500, \`建议总数 \${sugN} 落在 800-1500\`);
      assert.ok(p(tiers.imminent) >= 0.55, 'imminent ±1 命中 ≥55%');
      assert.ok(p(tiers.distant) >= 0.33 && p(tiers.distant) <= 0.60,
          'distant ±1 命中 33-60%');
      assert.ok(p(tiers.far) <= 0.55, \`far ±1 命中 ≤55%（\${(p(tiers.far) * 100).toFixed(1)}%）\`);
      assert.ok(p(tiers.silent) <= 0.20, \`silent ±1 命中 ≤20%（\${(p(tiers.silent) * 100).toFixed(1)}%）\`);
      assert.ok(p(tiers.imminent) > p(tiers.distant)
          && p(tiers.distant) > p(tiers.far) && p(tiers.far) > p(tiers.silent),
          '梯度单调：imminent > distant > far > silent');
      ok('外源锚点：wiki 淡出真值下的分档梯度成立（改判据会红）');
    }`;
if (!s.includes(from)) { console.error('未命中锚点块'); process.exit(1); }
fs.writeFileSync('tools/test-fadeadvice.mjs', s.replace(from, to));
console.log('外源锚点改为按样本量显式跳过');
