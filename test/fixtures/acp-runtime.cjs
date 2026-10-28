const fs = require('fs');
const readline = require('readline');
const report = process.argv[2];
function out(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
const modes = { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }] };
const models = { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'A' }, { modelId: 'model-b', name: 'B' }] };
const configOptions = [{ id: 'effort', name: 'Effort', type: 'select', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (report) fs.appendFileSync(report, JSON.stringify(msg) + '\n');
  let result = {};
  if (msg.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [] };
  if (msg.method === 'session/new') {
    result = { sessionId: 'acp-session-fixture', modes, models, configOptions };
    out({ method: 'session/update', params: { sessionId: result.sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'explain', description: 'Explain code' }] } } });
  }
  if (msg.method === 'session/load') {
    result = { modes, models, configOptions };
    out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } } } });
  }
  if (msg.method === 'session/set_model') models.currentModelId = msg.params.modelId;
  if (msg.method === 'session/set_mode') modes.currentModeId = msg.params.modeId;
  if (msg.method === 'session/set_config_option') { configOptions[0].currentValue = msg.params.value; result = { configOptions }; }
  if (msg.method === 'session/prompt') out({ method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP OK' } } } });
  if (msg.id !== undefined) out({ jsonrpc: '2.0', id: msg.id, result });
});
