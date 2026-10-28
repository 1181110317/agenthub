(() => {
  let activeColors = [], catalog = { themes: [], languages: [] };
  function applyTheme(id) {
    for (const variable of activeColors) document.body.style.removeProperty(variable); activeColors = [];
    const theme = catalog.themes.find(t => t.id === id); if (!theme) return;
    for (const [variable, color] of Object.entries(theme.colors)) { document.body.style.setProperty(variable, color); activeColors.push(variable); }
  }
  async function sync() { catalog = await api('/api/extensions'); AgentHubLocale.extend(catalog.languages || []); applyTheme(storageGet('ah.extensionTheme')); return catalog; }
  async function preferences() {
    openDlg('语言与主题', '<p class="feature-loading">读取语言与主题…</p>'); const guard = dialogGuard();
    try { const data = await sync(); if (!guard()) return;
      $('#dlgBody').innerHTML = `<div class="fld"><label>界面语言</label><select id="localeSelect">${AgentHubLocale.catalog().map(l => `<option value="${esc(l.id)}" ${l.id === AgentHubLocale.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div><div class="fld"><label>扩展主题</label><select id="extensionTheme"><option value="">使用原有主题</option>${data.themes.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div><p class="dialog-note">中文、英文、阿拉伯语覆盖主要导航与工作流程按钮。缺失的已登记词条回退到英文，未收录词条保留原文。任务内容与代码保持原文。</p><button class="btn" id="localeSave">应用</button>`;
      $('#extensionTheme').value = storageGet('ah.extensionTheme') || '';
      $('#localeSave').onclick = () => { const locale = $('#localeSelect').value, theme = $('#extensionTheme').value; storageSet('ah.extensionTheme', theme); applyTheme(theme); AgentHubLocale.set(locale); closeDlg(); };
    } catch (e) { if (guard()) toast(e.message, 'err'); }
  }
  async function extensions() {
    openDlg('本地扩展', '<p class="feature-loading">读取扩展…</p>'); const guard = dialogGuard();
    try { const data = await sync(); if (!guard()) return; const disabled = S.readOnly ? 'disabled' : '';
      $('#dlgBody').innerHTML = `<p class="dialog-note">扩展通过 manifest.json 提供主题、参数化任务模板、助手和语言字典。编辑已安装清单后会自动热重载；错误时保留上一次有效版本。</p><div class="feature-checklist">${data.extensions.map(e => `<article class="feature-panel"><div class="feature-row"><b data-i18n-ignore>${esc(e.name)} ${esc(e.version)}</b><label><input type="checkbox" data-extension-toggle="${esc(e.id)}" ${e.enabled ? 'checked' : ''} ${disabled}> 启用</label></div><p data-i18n-ignore>${esc(e.description)}</p><small data-i18n-ignore>${esc(e.path)}</small><p data-i18n-ignore>${esc(Object.entries(e.counts).map(([k,n]) => k + ': ' + n).join(' · '))}</p>${e.error ? `<p class="feature-error" data-i18n-ignore>${esc(e.error)}</p>` : ''}<div class="dialog-actions"><button class="btn ghost" data-extension-reload="${esc(e.id)}" ${disabled}>重新加载</button><button class="btn ghost" data-extension-remove="${esc(e.id)}" ${disabled}>移除</button></div></article>`).join('') || '<p class="dialog-note">暂无本地扩展</p>'}</div><h3>导入本地扩展</h3><div class="fld"><label>清单文件路径</label><input id="extensionPath" placeholder="C:\\project\\manifest.json"></div><label><input id="extensionEnable" type="checkbox"> 导入后启用</label><button class="btn" id="extensionImport" ${disabled}>导入</button><div class="dialog-actions"><button class="btn ghost" id="extensionsRefresh">刷新</button><button class="btn ghost" id="extensionsLocale">语言与主题</button></div>`;
      const mutate = async (id, input) => { try { const e = data.extensions.find(e => e.id === id); await api('/api/extensions/' + id, { method: 'PATCH', body: { ...input, expectedRevision: e.revision } }); await refreshData(); if (guard()) extensions(); } catch (e) { if (guard()) toast(e.message, 'err'); } };
      $$('#dlgBody [data-extension-toggle]').forEach(b => b.onchange = () => mutate(b.dataset.extensionToggle, { enabled: b.checked }));
      $$('#dlgBody [data-extension-remove]').forEach(b => b.onclick = () => mutate(b.dataset.extensionRemove, { remove: true }));
      $$('#dlgBody [data-extension-reload]').forEach(b => bindDialogAction(b, async () => { try { await api('/api/extensions/' + b.dataset.extensionReload + '/reload', { method: 'POST', body: {} }); await refreshData(); if (guard()) extensions(); } catch (e) { if (guard()) toast(e.message, 'err'); } }, '读取中…'));
      bindDialogAction('#extensionImport', async () => { try { await api('/api/extensions', { method: 'POST', body: { path: $('#extensionPath').value, enabled: $('#extensionEnable').checked } }); await refreshData(); if (guard()) extensions(); } catch (e) { if (guard()) toast(e.message, 'err'); } }, '导入中…');
      $('#extensionsRefresh').onclick = extensions; $('#extensionsLocale').onclick = preferences;
    } catch (e) { if (guard()) toast(e.message, 'err'); }
  }
  AgentHubFeatures.register('extensions', '本地扩展', '主题、助手、任务模板、语言字典与热重载', extensions, '工作环境');
  AgentHubFeatures.register('language', '语言与主题', '中文、英文、阿拉伯语、翻译回退与 RTL', preferences, '工作环境');
  Object.assign(AgentHubFeatures, { extensions, preferences });
  window.addEventListener('agenthub.extensions.changed', () => { sync().then(() => refreshData()).catch(() => {}); });
  new MutationObserver(() => { if (activeColors.length) { storageSet('ah.extensionTheme', ''); applyTheme(''); } }).observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });
  sync().catch(() => {});
})();
