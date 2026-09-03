/* test-layers.mjs —— 游戏五层状态折叠的快速回归。
 * DOM 动画仍由 Player/浏览器负责；这里钉住最容易退化的纯数据契约：
 * 非角色注册、同镜多层 tween、明暗/位置/旋转/缩放继承，以及 delete 回收。
 */
import assert from 'node:assert/strict';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';

const st = emptyState();
applyImages(st, [
  {imgId: 1, imgType: 1, alpha: 0, imgPath: 'sg/sg_e_bg003'},
  {imgId: 2, imgType: 2, alpha: 0, imgPath: 'cpt00/cpt00_e_bg005'},
  {imgId: 5, imgType: 4, alpha: 0, imgPath: 'cpt09/ef001', order: 10},
  {imgId: 3, imgType: 5, alpha: 0, imgPath: 'avg/cpt00_broken'},
  {imgId: 101, imgType: 3, alpha: 0, imgPath: 'persicaria_avg'},
]);

assert.deepEqual([...st.layers.keys()], [1, 2, 5, 3], '五层非角色注册落盘');
assert.deepEqual(st.laneOrder, [], '非角色层不污染角色 lane');

const result = applyShotTweens(st, {
  imgTween: [
    {imgId: 1, duration: 0.6, delay: 1, alpha: 1, isDark: true},
    {imgId: 5, duration: 0.2, alpha: 0.75, rot: [0, 0, 12]},
    {imgId: 3, duration: 1, alpha: 1, scale: [1.2, 1.2]},
  ],
});
assert.equal(result.lastEnding, 1.6, '所有层共用最晚 delay+duration 门');
assert.deepEqual(result.events.map((e) => e.imgType), [1, 4, 5], '五层事件按镜头序输出');
assert.equal(st.layers.get(1).alpha, 1);
assert.equal(st.layers.get(1).isDark, true);
assert.deepEqual(st.layers.get(5).rot, [0, 0, 12], '旋转保留三维运行时参数');
assert.deepEqual(st.layers.get(3).scale, [1.2, 1.2]);

applyImages(st, [{imgId: 2, delete: true}]);
assert.equal(st.layers.has(2), false, 'delete 回收非角色层');
assert.equal(st.imgMap.has(2), false, 'delete 同步回收注册表');

console.log('五层状态折叠通过');
