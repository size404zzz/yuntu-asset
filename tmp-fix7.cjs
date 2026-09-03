const fs = require('fs');
let s = fs.readFileSync('tools/build-avg-effects.py', 'utf8');
const edits = [
  [`        if col is not None and getattr(col, 'enabled', False):
            alpha = gradient_alpha(getattr(col, 'gradient', None))`,
   `        if col is not None and getattr(col, 'enabled', False):
            alpha = gradient_peak_alpha(getattr(col, 'gradient', None))`],
  [`        mat_obj = resolve_pptr(getattr(mat_pptr, 'm_ProjectedIdentifier', None) and None
                               or mat_pptr, env, path, bundles_root, tex_cache) \
            if mat_pptr is not None else None`,
   `        mat_obj = resolve_pptr(mat_pptr, env, path, bundles_root, tex_cache) \
            if mat_pptr is not None else None`],
];
for (const [from, to] of edits) {
  if (!s.includes(from)) { console.error('未命中:', from.slice(0, 40)); process.exit(1); }
  s = s.replace(from, to);
}
fs.writeFileSync('tools/build-avg-effects.py', s);
console.log('两处修好');
