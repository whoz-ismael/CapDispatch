// ─── DEBUG.JS ─────────────────────────────────────────────────────────────────
// Consola de depuración visible en pantalla para iPad.
// Intercepta console.log/warn/error y peticiones fetch a Supabase.
// Eliminar el <script> de index.html cuando ya no se necesite.

(function () {
  const logs = [];
  let panelOpen = false;

  // ─── INTERCEPTAR CONSOLE ───────────────────────────────────────────────────
  ['log', 'warn', 'error', 'info'].forEach(level => {
    const original = console[level].bind(console);
    console[level] = function (...args) {
      original(...args);
      const text = args.map(a => {
        try { return typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a); }
        catch { return String(a); }
      }).join(' ');
      addLog(level, text);
    };
  });

  // ─── INTERCEPTAR FETCH ────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const short  = String(url).replace('https://cyzrxztodzivbxrivkot.supabase.co/rest/v1/', '');
    addLog('info', `→ ${method} ${short}`);
    try {
      const response = await originalFetch(url, options);
      const clone    = response.clone();
      clone.text().then(body => {
        const color = response.ok ? 'log' : 'error';
        addLog(color, `← ${response.status} ${short}\n${body.slice(0, 300)}`);
      });
      return response;
    } catch (err) {
      addLog('error', `✗ FETCH FALLÓ: ${short}\n${err.message}`);
      throw err;
    }
  };

  // ─── INTERCEPTAR ERRORES GLOBALES ─────────────────────────────────────────
  window.addEventListener('error', e => {
    addLog('error', `JS ERROR: ${e.message}\n${e.filename}:${e.lineno}`);
  });

  window.addEventListener('unhandledrejection', e => {
    addLog('error', `PROMISE: ${String(e.reason)}`);
  });

  // ─── ALMACENAR LOG ────────────────────────────────────────────────────────
  function addLog(level, text) {
    logs.push({ level, text, time: new Date().toLocaleTimeString('es-DO') });
    if (logs.length > 200) logs.shift();
    if (panelOpen) renderLogs();
    updateBadge();
  }

  // ─── CREAR UI ─────────────────────────────────────────────────────────────
  function createUI() {
    // Botón flotante
    const btn = document.createElement('button');
    btn.id = 'debug-btn';
    btn.innerHTML = '🛠';
    btn.style.cssText = `
      position: fixed;
      bottom: 80px;
      right: 16px;
      z-index: 9999;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: #1e293b;
      color: white;
      font-size: 18px;
      border: none;
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    // Badge de errores
    const badge = document.createElement('span');
    badge.id = 'debug-badge';
    badge.style.cssText = `
      position: fixed;
      bottom: 116px;
      right: 12px;
      z-index: 10000;
      background: #ef4444;
      color: white;
      font-size: 10px;
      font-weight: bold;
      border-radius: 999px;
      padding: 1px 5px;
      display: none;
      pointer-events: none;
    `;

    // Panel
    const panel = document.createElement('div');
    panel.id = 'debug-panel';
    panel.style.cssText = `
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: 55vh;
      background: #0f172a;
      z-index: 9998;
      display: none;
      flex-direction: column;
      border-top: 2px solid #334155;
      font-family: 'Courier New', monospace;
    `;

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #1e293b;flex-shrink:0;">
        <span style="color:#94a3b8;font-size:12px;font-weight:bold;">CONSOLA DE DEPURACIÓN</span>
        <div style="display:flex;gap:8px;">
          <button id="debug-clear" style="background:#334155;color:#94a3b8;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;">Limpiar</button>
          <button id="debug-close" style="background:#334155;color:#94a3b8;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;">Cerrar</button>
        </div>
      </div>
      <div id="debug-logs" style="flex:1;overflow-y:auto;padding:8px;"></div>
    `;

    document.body.appendChild(btn);
    document.body.appendChild(badge);
    document.body.appendChild(panel);

    btn.addEventListener('click', () => {
      panelOpen = !panelOpen;
      panel.style.display = panelOpen ? 'flex' : 'none';
      if (panelOpen) {
        renderLogs();
        // Scroll al final
        setTimeout(() => {
          const logsEl = document.getElementById('debug-logs');
          if (logsEl) logsEl.scrollTop = logsEl.scrollHeight;
        }, 50);
      }
    });

    document.getElementById('debug-close').addEventListener('click', () => {
      panelOpen = false;
      panel.style.display = 'none';
    });

    document.getElementById('debug-clear').addEventListener('click', () => {
      logs.length = 0;
      renderLogs();
      updateBadge();
    });
  }

  function updateBadge() {
    const badge  = document.getElementById('debug-badge');
    if (!badge) return;
    const errors = logs.filter(l => l.level === 'error').length;
    if (errors > 0) {
      badge.textContent = errors;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }

  function renderLogs() {
    const el = document.getElementById('debug-logs');
    if (!el) return;

    const colors = {
      log:   '#e2e8f0',
      info:  '#38bdf8',
      warn:  '#fbbf24',
      error: '#f87171',
    };

    el.innerHTML = logs.map(log => `
      <div style="margin-bottom:6px;border-bottom:1px solid #1e293b;padding-bottom:6px;">
        <span style="color:#475569;font-size:10px;">${log.time}</span>
        <span style="color:${colors[log.level] || '#e2e8f0'};font-size:10px;margin-left:4px;text-transform:uppercase;font-weight:bold;">[${log.level}]</span>
        <pre style="color:${colors[log.level] || '#e2e8f0'};font-size:11px;margin:2px 0 0;white-space:pre-wrap;word-break:break-all;font-family:inherit;">${escapeHtml(log.text)}</pre>
      </div>
    `).join('');

    el.scrollTop = el.scrollHeight;
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Esperar a que el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createUI);
  } else {
    createUI();
  }

  addLog('info', '🛠 Consola de depuración lista');
})();
