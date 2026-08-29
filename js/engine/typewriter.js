/* typewriter.js —— 参考 readLine / typeWriteScrambled 的可注入时钟移植。
   控制流与参考逐位一致：
   - 每步吃一个 HTML 字符、写一次 innerHTML；
   - `<` 置 atTag、`>` 清 atTag；atTag 时同步递归（不产生停顿）；
   - 不在标签里才 `await wait()`（= 参考的 setTimeout(…,50)，一次可见停顿）；
   - 吃完最后一字符直接收尾；`interrupt` 时本步直接写全量并收尾。
   `wait` 由外部注入：真实播放传 50ms 定时器，测试传立即 resolve 的虚拟时钟，
   于是同一份代码既能跑也能被逐帧断言。`paints` 记录每个可见帧 + 收尾帧，
   供测试与 markup.hops() 对拍。 */

export function randomAlphabet(length) {
  const out = [];
  for (let i = length; i--; ) out.push(String.fromCharCode(65 + Math.floor(26 * Math.random())));
  return out.join('');
}

export class Typewriter {
  constructor({line, wait, rand, measureLen, onEnd} = {}) {
    this.line = line ?? null;
    this.wait = wait ?? (() => Promise.resolve());
    this.rand = rand ?? randomAlphabet;
    /* scramble 模式用「整页长度」当乱码尾巴的参照 —— 参考取 heightTester.innerHTML.length。 */
    this.measureLen = measureLen ?? (() => (this.line?.textContent ?? '').length);
    this.onEnd = onEnd ?? (() => {});
    this.reset();
  }

  reset() {
    this.charId = 0;
    this.atTag = false;
    this.interrupt = false;
    this.reading = false;
    this.done = false;
    this.whole = '';
    this.scramble = false;
    this.paints = [];
  }

  setInterrupt() { this.interrupt = true; }

  async start(whole, {scramble = false} = {}) {
    this.reset();
    this.whole = whole;
    this.scramble = scramble;
    this.reading = true;
    if (scramble) await this._scramble(0);
    else await this._read();
  }

  _paint(html) {
    if (this.line) this.line.innerHTML = html;
  }

  _finish() {
    this.paints.push(this.whole);
    this.done = true;
    this.interrupt = false;
    this.reading = false;
    this.charId = 0;
    this.onEnd();
  }

  /* 参考 readLine。 */
  async _read() {
    const html = this.interrupt ? this.whole : this.whole.slice(0, ++this.charId);
    this._paint(html);
    const ch = html.slice(-1);
    if (ch === '<') this.atTag = true;
    else if (ch === '>') this.atTag = false;
    if (html === this.whole) return this._finish();
    if (this.atTag) return this._read();
    this.paints.push(html);
    await this.wait();
    return this._read();
  }

  /* 参考 typeWriteScrambled：标签字符不落字、普通字符后拖一段随机大写字母。 */
  async _scramble(textLength) {
    let textLen = textLength;
    const ch = this.whole.slice(this.charId, ++this.charId);
    if (ch === '<') this.atTag = true;
    else if (ch === '>') this.atTag = false;
    let html = '';
    let painted = false;
    if (this.interrupt) {
      html = this.whole;
      this._paint(html);
      painted = true;
    } else if (!this.atTag && ch !== '>') {
      textLen++;
      html = this.whole.slice(0, this.charId) +
          this.rand(this.measureLen() - textLen);
      this._paint(html);
      painted = true;
    }
    if (html === this.whole) return this._finish();
    if (this.atTag) return this._scramble(textLen);
    if (painted) this.paints.push(html);
    await this.wait();
    return this._scramble(textLen);
  }
}
