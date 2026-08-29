/* markup.js —— 把 wire 文案翻译成可打字的 HTML。
   `reformat` 是参考 AvgPlayer.js:28-68 的逐行移植（P 档保真，别"顺手修"）：
   - 几条替换正则按**顺序**跑，且都是「贪婪 .* 吃到最后一个 `</`」的写法，
     会把同一行里多个 `<color>` 折叠进一个 span —— 这是参考既有行为，保留；
   - 只有 B/BR/SPAN 三种顶层标签能活下来，其它节点整段丢弃；
   - depth==2 时 `node.textContent = node.innerHTML`，把第三层的标记转成字面量；
   - 结尾 `&gt;` 还原成 `>`，打字机靠裸 `<`/`>` 判定标签边界。
   打字节奏与可见帧由 `hops()` 纯函数预测（与参考 readLine 的控制流逐位等价），
   供测试断言「任何一帧都不出现未闭合标签」。 */

import {splitPages} from './schema.js';

export const VALID_TAG_NAMES = ['B', 'BR', 'SPAN'];
export const DEFAULT_VARS = {name: '教授', gender: 'TA'};

export function reformat(ml, vars = DEFAULT_VARS, depth = 0) {
  const html = depth > 0 ? ml : (ml
      .replaceAll('<cmdr>', vars.name)
      .replaceAll('<TA>', vars.gender)
      .replace(/(color)=(#?\w+)(.*)(?=<\/)/gi, 'span style="$1:$2"$3')
      .replace(/size=(\d+)(.*)(?=<\/)/gi, 'span style="font-size:calc(($1/44)*1em)"$2')
      .replace(/a href=Des:(\d+)(.*)(?=<\/)/gi, 'span data-ref="$1"$2')
      .replace(/<\/[^b]\w*>/g, '</span>')
      .replaceAll('\n', '<br>')
      );
  const div = document.createElement('div');
  div.innerHTML = html;
  const nodes = [...div.childNodes];
  for (const node of nodes) {
    if (node.nodeType != 3 &&
        !(node.nodeType == 1 && VALID_TAG_NAMES.includes(node.tagName))) {
      div.removeChild(node);
    } else if (node.nodeType == 1) {
      if (depth == 2) {
        node.textContent = node.innerHTML;
        continue;
      }
      const attrs = [...node.attributes].map((a) => a.name);
      for (const name of attrs) {
        if (!['style', 'data-ref'].includes(name)) node.removeAttribute(name);
      }
      const childTypes = [...node.childNodes].map((c) => c.nodeType);
      if (!node.childNodes.length || childTypes.every((t) => t == 3)) {
        continue;
      }
      node.innerHTML = reformat(node.innerHTML, vars, depth + 1);
    }
  }
  return div.innerHTML.replaceAll('&gt;', '>');
}

/* wire 的 content 可能是「`<|>` 分隔的字符串」或「已分页数组」，统一成
   每页都过一遍 reformat 的字符串数组 —— 与参考 setScene 的 split('<|>').map(reformat) 一致。 */
export function formatPages(content, vars = DEFAULT_VARS) {
  return splitPages(content).map((page) => reformat(page, vars));
}

/* 参考打字机的可见帧序列（纯预测，不落 DOM）：
   readLine 每吃掉一个字符写一次 innerHTML，但只有「吃完后不在标签里」的那一步
   才会 setTimeout（= 一次可见停顿）；标签内部字符是同一任务里递归吃完的，
   永远到不了绘制。所以可见帧 = 每个 `>`（开标签收尾）与每个普通字符各一帧，
   末字符直接进收尾、不占帧。任何一帧都必然以「完整标签 + 前缀文本」结尾。 */
export function hops(whole) {
  const frames = [];
  let atTag = false;
  for (let k = 1; k < whole.length; k++) {
    const ch = whole[k - 1];
    if (ch === '<') atTag = true;
    else if (ch === '>') atTag = false;
    if (!atTag) frames.push(whole.slice(0, k));
  }
  return frames;
}

/* 一帧是否「裸露标签」：`<` 与 `>` 数目不等 —— 出现了未闭合的标记。
   （「帧文本是全文前缀」是另一条只适用于普通打字模式的单调性判据，见 isTextPrefix。） */
export function hasBareTag(frame) {
  const opens = (frame.match(/</g) || []).length;
  const closes = (frame.match(/>/g) || []).length;
  return opens !== closes;
}

/* 普通打字模式下，每一帧的可见文本都必须是全文可见文本的前缀（逐字增长、不回退）。 */
export function isTextPrefix(frame, whole) {
  return textOf(whole).startsWith(textOf(frame));
}

const PLAINER = typeof document !== 'undefined' ? document.createElement('div') : null;
export function textOf(html) {
  if (!PLAINER) return String(html).replace(/<[^>]*>/g, '');
  PLAINER.innerHTML = html;
  return PLAINER.textContent;
}
