/* 两种剧本格式的唯一归一化入口。
   - 数组格式（wiki 转换过）：shots 按序，线内 nextId/jumpAct 是 **1 基**，即 wire w → 下标 w-1。
   - 对象 map 格式（原始游戏导出）：键为数字串，nextId/jumpAct 直接就是键名，缺省时落到"下一个键"。
   这里只做下标换算与遍历顺序，**不重命名任何 wire 字段**，因此 raw 脚本导入导出不产生不可逆翻译。 */

export function normalizeScript(raw) {
  const isArray = Array.isArray(raw);
  let shots;
  let wireToIndex;
  let indexToWire;

  if (isArray) {
    shots = raw.map((shot) => shot ?? {});
    wireToIndex = new Map(shots.map((_, i) => [i + 1, i]));
    indexToWire = shots.map((_, i) => i + 1);
  } else {
    const keys = Object.keys(raw ?? {}).sort((a, b) => Number(a) - Number(b));
    shots = keys.map((key) => raw[key] ?? {});
    wireToIndex = new Map(keys.map((key, i) => [Number(key), i]));
    indexToWire = keys.map(Number);
  }

  const story = {
    format: isArray ? 'array' : 'map',
    shots,
    wireToIndex,
    indexToWire,
    firstIndex: 0,
  };
  story.order = linearOrder(story);
  story.orphans = shots
      .map((_, index) => index)
      .filter((index) => !story.order.includes(index));
  return story;
}

export function toWireIndex(story, wire) {
  if (wire === null || wire === undefined) return null;
  const index = story.wireToIndex.get(Number(wire));
  return index === undefined ? null : index;
}

export function toWire(story, index) {
  return story.indexToWire[index] ?? null;
}

/* 参考的推进语义：有 nextId 用 nextId，否则落到"下一个键/下一个下标"。
   map 格式里 shotId 就是键名，所以缺省推进是"下一个键"而不是"下一个数组下标"——
   scene2 的键在 40→99、104→114 处断档，按数组下标会把主线错接到后面的分支段上。 */
export function nextIndexOf(story, index) {
  const shot = story.shots[index];
  if (!shot) return null;
  if (shot.nextId !== undefined && shot.nextId !== null) {
    return toWireIndex(story, shot.nextId);
  }
  if (story.format === 'map') {
    return toWireIndex(story, story.indexToWire[index] + 1);
  }
  return index + 1 < story.shots.length ? index + 1 : null;
}

export function isTerminal(story, index) {
  const shot = story.shots[index];
  if (!shot || shot.isEnd) return true;
  return nextIndexOf(story, index) === null;
}

export function linearOrder(story) {
  const order = [];
  const seen = new Set();
  let index = story.firstIndex;
  while (index !== null && index !== undefined &&
      index < story.shots.length && !seen.has(index)) {
    seen.add(index);
    order.push(index);
    index = nextIndexOf(story, index);
  }
  return order;
}

export function branchTargets(story, index) {
  return (story.shots[index]?.branch ?? []).map((option) => ({
    wire: option.jumpAct,
    index: toWireIndex(story, option.jumpAct),
    content: option.content,
  }));
}

/* 写回 wire 字段。map 格式的键名就是分镜的稳定身份，插入/删除/重排只需让
   indexToWire 跟着 shots 一起移动，nextId/jumpAct 引用天然保持有效。
   数组格式的 wire 等于下标+1，一次插入会让引用整体漂移，必须同步重映射。 */
export function insertShot(story, index, shot) {
  story.shots.splice(index, 0, shot);
  if (story.format === 'array') {
    remapWire(story.shots, (wire) => (wire > index ? wire + 1 : wire));
    story.indexToWire.splice(index, 0, null);
  } else {
    story.indexToWire.splice(index, 0, nextFreeWire(story));
  }
  return reindex(story);
}

export function removeShot(story, index) {
  story.shots.splice(index, 1);
  story.indexToWire.splice(index, 1);
  if (story.format === 'array') {
    remapWire(story.shots, (wire) => (wire > index + 1 ? wire - 1 : wire));
  }
  return reindex(story);
}

export function moveShot(story, from, to) {
  if (from === to) return story;
  const [shot] = story.shots.splice(from, 1);
  const [wire] = story.indexToWire.splice(from, 1);
  story.shots.splice(to, 0, shot);
  story.indexToWire.splice(to, 0, wire);
  if (story.format === 'array') {
    // 下标语义下无法可靠推导旧引用该跟谁，退化为按新顺序重建线性链。
    story.shots.forEach((entry, i) => {
      if (entry.nextId !== undefined) entry.nextId = i + 2;
    });
    remapWire(story.shots, (wire) => (wire === from + 1 ? to + 1 : wire));
  }
  return reindex(story);
}

function nextFreeWire(story) {
  const used = new Set(story.indexToWire.filter((wire) => wire !== null));
  let wire = 1;
  while (used.has(wire)) wire += 1;
  return wire;
}

function remapWire(shots, map) {
  for (const shot of shots) {
    if (shot.nextId !== undefined && shot.nextId !== null) {
      shot.nextId = map(Number(shot.nextId));
    }
    for (const option of shot.branch ?? []) {
      if (option.jumpAct !== undefined && option.jumpAct !== null) {
        option.jumpAct = map(Number(option.jumpAct));
      }
    }
  }
}

function reindex(story) {
  if (story.format === 'array') {
    story.indexToWire = story.shots.map((_, i) => i + 1);
  }
  story.indexToWire = story.indexToWire.map((wire, i) => wire ?? i + 1);
  story.wireToIndex = new Map(
      story.indexToWire.map((wire, i) => [Number(wire), i]));
  story.order = linearOrder(story);
  story.orphans = story.shots
      .map((_, index) => index)
      .filter((index) => !story.order.includes(index));
  return story;
}

export function serializeScript(story) {
  if (story.format === 'array') return story.shots;
  const out = {};
  story.shots.forEach((shot, i) => {
    out[String(story.indexToWire[i] ?? i + 1)] = shot;
  });
  return out;
}
