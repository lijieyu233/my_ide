# Markdown 大纲折叠与标题定位取证

> 2026-10-01，第十轮持续审计；基线 `f691749`，MyIDE0.8.5。
> 对应 [089总台账](./开发文档-089-全模块成熟项目对照与持续改进台账.md) 的 OUTLINE-01/MD-01，并补充 PROJECT-01 的迟到结果证据。只交付取证和后续合同，未修产品；维持P1，没有以“隐藏正文”推断已发生数据丢失。

## 1. 方法与边界

Node22.20.0/jsdom29.1.1加载原index.html，完整eval实际cm6-bundle、marked、md-editor、plugin-loader、viewer、outline。使用公开Viewer.openFile、真实CM6 transaction、foldToLevel、Outline公开API和实际DOM按钮/事件，不复制标题/折叠算法。App只保留所需桥，refreshOutline函数体原样取自app.js，activeTool为受控变量；其余导航/状态栏为桩。文件读取来自fixture内存表，写入固定返回“fixture-write-disabled”，剪贴板只记录数组，未打开或修改实际用户文件。

P1–P6为6类标题语义对拍：实际Outline.parse、实际marked渲染及仓库CM6包里的Markdown语法树。D1–D5为5类完整大纲/Viewer行为，D2/D5含两个fixture；F1/F2为2类真实CM6折叠；W1为1类实际补全源；共14类观察，另有正常ATX导航/复制/折叠对照C1。小文档语法树通过ensureSyntaxTree确认；未以正则“期望结果”代替实际语法树。

Electron33.4.11/Node20.18.3/Chromium130.0.6723.191隐藏窗口对拍N1–N5。入口在ready前设独立userData，show:false、skipTaskbar、--headless/--disable-gpu/--no-sandbox，显式setContentSize；DOM仍加载上述完整实际模块，App/文件/剪贴板桥与主实验相同，不含完整App、生产preload或真实IPC。窗口没有show或抢桌面焦点；不验证沙箱能力。N1/N2/N3捕获真实窗口并看图，修正捕获时序后等待两帧paint，避免把上一帧截图当作新状态。

stdin脚本不落仓库，每个jsdom关闭并destroy当前编辑器。原生入口、HTML、模块注入、profile、JSON和PNG位于唯一myide-audit099-native-临时目录；进程退出0，无相关进程后校验realpath、os.tmpdir父目录和basename再清理。没有清理或改动已有.ui-check-trash/取证文件。

未运行本轮标准--check-live/--check-ui；不沿用历史101或167作为当前基线。未验证真实用户键盘焦点/读屏、中文IME、图片异步尺寸、表格编辑撤销、长文/多主题/缩放几何、完整项目恢复或实际磁盘watcher。下文截图与模块运行仅支持所列场景。

## 2. 标题解析三方对拍

| 编号 | 输入要点 | Outline实际结果 | marked预览/CM6语法树 |
|---|---|---|---|
| P1 | 四反引号开围栏，内有三反引号及CODE_B；四反引号关闭后REAL | 只列CODE_B，漏REAL | 只认REAL；CM6为一个ATXHeading1 |
| P2 | 波浪围栏内有三反引号及CODE_B，波浪关闭后REAL | 只列CODE_B，漏REAL | 只认REAL；不同围栏字符不能互相关闭 |
| P3 | SETEXT下一行等号；后有ATX REAL | 只列REAL，line5 | SETEXT与REAL均为h1；CM6含SetextHeading1/ATXHeading1 |
| P4 | 两空格缩进的ATX INDENT；空标题单独#；标题C# | 仅列C，漏前两项且删末尾# | 预览文字INDENT、空串、C#；CM6三个ATXHeading1 |
| P5 | blockquote中的QUOTED、list中的LISTED，后有REAL | 只列REAL | 预览/CM6认三项，其中LISTED为H2；本轮不替产品决定容器标题是否应入大纲 |
| P6 | div HTML块内行首# HTML_BODY，块结束后REAL | 列HTML_BODY和REAL | 预览/CM6只认REAL，HTML块内部不是Markdown标题 |

原Outline围栏状态在任何符合前缀的围栏行翻转，未记录字符、长度或合法结束条件；ATX正则不支持缩进/空标题、过度去尾#，且不理解容器与HTML块。不能把P1/P2修成“只记录围栏字符”就宣称语义已统一。MD编辑器foldToLevel另有同类布尔围栏扫描；live装饰的标题范围又有另一份headingLines正则。现有CM6树对这些小fixture可提供正确标题结构，没必要再引入一套大型Markdown解析依赖。

