// 回归测试：Markdown live 模式下图片的移动与粘贴（2026-10-29）
//
// 覆盖两处用户报告的真实问题，都在 live（实时预览）模式下：
//   ① 移动图片位置后图片消失
//   ② 粘贴新图片有时没反应 / 多张图挤成一行
//
// 这个文件刻意不连服务器、不打开真实窗口：它直接检查源码里的关键约束，
// 因为这两个 bug 的根因都是「装饰生成规则」，不是运行时状态。
// 端到端的行为验证放在 scripts/ 下的真 Electron 脚本里做。
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'md-editor.js'), 'utf8');
let passed = 0;
const check = (name, ok, extra) => {
  assert(ok, name + (extra !== undefined ? ' | ' + extra : ''));
  passed++;
  console.log('ok ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
};

// ① 图片内部的 URL 不得再生成装饰。
// 根因：Image 节点已被整段 replace 成 ImgWidget，其内部的 LinkMark/URL
// 若再叠加 mark/replace，就成了「装饰落在被替换区间内」。单张图 CM6 能容忍，
// 但两张图相邻（各自独占一行、只隔一个换行）时，后一张图的 widget 会被静默
// 丢弃 —— 引用还在、文档也对，图就是不显示。
check('URL 装饰分支会跳过图片内部',
  /if \(pl && pl\.name === 'Image'\) return;/.test(src));
check('LinkMark 装饰分支会跳过图片内部',
  /if \(name === 'LinkMark' && parentName === 'Image'\) return;/.test(src));
check('图片内部的 URL 不再产生 cm-md-link 标记',
  // 该标记只应在非图片分支产生：确认 Image 的 return 出现在 mark 之前
  (() => {
    const urlBlock = src.slice(src.indexOf("if (name === 'URL')"), src.indexOf("if (name === 'URL')") + 1200);
    const imageGuard = urlBlock.indexOf("pl.name === 'Image'");
    const linkMark = urlBlock.indexOf("class: 'cm-md-link'");
    return imageGuard >= 0 && linkMark > imageGuard;
  })());

// ② 图片 widget 必须把事件交还给编辑器。
// 原来 ignoreEvent() 返回 true 吞掉所有事件 → 光标进不到图片所在行，
// 想用 Home / Shift+End / Ctrl+X 整行剪切只能靠鼠标拖选，几乎选不准。
const imgWidget = src.slice(src.indexOf('class ImgWidget'), src.indexOf('// ---------- 无序 bullet'));
check('ImgWidget 不再吞掉全部事件（ignoreEvent 返回 false）',
  /ignoreEvent\(\)\s*\{\s*return false;\s*\}/.test(imgWidget));
check('ImgWidget 里没有残留的 ignoreEvent 返回 true',
  !/ignoreEvent\(\)\s*\{\s*return true;\s*\}/.test(imgWidget));

// ③ 粘贴图片要独占一行（不能和前一张挤成 ![](a)![](b)）。
const pasteBlock = src.slice(src.indexOf('paste(e, view) {'), src.indexOf('paste(e, view) {') + 4000);
check('粘贴图片时按前后文补换行',
  /const before = atLineStart \? '' : '\\n'/.test(pasteBlock) || /before \+ body/.test(pasteBlock));
check('粘贴后用整段 insert（不是逐张 insert）',
  /const insert = before \+ body/.test(pasteBlock));

// ④ 文本粘贴：单行图片引用粘到空行时要整行插入 + 补空行。
// 场景就是用户的操作：Ctrl+X 剪走一行图片 → 光标移到别处 → Ctrl+V。
// 默认行为会紧贴插入，两张图挤成一行。
check('文本粘贴识别单行图片引用',
  /\^!\\\[\[[^\]]*\]\\\]\\\(\[\^\)\]\*\\\)\\s\*\$/ .test(pasteBlock.replace(/\s/g, '')) ||
  /!\\\[\[\^\\\]\]\*\\\]\\\(/.test(pasteBlock));
check('整行粘贴只在空行或行首生效',
  /const onEmptyLine = line\.text\.trim\(\) === ''/.test(pasteBlock) &&
  /const atLineStart = sel\.head === line\.from/.test(pasteBlock));
check('整行粘贴带 userEvent 标记（便于历史/撤销区分）',
  /userEvent: 'input\.paste'/.test(pasteBlock));

console.log('\nMarkdown 图片移动与粘贴：' + passed + ' 通过 / 0 失败');
