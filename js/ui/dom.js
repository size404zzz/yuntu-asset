export function h(tag, props = null, ...children) {
  let name = tag;
  const parts = [];
  const cls = [];
  name = name.replace(/([.#])([\w-]+)/g, (_, mark, val) => {
    (mark === '#' ? parts : cls).push(val);
    return '';
  });
  const el = document.createElement(name || 'div');
  if (parts[0]) el.id = parts[0];
  if (cls.length) el.className = cls.join(' ');
  const propsIsNode = props instanceof Node;
  if (props && !propsIsNode) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'style') {
        Object.assign(el.style, typeof v === 'string' ? {cssText: v} : v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k === 'text') {
        el.textContent = v;
      } else if (k in el && k !== 'list' && typeof el[k] !== 'function') {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : v);
      }
    }
  }
  for (const child of propsIsNode ? [props, ...children] : children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function on(root, type, handler, options = null) {
  root.addEventListener(type, (event) => {
    const target = event.target.closest(handler.selector);
    if (target && root.contains(target)) handler.fn(event, target);
  }, options);
  return root;
}

export function delegate(type, selector, fn) {
  return {type, selector, fn};
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function dashToCamel(dash) {
  return dash.replace(/-(\w)/g, (_, char) => char.toUpperCase());
}

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}
