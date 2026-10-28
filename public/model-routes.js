(() => {
  const open = () => AgentHubFeatures.modelCenter('agents');
  AgentHubFeatures.register('modelRoutes', '模型中心', '模型目录、Magpie 连接、Agent 分配与配置档案', open, '常用工具');
  Object.assign(AgentHubFeatures, { modelRoutes: open });
})();