P1/P2完整输入分别为：四反引号、# CODE_A、三反引号、# CODE_B、四反引号、# REAL；或波浪三围栏、# CODE_A、三反引号、# CODE_B、波浪三围栏、# REAL。每项独占一行并以LF结尾，便于后续直接重建fixture，不保留一次性脚本。

## 3. 完整大纲、编辑器与补全结果

| 编号 | 动作 | 真实模块输出/状态 | 原因 |
|---|---|---|---|
| D1 | 打开P3预览，点唯一大纲REAL | 高亮SETEXT，REAL未高亮 | jump按大纲i索引预览querySelectorAll(h1…h6)，不是源码映射；漏标题直接变跳错章节 |
| D2-cross/prune | A/B均第一行SAME且有CHILD；A收起后开B；再开不同标题文件并切回A | B的CHILD也隐藏；保存["1|SAME"]；不同文件刷新prune成[]，回A已展开 | 全局单一localStorage键；当前文件validKeys会删除别的文件记录 |
| D3 | TOP/CHILD收起，真实CM6在文首插PREAMBLE及空行，等大纲防抖 | CHILD展开、保存[] | line|text随插入变化，无交易映射或重识别 |
| D4 | A源模式改OLD→OLD_EDITED，300ms前打开B CURRENT | 刚切换显示CURRENT；340ms后大纲OLD_EDITED，active仍current.md；sectionText返回B的CURRENT正文 | 旧cmOutlineTimer没在切换销毁时清理；App.refreshOutline只检查工具可见，不检查tab身份。全局headings与Viewer.activeTab已分属两个文档 |
| D5-unselected/focus | 大纲无选中时在body派发Right；另一个button获得DOM焦点后Down | Right preventDefault且异常reading level；Down选中大纲项 | childrenRange(-1)直接读undefined；document全局监听只看panel可见，不要求焦点属于大纲。事件为合成，未模拟真实OS键盘 |
| F1 | TOP之后四围栏中有CODE_A/短三围栏/CODE_B，正确关闭后NEXT；source调用foldToLevel(2) | 折叠from36/to59，范围为text、关闭四围栏、NEXT与body | 错把CODE_B认作H2，后续NEXT被布尔围栏状态跳过，范围延伸到文末；实际CM6接受并隐藏此范围，源码没被删除 |
| F2 | 两个Setext H1带body，live调用foldToLevel(1) | 语法树有两个SetextHeading1，folds=[]、箭头0 | 手工扫描只识ATX；live内容样式分支也只识ATX，不能用语法树已经支持证明本模块交互支持 |
| W1 | A_TITLE在大纲中，activeTool改project；B源模式为B_TITLE及[[#，触发实际startCompletion | active=wikiB.md，但Outline仍A_TITLE，候选A_TITLE | 当前文件补全读取Outline.headings；大纲非当前工具时App跳过refresh，派生数据依赖面板可见性 |

**C1正常对照**：TOP含intro、CHILD/body，后为NEXT。点箭头能收起/展开CHILD；点CHILD时真实CM6光标到第4行；复制TOP为TOP+intro+CHILD/body且不包含NEXT；foldToLevel(2)只折叠child body一节，范围22–33。保留已有章节复制、箭头独立区域、右键层级折叠和正常ATX导航，不以移除折叠功能规避F1。

D4的复制错位只证明标签与正文归属不一致；没有实际复制到系统剪贴板或写盘。D5没加载完整App的所有快捷键监听，结论限Outline自身全局监听；后续需真正焦点与快捷键互斥验收。W1没有验证外部文件缓存失效，相关headingsOf/sliceSection的单次缓存与独立正则仅C，不能新增“已经读错外部文件”的R。

## 4. 隐藏Electron对拍与截图核对

| 编号 | 同场景 | 生产运行时模块结果及图像 |
|---|---|---|
| N1 | D1 | clicked=REAL、highlighted=[SETEXT]；截图左侧REAL选中，右侧SETEXT有蓝框，REAL无框 |
| N2 | F1 | from36/to59，范围包含# NEXT/body；截图CODE_B后是折叠占位，NEXT整节看不到 |
| N3 | D4 | active=current.md；immediate=[CURRENT]→late=[OLD_EDITED]；copy为# CURRENT/current body。截图左侧OLD_EDITED，右侧源码CURRENT |
| N4 | F2 | live folds=[]、arrows0、headingClasses0；本轮没为此项捕获几何截图，不能宣称整套Setext排版完成量测 |
| N5 | W1 | active=wikiB.md，Outline/实际completion均A_TITLE；仅返回状态，不将隐藏窗口无DOM焦点当成真实键盘候选交互证明 |

三个截图已看图核对后删除，保留以上场景与结果摘要；无需在仓库根堆截图。首次N2捕获发生在paint前仍显示N1，属于取证时序问题；等待两帧后图像与折叠状态一致，旧图不作为证据。窗口按show:false运行，没有以“断言绿了”替代看图。

## 5. 成熟项目、规范与库参照

| 官方来源（本轮核查） | 确认事实 | 对本项目的用法 |
|---|---|---|
| [CommonMark0.31.2](https://spec.commonmark.org/0.31.2/) | 围栏关闭要求同字符且长度不少于开围栏；ATX允许有限缩进/空标题，结尾#有空白条件；另有Setext和容器/HTML语义 | 作为语义fixture依据，不用一条行正则代替整个块上下文；扩展语法另列兼容合同 |
| [Obsidian Outline](https://obsidian.md/help/plugins/outline) | 大纲列出活动笔记标题，支持定位及章节调整 | 借鉴活动文件归属与导航；拖动重排不是本轮新增必需项，先修已有能力 |
| [CodeMirror折叠官方源码](https://raw.githubusercontent.com/codemirror/language/main/src/fold.ts) | foldState用transaction changes映射，foldEffect/unfoldEffect承载范围，可序列化状态 | 复用仓库实际可用API与EditorState；不要把手工行号状态误作编辑器折叠状态 |
| [CodeMirror语言官方源码](https://raw.githubusercontent.com/codemirror/language/main/src/language.ts) | syntaxTree可能不完整，ensureSyntaxTree有时间预算，背景解析有边界 | 共享标题索引必须带完整度和revision，未解析尾部不能宣布“无标题”或把旧条目永久prune |
| [CodeMirror位置映射官方源码](https://raw.githubusercontent.com/codemirror/state/main/src/change.ts) | mapPos可跟随变更并选择边界/删除语义 | 编辑期迁移标题锚点；映射后仍要核对语义，不能保证改名/重复标题自动唯一 |
| [W3C APG Tree View](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) | 树获得焦点时初始化焦点节点，方向键在树中导航；焦点和选中有区别，tree/treeitem/aria-expanded等表达状态 | 给大纲自己的焦点边界和可访问状态，不依赖全局document抢按键 |

CodeMirror文档直开受到403限制，采用官方搜索摘要及上述官方源码交叉核查；引用为查阅时main，不声称与仓库打包版本逐字相同。实际行为由仓库cm6-bundle运行确认。以上索引/ID/性能预算为MyIDE设计，非声称Obsidian采用同一内部结构，也没有对其安装程序做行为对拍。

## 6. 分包实施合同

### 099-A：同源标题索引与章节范围（OUTLINE-01/MD-01，P1）

1. 为每个文档版本生成HeadingIndex，至少{documentId,revision,complete,headings:[id,level,from,headerTo,bodyFrom,sectionTo,plainText,rawText,container]}。优先复用当前CM6 Markdown树；preview无EditorView时使用同语法配置的可独立解析入口，不通过创建隐藏编辑器才能拿标题。保留wiki/脚注/callout等已用扩展，和marked输出做兼容对拍。
2. 覆盖ATX/Setext、多行Setext、缩进/空标题、同名/尾#、围栏、HTML、list/blockquote。容器标题是否入大纲先明确策略；即使筛掉容器标题，也不能再按筛选后序号跳预览。HTML和嵌入子文档的DOM标题不能冒充当前文档的Markdown标题。
3. 大纲、层级折叠、live箭头、wiki标题补全、嵌入章节切片共享此索引。章节层级与容器边界分别记录，不把“任何更浅标题”一律当所有容器的结束。复制按headerTo/bodyFrom区分正文，Setext正文不能包含等号下划线；原文复制保持完整标题源码及子章节。
4. 大文档解析有预算/complete标记。使用分片/缓存和后台更新时校验revision；解析未完的部分保留可解释状态，不清空所有标题或跑无预算全篇forceParsing。更新内存索引不受大纲是否显示影响。
5. 验收P1–P6分别对拍索引/preview/实际CM6；F1不得产生CODE_B标题范围且NEXT仍可见；F2的Setext标题样式/箭头/折叠与同级ATX合同一致；C1复制及正常范围保留。多行Setext、嵌套容器和自定义扩展补验，不用6条小fixture宣称CommonMark全面合规。

### 099-B：按源码身份定位和版本归属（OUTLINE-01/PROJECT-01，P1）

1. 大纲渲染绑定{documentId,path,revision,generation}；viewer切标签/模式/关闭时取消旧timer，回调也核对活动身份再提交，不只clearTimeout而漏掉已经开始的异步解析。App.refreshOutline要求传入版本与当前文档匹配，挂起/关闭文档不能写当前大纲。
2. preview/split渲染给当前文档标题标记headingId及source offset；jump按ID或映射位置定位，不使用hs[Math.min(i,last)]兜底。映射失效返回重新解析/受控提示，不能静默跳最后一个标题。嵌入子文档的headingId在独立文档命名空间。
3. live/source按同一索引位置选择并滚动；目标在折叠内时由当前EditorState展开必要范围。CM6中的LF偏移与磁盘CRLF分开处理，保持已有083的编辑器正文作为位置基准。跳转/复制提交前核对索引revision，不能用A的heading行号切B的正文。
4. 验收D1/N1的REAL定位REAL；D4/N3在A迟到时B的大纲/复制仍B，切模式/关闭/换项目同验。Setext、重复标题、原始HTML、嵌入标题和split映射补验；定位失败不更新错误选中状态。

### 099-C：文件独立状态与树焦点（OUTLINE-01，P1）

1. 折叠/选中状态按规范化项目和稳定文档身份保存，区分“大纲树折叠”与“正文EditorState折叠”。rename/move沿097的文档身份迁移，路径变化不复制到无关文档；全局旧键迁移只能有明确归属，无法确认则保留旧值/备份并采用新默认，不能把旧状态套所有文件。
2. 编辑中锚点用transaction映射，再以类型/层级/文本/父链/同名序号重识别。删除/改名/插入同名等歧义有确定的重置策略；只prune当前文档完整新索引的失效项，不删其他文件状态，也不把“没解析完”当删除。D3正文前插入应保持可识别节点收起及选中。
3. 树容器具有自身可焦点入口，用roving tabindex或aria-activedescendant，初始化首个可见节点；方向键仅在树拥有焦点时处理。selIdx=-1/空树/刷新后选中隐藏/删除时先校验，左右键不抛异常、不吞其他控件的按键。
4. 确定单选/焦点跟随模型，补tree/treeitem/group、aria-expanded/selected及可见焦点；保留箭头与文本独立点击、现有右键文案和SVG图标，不借机全局重做UI。Enter跳编辑器后退出树的键盘接管。
5. 验收D2不同文件互不影响且回A保留A；D3映射后状态稳定；D5首次左右键及外部button方向键无异常/无抢占。真实Electron焦点、Tab往返、上下左右/Home/End、屏幕阅读器和100/125/150%缩放补验，不能以jsdom派发事件通过宣称可访问性已完整达标。

### 099-D：标题补全/切片独立于面板与缓存（MD-01，P1）

1. 当前文件补全直接读取当前文档版本的HeadingIndex，Outline只订阅它；不以面板visible作为数据刷新开关。W1/N5在activeTool=project时仍给B_TITLE，旧A响应不能更新B候选。
2. 其他文件标题缓存绑定{projectGeneration,path,fileVersion}，内容变更/rename/delete有明确失效；读取中换项目/文件时丢弃旧结果。按预算做LRU/合并相同请求，失败不缓存成永远空标题。实际磁盘watcher和外部更新单独取证，本轮只确认当前文件候选错误。
3. sliceSection改用共享语义/ID，目标不存在返回可解释结果，不能静默把整个文档当所选章节。重复标题、尾#、Setext及容器范围与导航/复制同合同；wiki显示别名与实际目标分开存，不依赖易变行号。
4. 验收W1/N5、隐藏大纲后编辑标题、外部文件更新、同名标题和切换项目迟到候选；候选插入后目标可定位。C1正常导航继续通过，新增成熟产品“拖动章节”能力留P2需求验证，不与可靠性包混做。

## 7. 排期、质量与关闭

OUTLINE-01增加完整模块/隐藏Electron R；MD-01由仅H改C/R/H，已确认标题折叠/Setext装饰及当前wiki候选一致性问题，几何/IME/长文仍H。维持P1：本轮没有证实写盘损坏、撤销数据丢失或真实性能指标，不能因为标题隐藏而升P0。先099-A/B修语义与归属，再099-C/D状态/补全，各项独立提交，每版1–2项，服从089既有P0数据保全排期。

后台npm test退出0：语法28文件、Git套件通过、DOM279通过/0失败。临时完整模块专项与隐藏Electron对拍退出0；本轮产品/测试未改。只更新099、089、090和ROADMAP，提交/推送后核对origin/dev与HEAD并按原参数重启MyIDE。

关闭证据要求失败fixture在原产品变为正确索引/目标/版本归属，C1正常行为保留；真实窗口N1–N5及截图重新验收，标准check-live一致性组通过，新增Setext/围栏/引用等语义组补齐，实际焦点与多模式定位验证。提交与报告证明后才关闭条目；本轮不关闭问题，也不以设计完成替代实施完成。
