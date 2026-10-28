(() => {
  async function artifacts() {
    const s = curSession(); if (!s) return toast('先打开一个任务', 'err');
    openDlg('交互成果', '<p class="feature-loading">读取成果…</p>'); const guard = dialogGuard();
    try { const data = await api('/api/html-artifacts?sessionId=' + encodeURIComponent(s.id)); if (!guard()) return;
      $('#dlgBody').innerHTML = `<div class="feature-checklist">${data.artifacts.map(a => `<div class="feature-row"><b>${esc(a.title)}</b><button class="btn ghost" data-html-open="${a.id}">预览</button><button class="btn ghost" data-html-remove="${a.id}" ${S.readOnly ? 'disabled' : ''}>删除</button></div>`).join('') || '<p class="dialog-note">暂无交互成果。Agent 可调用 html_render 创建，或在下方粘贴 HTML。</p>'}</div><div id="artifactViewer"></div><div class="fld"><label>名称</label><input id="artifactTitle" value="交互成果"></div><div class="fld"><label>自包含 HTML</label><textarea id="artifactHtml" rows="6" placeholder="可包含内联脚本与样式"></textarea></div><button class="btn" id="artifactPublish" ${S.readOnly ? 'disabled' : ''}>保存并预览</button>`;
      const show = id => { $('#artifactViewer').innerHTML = htmlArtifactHtml(data.artifacts.find(a => a.id === id) || { id, title: $('#artifactTitle').value }); renderHtmlArtifacts($('#artifactViewer')); };
      $$('#dlgBody [data-html-open]').forEach(b => b.onclick = () => show(b.dataset.htmlOpen));
      $$('#dlgBody [data-html-remove]').forEach(b => b.onclick = async () => { try { const a = data.artifacts.find(a => a.id === b.dataset.htmlRemove); await api('/api/html-artifacts/' + a.id + '?revision=' + a.revision, { method: 'DELETE' }); if (guard()) artifacts(); } catch (e) { if (guard()) toast(e.message, 'err'); } });
      bindDialogAction('#artifactPublish', async () => { try { const a = await api('/api/sessions/' + encodeURIComponent(s.id) + '/html-artifacts', { method: 'POST', body: { title: $('#artifactTitle').value, html: $('#artifactHtml').value } }); if (guard()) show(a.id); } catch (e) { if (guard()) toast(e.message, 'err'); } }, '保存中…');
    } catch (e) { if (guard()) toast(e.message, 'err'); }
  }
  async function speechSettings() {
    openDlg('语音转写', '<p class="feature-loading">读取配置…</p>'); const guard = dialogGuard();
    try { const cfg = await api('/api/speech/config'); if (!guard()) return;
      $('#dlgBody').innerHTML = `<p class="dialog-note">录音发送到选定供应商的 OpenAI 兼容转写接口，返回文字加入草稿。单段录音最多 8MB。</p><label><input id="speechEnabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> 使用供应商语音转写</label><div class="fld"><label>供应商</label><select id="speechProvider"><option value="">独立语音接口</option>${S.providers.map(p => `<option value="${esc(p.id)}" ${p.id === cfg.providerId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div><div class="fld"><label>模型</label><input id="speechModel" value="${esc(cfg.model || 'whisper-1')}"></div><div class="fld"><label>独立接口地址（留空使用供应商）</label><input id="speechBase" value="${esc(cfg.baseUrl || '')}"></div><div class="fld"><label>独立 Key（留空保留已有 Key）</label><input type="password" id="speechKey" placeholder="${esc(cfg.apiKey || '')}"></div><div class="fld"><label>语言（留空自动识别）</label><input id="speechLanguage" value="${esc(cfg.language || '')}" placeholder="zh / en"></div><button class="btn" id="speechSave" ${S.readOnly ? 'disabled' : ''}>保存</button>`;
      bindDialogAction('#speechSave', async () => { try { await api('/api/speech/config', { method: 'PUT', body: { enabled: $('#speechEnabled').checked, providerId: $('#speechProvider').value, model: $('#speechModel').value, baseUrl: $('#speechBase').value, apiKey: $('#speechKey').value || undefined, language: $('#speechLanguage').value } }); if (guard()) { closeDlg(); initialize(); toast('语音转写已配置', 'ok'); } } catch (e) { if (guard()) toast(e.message, 'err'); } }, '保存中…');
    } catch (e) { if (guard()) toast(e.message, 'err'); }
  }
  let recorder, stream, nativeButton;
  async function initialize() {
    const btn = $('#btnMic'); if (!btn) return;
    const cfg = await api('/api/speech/config').catch(() => ({}));
    if (!nativeButton) nativeButton = { onclick: btn.onclick, title: btn.title, display: btn.style.display, disabled: btn.disabled };
    if (!cfg.enabled) { btn.onclick = nativeButton.onclick; btn.title = nativeButton.title; btn.style.display = nativeButton.display; btn.disabled = S.readOnly || nativeButton.disabled; return; }
    btn.style.display = ''; btn.disabled = S.readOnly; btn.title = '供应商语音转写';
    btn.onclick = async () => {
      if (S.readOnly) return;
      if (recorder) { recorder.stop(); return; }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('当前浏览器不支持录音', 'err');
      const origin = composerDraftActiveKey || composerDraftKey(); const parts = []; let bytes = 0;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true }); recorder = new MediaRecorder(stream); const r = recorder;
        r.ondataavailable = e => { parts.push(e.data); bytes += e.data.size; if (bytes > 8 * 1024 * 1024 && r.state === 'recording') r.stop(); };
        r.onerror = () => { toast('录音失败', 'err'); r.stop(); };
        r.onstop = async () => {
          stream?.getTracks().forEach(t => t.stop()); stream = null; recorder = null; btn.classList.remove('listening');
          if (bytes > 8 * 1024 * 1024) return toast('录音超过 8MB，请缩短录音', 'err');
          btn.disabled = true;
          try { const blob = new Blob(parts, { type: r.mimeType }); const encoded = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(blob); });
            const result = await api('/api/speech/transcribe', { method: 'POST', timeoutMs: 125000, body: { audio: encoded, mime: blob.type } });
            if ((composerDraftActiveKey || composerDraftKey()) === origin) { $('#inpText').value += result.text; autoGrow(); saveComposerDraft(); }
            else preserveDraft(result.text, []);
          } catch (e) { toast('转写失败：' + e.message, 'err'); } finally { btn.disabled = S.readOnly; }
        };
        r.start(1000); btn.classList.add('listening');
      } catch (e) { recorder = null; stream?.getTracks().forEach(t => t.stop()); toast('无法录音：' + e.message, 'err'); }
    };
  }
  AgentHubFeatures.register('artifacts', '交互成果', '保存与预览可运行脚本的 HTML 沙盒', artifacts);
  AgentHubFeatures.register('speech', '语音转写', '配置供应商与语音模型，录音转为草稿', speechSettings, '内容工具');
  Object.assign(AgentHubFeatures, { artifacts, speechSettings }); window.AgentHubMedia = { initialize };
})();
