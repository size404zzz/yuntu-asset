/* nouns.js —— 参考 NounDes.js（回廊词典面板）的逐位移植。
   参考是「模块全局 + initialize() 自己 fetch」；这里改成按实例构造
   （编辑器允许多个播放器、词典数据由宿主注入 data/Noun_des.json），
   行为差异仅两处：
   - avgDesType 列表参考倒序 prepend（净效果 = 正序），我们直接正序 append；
   - showRef（舞台里点 data-ref 词条）在参考位于 AvgPlayer.js，它跨模块读写
     同一批 DOM，我们并进来保持单一属主。
   回廊的 selectedType/selectedEntry 等模块全局改为闭包状态。
   忠实保留的参考怪癖：type=0 的条目会同时进自己的组和总览组（同 id 出现
   两次）；hidePandect 只在点中 #avg-pandect 本体时收面板；returnToDesList
   的滚动公式原样照抄。 */

const NOUN_TYPE_NAMES = ['总览', '世界观', '概念', '人物', '事件', '地点', '势力'];

export function createPandect({refs, nouns}) {
  const groups = NOUN_TYPE_NAMES.map(() => []);
  for (const entry of Object.values(nouns)) {
    if (entry.type != 7) {
      groups[entry.type]?.push(entry.id);
      groups[0].push(entry.id);
    }
  }
  const compareEntries = (a, b) =>
      (nouns[a].avg_order.charCodeAt(0) - nouns[b].avg_order.charCodeAt(0))
      || a - b;
  let selectedType;
  let selectedEntry;

  function showRef(ref) {
    if (!nouns[ref]) return;
    refs.avgDesDt.textContent = nouns[ref].name;
    refs.avgDesDd.textContent = nouns[ref].des;
    refs.avgDes.dataset.id = ref;
    refs.avgPandect.classList.add('des');
    refs.avgOverlay.classList.add('des');
  }

  function toggleDesExpandState() {
    refs.avgDes.classList.toggle('expanded');
    refs.avgDesExpand.textContent = refs.avgDes.className ? '收回阅读' : '展开阅读';
  }

  function returnToDesList() {
    const type = nouns[refs.avgDes.dataset.id].type;
    refs.avgDesType.children[type].click();
    const targetOrder = groups[type].findIndex((e) => e == refs.avgDes.dataset.id);
    const targetEntry = refs.avgDesEntries.children[targetOrder];
    targetEntry.click();
    refs.avgPandect.classList.replace('des', 'expanded');
    refs.avgDesEntries.scrollTop =
        refs.avgStage.clientHeight * (targetOrder / 11.25 + 7 / 324 - 397 / 1080);
    delete refs.avgDes.dataset.id;
  }

  function updateEntries(event) {
    const type = event.target.dataset.type;
    if (type == selectedType) return;
    refs.avgDesType.children[selectedType || 0].className = '';
    refs.avgDesType.children[type].className = 'selected';
    selectedType = type;
    const newEntries = document.createDocumentFragment();
    for (const id of groups[type]) {
      const entry = document.createElement('li');
      entry.textContent = nouns[id].name;
      entry.dataset.id = id;
      newEntries.append(entry);
    }
    refs.avgDesEntries.replaceChildren(newEntries.cloneNode(true));
    refs.avgDesEntries.scrollTop = 0;
    selectedEntry = undefined;
  }

  function showEntry(event) {
    const target = event.target;
    if (target.tagName != 'LI' || target === selectedEntry) return;
    if (selectedEntry !== undefined) {
      selectedEntry.classList.remove('selected');
    }
    selectedEntry = target;
    target.classList.add('selected');
    if (!refs.avgPandect.classList.contains('des')) {
      refs.avgPandect.classList.add('expanded');
    }
    refs.avgDesDt.textContent = nouns[target.dataset.id].name;
    refs.avgDesDd.textContent = nouns[target.dataset.id].des;
  }

  function hidePandect(event) {
    if (event.target === refs.avgPandect) {
      refs.avgOverlay.className = '';
      refs.avgPandect.className = '';
      refs.avgDes.classList.remove('expanded');
      refs.avgDesExpand.textContent = '展开阅读';
      refs.avgDesType.children[0].click();
    }
  }

  function handlePandectClick(event) {
    event.stopPropagation();
    const target = event.target;
    if (target.dataset.type !== undefined) {
      return updateEntries(event);
    } else if (target.dataset.id) {
      return showEntry(event);
    }
    switch (target) {
      case refs.avgDesExpand:
        toggleDesExpandState();
        break;
      case refs.avgDesReturn:
        returnToDesList();
        break;
      default:
        hidePandect(event);
    }
  }

  for (const [type, name] of NOUN_TYPE_NAMES.entries()) {
    groups[type].sort(compareEntries);
    const li = document.createElement('li');
    li.textContent = name;
    li.dataset.type = type;
    refs.avgDesType.append(li);
  }
  refs.avgPandect.addEventListener('click', handlePandectClick);
  refs.avgDesType.children[0].click();

  return {showRef};
}
