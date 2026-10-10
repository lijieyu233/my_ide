// 工具名称、参数与模型描述共用一份定义，避免前端承诺的能力在主进程被当作未知工具。
(function (host, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.AiLaunchTools = api;
})(typeof window === 'object' ? window : globalThis, () => {
  const selector = { program: ['selector', true] };
  const fields = { name: ['label', false], cwd: ['directory', false], command: ['command', false],
    category: ['label', false], port: ['port', false], openUrl: ['url', false] };
  const schemas = {
    launch_open: {}, launch_list: {},
    launch_start: selector, launch_stop: selector, launch_restart: selector,
    launch_logs: { ...selector, lines: ['lines', false] },
    launch_add: { ...fields, name: ['label', true], cwd: ['directory', true], command: ['command', true] },
    launch_update: { ...selector, ...fields },
  };
  const labels = { launch_open: '打开启动面板', launch_list: '查看程序', launch_start: '启动程序',
    launch_stop: '停止程序', launch_restart: '重启程序', launch_logs: '查看程序日志',
    launch_add: '新增程序', launch_update: '编辑程序' };
  const descriptions = {
    launch_open: '显示 MyIDE 启动面板。无需打开项目。',
    launch_list: '列出启动面板所有程序的 ID、完整名称、配置和真实运行状态。操作程序前先查看；端口响应不能当作本程序就绪或归属证明。',
    launch_start: '按 ID 或完整名称启动已配置的程序，返回真实进程状态；启动受理不等于服务已就绪。',
    launch_stop: '停止启动面板管理的指定程序。只停止服务核验为自有的进程，不停止陌生端口监听者。',
    launch_restart: '停止成功后重新启动指定程序；停止失败时不会继续启动。',
    launch_logs: '读取指定程序本次运行已有的日志。恢复后的历史运行可能没有内存日志，不得据此认定没有错误。',
    launch_add: '新增启动面板程序配置。必须向用户取得程序名称、绝对工作目录和启动命令；不猜命令。添加后不会自动启动。',
    launch_update: '编辑指定程序，未提供的字段原样保留。先 launch_list 查看 ID 和原配置；修改配置不会自动重启。',
  };
  const fieldDescriptions = { program: 'launch_list 返回的 ID（优先）或程序完整名称；不能用模糊简称',
    name: '程序名称', cwd: '已存在的绝对工作目录', command: '用户指定的完整启动命令',
    category: '启动面板分类', port: '端口整数 0..65535，0 表示无端口', openUrl: 'HTTP/HTTPS 页面地址，可用空字符串清除',
    lines: '最后多少行日志，整数 1..200，默认 50' };
  const tools = Object.entries(schemas).map(([name, schema]) => ({
    type: 'function', function: { name, description: descriptions[name], parameters: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(schema).map(([field, [kind]]) => [field, {
        type: ['port', 'lines'].includes(kind) ? 'integer' : 'string', description: fieldDescriptions[field],
        ...(['port', 'lines'].includes(kind) ? { minimum: kind === 'port' ? 0 : 1, maximum: kind === 'port' ? 65535 : 200 } : {}),
      }])), required: Object.entries(schema).filter(([, [, required]]) => required).map(([field]) => field),
    } },
  }));
  const mutations = ['launch_start', 'launch_stop', 'launch_restart', 'launch_add', 'launch_update'];
  return { schemas, tools, labels, mutations, has: name => Object.hasOwn(schemas, name) };
});
