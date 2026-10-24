// icons.js —— 跨模块共享的语义图标。
//
// 为什么要有这个文件：同一个「展开全部 / 收起全部」动作，历史上在四个面板里
// 各画各的 —— 项目树是方框加号/减号、Git 面板是上下双箭头、大纲又是另一种双箭头、
// 搜索面板是单个三角。用户看到的是「四个不同的按钮干同一件事」，还得逐个试。
//
// 这里只收「必须跨文件一致」的图标；按钮布局、尺寸、hover 仍由各自面板决定，
// 免得把样式耦合进来。新增图标请只在这份文件里改，不要在调用处写死路径。
//
// 采用的行内 SVG 规范见 styles.css 的 svg.ic：16×16 viewBox、1.4px 线性描边、
// 颜色一律 currentColor（跟着按钮的 color 走）。
(function (host) {
  const wrap = (body) => '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">' + body + '</svg>';

  // ⚠ 16px 下的实测教训：最初画的「双箭头」上下两端分别离中线 2.8px / 1.6px，
  //   渲染出来「收起」像字母 X、「展开」糊成一个菱形，两个都读不出方向。
  //   现在的画法是「一条中线 + 两枚短箭头」：
  //     · 箭头只占 2.2px 高，中间留 3.2px 空白，绝不连成一团；
  //     · 加一条 6px 的横向中线当基准 —— 有没有它，直接决定用户把图形读成
  //       「某个图标」还是「向里/向外」；
  //     · 展开 = 箭头头朝外（背离中线），收起 = 箭头头朝里（指向中线）。
  const MID = '<path d="M5 8h6" opacity=".55"/>';
  const expandAll = wrap(MID + '<path d="M5.6 6.1 8 3.7l2.4 2.4"/><path d="M5.6 9.9 8 12.3l2.4-2.4"/>');
  const collapseAll = wrap(MID + '<path d="M5.6 3.7 8 6.1l2.4-2.4"/><path d="M5.6 12.3 8 9.9l2.4 2.4"/>');

  // 单层的展开/收起（用于可折叠的单个块，如搜索面板的一组结果）。
  const foldOpen = wrap('<path d="M4.4 6.2 8 9.8l3.6-3.6"/>');
  const foldClose = wrap('<path d="M4.4 9.8 8 6.2l3.6 3.6"/>');

  const api = { expandAll, collapseAll, foldOpen, foldClose };
  if (typeof module !== 'undefined') module.exports = api; else host.Icons = api;
})(typeof window === 'undefined' ? globalThis : window);
