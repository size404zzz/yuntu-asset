export const CONTENT_TYPES = {
  1: {label: '旁白', hint: '全屏黑底居中，无说话人'},
  2: {label: '底栏', hint: '底部半透明横条，说话人一行、正文一行'},
  3: {label: '对白', hint: '气泡框，跟随左/中/右三个站位'},
  4: {label: '大字', hint: '底部横条，说话人灰色小字 + 大号正文'},
  5: {label: '提示', hint: '舞台中央白底黑字，打完自动淡出'},
};

export const HERO_SLOTS = [1, 2, 3, 4, 5];

export const BUBBLE_POSITIONS = {1: '气泡·左', 2: '气泡·中', 3: '气泡·右'};

export const IMG_TYPE = {BG: 2, SPRITE: 3};

export const SPRITE_SLOTS = {
  101: '槽位 A', 103: '槽位 B', 105: '槽位 C', 107: '槽位 D', 109: '槽位 E',
};

export function isSpriteImage(image) {
  return image.imgType === IMG_TYPE.SPRITE;
}

export function createShot(patch = {}) {
  return {
    contentType: 3,
    speakerHeroId: null,
    speakerName: '',
    speakerHeroPosId: 2,
    content: '',
    images: [],
    imgTween: [],
    ...patch,
  };
}

export function shotSummary(shot) {
  const pages = splitPages(shot.content);
  const text = pages[0] ? stripMarkup(pages[0]) : '';
  return {
    pages: pages.length,
    text: text.length > 42 ? `${text.slice(0, 42)}…` : text,
  };
}

export function splitPages(content) {
  return content ? String(content).split('<|>') : [];
}

export function joinPages(pages) {
  return pages.join('<|>');
}

export function stripMarkup(text) {
  return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\\n/g, '\n');
}

export function nextSpriteImgId(images) {
  let id = 101;
  const used = new Set(images.map((image) => image.imgId));
  while (used.has(id)) id += 2;
  return id;
}
