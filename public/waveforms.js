(() => {
  let ready;
  const tags = new Set(['svg','g','defs','path','rect','line','polyline','polygon','circle','ellipse','text','tspan','title','desc','use','clipPath','mask','pattern','style']);
  function safeSvg(markup) {
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml'), svg = doc.documentElement;
    if (svg.localName !== 'svg' || doc.querySelector('parsererror')) throw Error('波形 SVG 无效');
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      if (!tags.has(el.localName)) { el.remove(); continue; }
      if (el.localName === 'style' && /@import|url\s*\(|expression\s*\(/i.test(el.textContent)) { el.remove(); continue; }
      for (const a of [...el.attributes]) {
        if (/^on/i.test(a.name) || /^(?:href|xlink:href)$/i.test(a.name) && !/^#[\w:.-]+$/.test(a.value) || /(?:url\s*\(\s*[^#]|expression\s*\(|javascript:|@import)/i.test(a.value)) el.removeAttribute(a.name);
      }
    }
    return document.importNode(svg, true);
  }
  function render(root) {
    const boxes = [...root.querySelectorAll('.waveform-box:not([data-wave-done])')]; if (!boxes.length) return;
    if (!ready) ready = Promise.all([loadScriptOnce('/vendor/wavedrom.min.js'), loadScriptOnce('/vendor/json5.min.js')]).catch(e => { ready = null; throw e; });
    for (const box of boxes) {
      box.dataset.waveDone = 'pending';
      ready.then(() => {
        if (!box.isConnected) return;
        const text = box.querySelector('.waveform-source').textContent, dst = box.querySelector('.waveform-render');
        try {
          if (text.length > 64000) throw Error('波形数据最多 64,000 字符');
          const data = window.JSON5.parse(text); let nodes = 0, waveLength = 0;
          function check(v, depth = 0) { if (depth > 24 || ++nodes > 12000) throw Error('波形数据过于复杂'); if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > 10000)) throw Error('波形数值超出范围'); if (v && typeof v === 'object') for (const [k,x] of Object.entries(v)) { if (['__proto__','constructor','prototype'].includes(k)) throw Error('波形属性无效'); if (k === 'wave' && typeof x === 'string') { waveLength += x.length; if (x.length > 2048 || waveLength > 12000) throw Error('波形长度超出范围'); } if (k === 'hscale' && (!Number.isFinite(x) || x < 1 || x > 10)) throw Error('hscale 范围为 1–10'); check(x, depth + 1); } }
          check(data);
          if (!data || typeof data !== 'object' || !Array.isArray(data.signal || data.reg || data.assign)) throw Error('使用包含 signal、reg 或 assign 数组的 WaveJSON');
          const output = window.wavedrom.renderAny(0, data, structuredClone(window.wavedrom.waveSkin), false);
          const svg = safeSvg(window.wavedrom.onml.stringify(output)); (dst.shadowRoot || dst.attachShadow({ mode: 'open' })).replaceChildren(svg); box.dataset.waveDone = 'done';
          const save = document.createElement('button'); save.className = 'btn ghost'; save.textContent = '下载 SVG';
          save.onclick = () => { const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' })), a = document.createElement('a'); a.href = url; a.download = 'waveform.svg'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }; box.appendChild(save);
        } catch (e) { box.dataset.waveDone = 'error'; dst.textContent = '波形无法渲染：' + e.message; box.querySelector('details').open = true; }
      }).catch(e => { box.dataset.waveDone = 'error'; box.querySelector('.waveform-render').textContent = '波形组件加载失败：' + e.message; });
    }
  }
  window.AgentHubWaveforms = { render };
})();
