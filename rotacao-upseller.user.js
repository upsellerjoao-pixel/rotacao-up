// ==UserScript==
// @name         Rotação Upseller — Indisponibilidade
// @namespace    upseller.rotacao
// @version      5.2.0
// @description  Controla status no SalesSmartly (online/ocupado/indisponível), registra motivos e tempos no painel da Rotação Upseller.
// @author       Upseller
// @match        *://*.salesmartly.com/*
// @match        *://*.salessmartly.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      mqmfddozbqdujcbjbuqm.supabase.co
// @connect      api.salesmartly.com
// @updateURL    https://raw.githubusercontent.com/upsellerjoao-pixel/rotacao-up/main/rotacao-upseller.user.js
// @downloadURL  https://raw.githubusercontent.com/upsellerjoao-pixel/rotacao-up/main/rotacao-upseller.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════
  // CONFIG — mesmo projeto Supabase do painel da Rotação
  // ══════════════════════════════════════════════════════════
  const SB_URL     = 'https://mqmfddozbqdujcbjbuqm.supabase.co';
  const SB_KEY     = 'sb_publishable_N9empCAKa-IOpo1iUVO0tA_mHrszSgh';
  const SB_KEY_SVC = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1xbWZkZG96YnFkdWpjYmpidXFtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjMxNTA5MSwiZXhwIjoyMDkxODkxMDkxfQ.23staoKFRDTJn1APIH27-8jOrq0Uw57mxFSaWNgEYFw';

  // Motivos de PAUSA (fica Ocupado no SalesSmartly, mas continua disponível no painel)
  // "sub" = lista de subtipos que aparece num 2º menu ao escolher o motivo.
  const MOTIVOS_PAUSA = [
    { id: 'anydesk',  label: '🖥️ AnyDesk' },
    { id: 'banheiro', label: '🚻 Banheiro' },
    { id: 'chamado',  label: '🎫 Chamado', sub: ['Abertura', 'Atualização', 'Solicitação de informações', 'Retorno'] },
    { id: 'pausa',    label: '☕ Pausa / Café' },
    { id: 'outro',    label: '✏️ Outro (especificar)' }
  ];
  // Motivos de INDISPONÍVEL (fica Desconectado no SalesSmartly e sai da rotação no painel)
  const MOTIVOS_INDISP = [
    { id: 'treino',    label: '🎓 Treinamento / Capacitação' },
    { id: 'almoco',    label: '🍽️ Almoço' },
    { id: 'subtarefa', label: '📌 Subtarefa', sub: ['Divulgação', 'Criação de grupos', 'UPD', 'FAQs', 'E-mails', 'Reclame Aqui', 'Outros'] },
    { id: 'fim',       label: '🏁 Fim de expediente' },
    { id: 'outro',     label: '✏️ Outro (especificar)' }
  ];
  const LABEL_MOTIVO = {};
  [...MOTIVOS_PAUSA, ...MOTIVOS_INDISP].forEach(m => { LABEL_MOTIVO[m.id] = m.label; });

  // online_status: 1 = Conectado, 2 = Ocupado, 0 = Desconectado (confirmado no DevTools)
  const VALOR = { Conectado: 1, Ocupado: 2, Desconectado: 0 };

  // Só roda no topo (evita rodar dentro de iframes irrelevantes), mas se o
  // chat estiver num iframe, ele também tem window.top !== window — então
  // deixamos rodar em qualquer frame que tenha o localStorage do SalesSmartly.
  let temChave = false;
  try { temChave = !!localStorage.getItem('LOCAL_KEY_IN_WEBSITE'); } catch (e) {}
  const ehTopo = (window.top === window.self);
  // Se não é o topo e não tem a chave, não faz nada neste frame.
  if (!ehTopo && !temChave) return;

  // ══════════════════════════════════════════════════════════
  // Helpers Supabase (via GM_xmlhttpRequest — sem CORS)
  // ══════════════════════════════════════════════════════════
  // Registra na linha do tempo de status (historico_status): fecha o período
  // aberto e abre um novo. Usado para calcular horas online/ocupado/indisponível.
  async function registrarStatus(status, motivo, motivoTexto) {
    try {
      await sbReq('PATCH', `historico_status?colaborador_id=eq.${usuario.id}&fim=is.null`, { fim: new Date().toISOString() }, true);
      await sbReq('POST', 'historico_status', {
        colaborador_id: usuario.id, status,
        motivo: motivo || null, motivo_texto: motivoTexto || null, origem: 'extensao'
      }, true);
    } catch (e) { /* não bloqueia a troca de status */ }
  }

  function sbReq(method, path, body, useSvc) {
    return new Promise((resolve) => {
      const key = useSvc ? SB_KEY_SVC : SB_KEY;
      GM_xmlhttpRequest({
        method,
        url: SB_URL + '/rest/v1/' + path,
        headers: {
          'apikey': key,
          'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json',
          'Prefer': method === 'GET' ? '' : 'return=minimal'
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          let j = null;
          try { j = JSON.parse(r.responseText || 'null'); } catch (e) {}
          resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: j });
        },
        onerror: () => resolve({ ok: false, status: 0, json: null })
      });
    });
  }

  // ══════════════════════════════════════════════════════════
  // Mudar status no SalesSmartly (roda DENTRO da página → tem CPL)
  // ══════════════════════════════════════════════════════════
  function descobrir() {
    let pid = null, hya = null;
    try {
      const urls = performance.getEntriesByType('resource').map(e => e.name).filter(u => /salesmartly/.test(u));
      for (const u of urls) {
        let m;
        if (!pid && (m = u.match(/[?&]project_id=(\d+)/))) pid = m[1];
        if (!pid && (m = u.match(/[?&]_xma_=(\d+)/)))       pid = m[1];
        if (!hya && (m = u.match(/[?&]_hya_=(\d+)/)))        hya = m[1];
      }
    } catch (e) {}
    let cpl = null;
    try { cpl = localStorage.getItem('LOCAL_KEY_IN_WEBSITE'); } catch (e) {}
    return { pid, hya, cpl };
  }

  function mudarStatusSales(estado) {
    return new Promise((resolve) => {
      const valor = VALOR[estado];
      if (valor === undefined) return resolve({ ok: false, motivo: 'estado inválido' });
      const { pid, hya, cpl } = descobrir();
      if (!pid) return resolve({ ok: false, motivo: 'não achei project_id (abra o chat primeiro)' });
      if (!cpl) return resolve({ ok: false, motivo: 'não achei o CPL no localStorage' });

      const ts = Date.now();
      const url = 'https://api.salesmartly.com/sys/project/user-list/online-switch' +
        '?_xma_=' + pid + '&project_id=' + pid + (hya ? '&_hya_=' + hya : '') + '&_ta_=' + ts;
      const body = 'online_status=' + valor + '&event_type=0&project_id=' + pid;

      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.setRequestHeader('client-type', 'pc');
        xhr.setRequestHeader('CPL', cpl);
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          let j = {};
          try { j = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
          const ok = xhr.status >= 200 && xhr.status < 300 &&
            (j.code === 0 || j.code === 200 || j.success === true || j.status === 0 ||
             j.msg === 'success' || Object.keys(j).length === 0);
          if (ok) resolve({ ok: true });
          else resolve({ ok: false, motivo: 'API code=' + (j.code !== undefined ? j.code : '?') + ' ' + (j.msg || ('HTTP ' + xhr.status)) });
        };
        xhr.onerror = () => resolve({ ok: false, motivo: 'erro de rede' });
        xhr.send(body);
      } catch (e) {
        resolve({ ok: false, motivo: e.message });
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  // Sessão (login) — guardada no localStorage do userscript
  // ══════════════════════════════════════════════════════════
  const SES_KEY = 'upseller_us_session';
  function getSessao() { try { return JSON.parse(localStorage.getItem(SES_KEY) || 'null'); } catch (e) { return null; } }
  function setSessao(u) { try { localStorage.setItem(SES_KEY, JSON.stringify(u)); } catch (e) {} }
  function limparSessao() { try { localStorage.removeItem(SES_KEY); } catch (e) {} }

  // ── Foto personalizada do colaborador (link ou arquivo) ──
  function fotoKey() { return 'upseller_foto_' + (usuario ? usuario.id : 'anon'); }
  function getFoto() { try { return localStorage.getItem(fotoKey()) || ''; } catch (e) { return ''; } }
  function setFoto(v) { try { v ? localStorage.setItem(fotoKey(), v) : localStorage.removeItem(fotoKey()); } catch (e) {} aplicarFab(); }
  function inicialUsuario() { const nm = usuario ? (usuario.apelido || usuario.nome || '?') : '?'; return (nm[0] || '?').toUpperCase(); }

  // Estilo visual por estado: cor do anel/brilho e classe do FAB
  const ESTILO_ESTADO = {
    ativo:   { ring:'#22c55e', glow:'rgba(34,197,94,.75)',  fab:'',     label:'Online',       sub:'Conectado e atendendo' },
    pausado: { ring:'#f59e0b', glow:'rgba(245,158,11,.75)', fab:'busy', label:'Ocupado',      sub:'Presente, fora da fila' },
    indisp:  { ring:'#ef4444', glow:'rgba(239,68,68,.7)',   fab:'off',  label:'Indisponível', sub:'Fora do ambiente' }
  };
  let estadoAtualFab = 'ativo';

  // Aplica a foto (ou inicial) e a cor de status no botão flutuante
  function aplicarFab() {
    if (!fab) return;
    const foto = getFoto();
    if (foto) { fab.style.backgroundImage = `url("${foto}")`; fab.textContent = ''; }
    else { fab.style.backgroundImage = 'none'; fab.textContent = inicialUsuario(); }
    fab.className = (ESTILO_ESTADO[estadoAtualFab] || ESTILO_ESTADO.ativo).fab;
  }

  let usuario = getSessao();
  // motivoSel declarado adiante

  // ══════════════════════════════════════════════════════════
  // UI — botão flutuante + painel
  // ══════════════════════════════════════════════════════════
  const css = `
    /* ── COCKPIT PESSOAL — base ── */
    #ups-fab { position: fixed; bottom: 24px; right: 76px; z-index: 2147483647;
      width: 54px; height: 54px; border-radius: 50%; cursor: grab;
      background:#141b2a center/cover no-repeat; color:#cfe0ff; border:3px solid #22c55e;
      display:flex; align-items:center; justify-content:center; font-size:22px; font-weight:600;
      box-shadow:0 0 0 2px #0b0f18, 0 0 16px rgba(34,197,94,.65), 0 8px 20px rgba(0,0,0,.45);
      transition: transform .15s, box-shadow .2s, border-color .2s; padding:0; overflow:hidden; }
    #ups-fab:hover { transform: scale(1.07); }
    #ups-fab.busy { border-color:#f59e0b; box-shadow:0 0 0 2px #0b0f18, 0 0 16px rgba(245,158,11,.65), 0 8px 20px rgba(0,0,0,.45); }
    #ups-fab.off  { border-color:#ef4444; box-shadow:0 0 0 2px #0b0f18, 0 0 16px rgba(239,68,68,.6), 0 8px 20px rgba(0,0,0,.45); }

    #ups-panel { position: fixed; bottom: 86px; right: 24px; z-index: 2147483646;
      width: 288px; min-width: 248px; max-width: 560px;
      min-height: 180px; max-height: calc(100vh - 28px); overflow: auto; resize: both;
      background:#0e1320; color:#e8edf7; border:1px solid #1f2a3e;
      border-radius:18px; box-shadow:0 18px 50px rgba(0,0,0,.55); padding:16px 16px 14px;
      font-family:'Segoe UI',system-ui,-apple-system,sans-serif; display:none;
      background-image: radial-gradient(130% 70% at 50% -10%, rgba(37,99,235,.14), transparent 60%); }
    /* alça de redimensionar (canto inferior direito) mais visível no tema escuro */
    #ups-panel::-webkit-resizer {
      background:
        linear-gradient(135deg, transparent 0 48%, #46577a 48% 56%, transparent 56% 66%, #46577a 66% 74%, transparent 74% 84%, #46577a 84% 92%, transparent 92%); }
    #ups-panel.open { display:block; }

    .ups-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
    .ups-brand { display:flex; align-items:center; gap:7px; font-size:12px; color:#8294b0; font-weight:500; }
    .ups-brand .b-dot { width:14px; height:14px; border-radius:5px; background:linear-gradient(135deg,#2563eb,#0891b2); }
    .ups-gear { background:none; border:none; color:#5e6f8c; cursor:pointer; font-size:14px; padding:4px; border-radius:6px; }
    .ups-gear:hover { color:#cfe0ff; background:#17202f; }

    /* avatar + anel de status */
    .ups-ava-wrap { position:relative; width:104px; height:104px; margin:10px auto 0; }
    .ups-ring { position:absolute; inset:0; border-radius:50%; padding:4px;
      background: var(--ring,#22c55e); box-shadow:0 0 20px var(--glow,rgba(34,197,94,.7)); }
    @keyframes upsPulse { 0%,100%{ box-shadow:0 0 16px var(--glow,rgba(34,197,94,.6)); } 50%{ box-shadow:0 0 30px var(--glow,rgba(34,197,94,.9)); } }
    .ups-ring.live { animation: upsPulse 2.6s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce){ .ups-ring.live{ animation:none; } }
    .ups-ava { position:absolute; inset:4px; border-radius:50%; background:#1a2230 center/cover no-repeat; z-index:2;
      display:flex; align-items:center; justify-content:center; font-size:36px; font-weight:600; color:#9fb0cc; overflow:hidden; }
    .ups-edit { position:absolute; bottom:0; right:4px; width:28px; height:28px; border-radius:50%; z-index:3;
      background:#2563eb; border:3px solid #0e1320; color:#fff; display:flex; align-items:center; justify-content:center;
      cursor:pointer; font-size:12px; }
    .ups-edit:hover { background:#1d4ed8; }

    .ups-statusword { text-align:center; font-size:19px; font-weight:600; margin-top:12px; letter-spacing:.2px; }
    .ups-timer { text-align:center; font-family:ui-monospace,'SF Mono',Consolas,monospace; font-size:12px; color:#7b8aa6; margin-top:3px; }

    /* controles de status (lista estilo console) */
    .ups-acts { margin-top:16px; display:flex; flex-direction:column; gap:8px; }
    .ups-act { display:flex; align-items:center; gap:11px; width:100%; text-align:left;
      background:#141b29; border:1px solid #1f2a3e; border-left:3px solid var(--bar,#22c55e);
      border-radius:0 11px 11px 0; padding:11px 13px; cursor:pointer; color:#e8edf7;
      font-size:13px; font-weight:500; font-family:inherit; transition:background .15s, transform .08s; }
    .ups-act:hover { background:#1a2436; }
    .ups-act:active { transform:scale(.99); }
    .ups-act .a-ico { font-size:15px; line-height:1; }
    .ups-act .a-sub { font-size:11px; color:#7b8aa6; font-weight:400; margin-top:1px; }
    .ups-act.atual { outline:1px solid var(--bar,#22c55e); background:#17202f; }

    .ups-gestor { margin-top:14px; padding-top:12px; border-top:1px solid #1b2537; }
    .ups-gestor .g-tit { font-size:11px; color:#5e6f8c; margin-bottom:8px; display:flex; align-items:center; gap:6px; }

    /* botões genéricos (login, confirmar, distribuir) */
    .ups-btn { width:100%; border:none; border-radius:11px; padding:11px; font-size:13px; font-weight:600;
      cursor:pointer; margin-top:10px; color:#fff; font-family:inherit; transition:filter .15s; }
    .ups-btn:hover { filter:brightness(1.08); }
    .ups-btn.primary { background:linear-gradient(135deg,#2563eb,#0891b2); }
    .ups-btn.red { background:#ef4444; }
    .ups-btn.green { background:#22c55e; }
    .ups-btn.amber { background:#f59e0b; }
    .ups-btn.ghost { background:transparent; border:1px solid #1f2a3e; color:#8294b0; margin-top:8px; font-weight:500; }

    #ups-panel h3 { font-size:15px; margin:0 0 2px; font-weight:600; }
    #ups-panel .sub { font-size:11px; color:#7b8aa6; margin-bottom:12px; }
    #ups-panel label { display:block; font-size:11px; color:#7b8aa6; margin:10px 0 5px; }
    #ups-panel input, #ups-panel select { width:100%; box-sizing:border-box; background:#121a28; border:1px solid #1f2a3e;
      border-radius:9px; padding:10px 12px; color:#e8edf7; font-size:13px; outline:none; font-family:inherit; }
    #ups-panel input:focus, #ups-panel select:focus { border-color:#2563eb; }

    .ups-status { display:flex; align-items:center; gap:9px; background:#121a28; border:1px solid #1f2a3e;
      border-radius:11px; padding:10px 12px; margin-bottom:12px; }
    .ups-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
    .ups-dot.on { background:#22c55e; box-shadow:0 0 8px rgba(34,197,94,.6); }
    .ups-dot.off { background:#ef4444; }
    .ups-dot.busy { background:#f59e0b; box-shadow:0 0 8px rgba(245,158,11,.6); }

    .ups-motivos { display:flex; flex-direction:column; gap:5px; }
    .ups-motivo { display:flex; align-items:center; gap:9px; background:#121a28; border:1px solid #1f2a3e;
      border-radius:10px; padding:9px 11px; cursor:pointer; font-size:13px; }
    .ups-motivo.sel { border-color:#2563eb; background:rgba(37,99,235,.14); }
    .ups-radio { width:15px; height:15px; border-radius:50%; border:2px solid #5e6f8c; flex-shrink:0; }
    .ups-motivo.sel .ups-radio { border-color:#2563eb; background:#2563eb; box-shadow:inset 0 0 0 3px #121a28; }
    #ups-outro { display:none; margin-top:8px; }

    .ups-msg { font-size:12px; padding:9px 11px; border-radius:9px; margin-top:10px; display:none; }
    .ups-msg.err { background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.3); color:#fca5a5; display:block; }
    .ups-msg.ok  { background:rgba(34,197,94,.12); border:1px solid rgba(34,197,94,.3); color:#86efac; display:block; }
    .ups-foot { font-size:10px; color:#5e6f8c; text-align:center; margin-top:12px; }
    .ups-foot a { color:#8294b0; cursor:pointer; text-decoration:underline; }
    .ups-hidden { display:none !important; }

    /* editor de foto */
    .ups-foto-editor { margin-top:12px; background:#121a28; border:1px solid #1f2a3e; border-radius:11px; padding:12px; }
  `;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const fab = document.createElement('button');
  fab.id = 'ups-fab'; fab.title = 'Rotação Upseller — arraste para mover, clique para abrir';
  document.body.appendChild(fab);
  aplicarFab();

  const panel = document.createElement('div');
  panel.id = 'ups-panel';
  document.body.appendChild(panel);

  // ── Posição salva do botão (arrastável) ──
  (function restaurarPosFab() {
    try {
      const p = JSON.parse(localStorage.getItem('upseller_fab_pos') || 'null');
      if (p && typeof p.left === 'number' && typeof p.top === 'number') {
        fab.style.left = p.left + 'px';
        fab.style.top  = p.top + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        posicionarPainel();
      }
    } catch (e) {}
  })();

  // ── Tamanho do painel (cada colaborador redimensiona e fica salvo) ──
  (function restaurarTamanhoPainel() {
    try {
      const s = JSON.parse(localStorage.getItem('upseller_panel_size') || 'null');
      if (s && s.w) panel.style.width = s.w + 'px';
      if (s && s.h) panel.style.height = s.h + 'px';
    } catch (e) {}
  })();
  // Salva o tamanho sempre que o usuário termina de arrastar a alça (pointerup com o painel aberto).
  // Só lê width/height inline — que vêm do resize nativo —, então mudanças de conteúdo não poluem.
  document.addEventListener('pointerup', () => {
    if (!panel.classList.contains('open')) return;
    const w = parseInt(panel.style.width, 10), h = parseInt(panel.style.height, 10);
    if (w || h) { try { localStorage.setItem('upseller_panel_size', JSON.stringify({ w: w || null, h: h || null })); } catch (e) {} }
  });

  function posicionarPainel() {
    // Ancora o painel ao lado do botão SEM cobri-lo, para o botão continuar clicável.
    const r = fab.getBoundingClientRect();
    const margem = 10, pw = 288;
    // horizontal: centraliza no botão, mas sem sair da tela
    let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    // vertical: se há espaço abaixo do botão, abre abaixo; senão abre acima
    // (ancorado por bottom, então cresce para cima e nunca cobre o botão)
    const espacoAbaixo = window.innerHeight - r.bottom;
    if (espacoAbaixo >= 420) {
      panel.style.top = (r.bottom + margem) + 'px';
      panel.style.bottom = 'auto';
    } else {
      panel.style.bottom = (window.innerHeight - r.top + margem) + 'px';
      panel.style.top = 'auto';
    }
  }

  // ── Arrastar o botão (distingue clique de arraste) ──
  let _dragging = false, _moved = false, _offX = 0, _offY = 0;
  fab.addEventListener('pointerdown', (e) => {
    _dragging = true; _moved = false;
    const r = fab.getBoundingClientRect();
    _offX = e.clientX - r.left; _offY = e.clientY - r.top;
    fab.setPointerCapture(e.pointerId);
    fab.style.cursor = 'grabbing';
  });
  fab.addEventListener('pointermove', (e) => {
    if (!_dragging) return;
    const dx = Math.abs(e.clientX - (fab.getBoundingClientRect().left + _offX));
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) _moved = true;
    let left = e.clientX - _offX, top = e.clientY - _offY;
    left = Math.min(Math.max(4, left), window.innerWidth - 56);
    top  = Math.min(Math.max(4, top), window.innerHeight - 56);
    fab.style.left = left + 'px'; fab.style.top = top + 'px';
    fab.style.right = 'auto'; fab.style.bottom = 'auto';
  });
  fab.addEventListener('pointerup', (e) => {
    if (!_dragging) return;
    _dragging = false;
    fab.style.cursor = 'grab';
    if (_moved) {
      // salvar posição
      const r = fab.getBoundingClientRect();
      try { localStorage.setItem('upseller_fab_pos', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })); } catch (e2) {}
    } else {
      // foi um clique → abre/fecha o painel
      posicionarPainel();
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) render();
    }
  });

  // Fecha (minimiza) o painel ao clicar fora dele e fora do botão.
  document.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('open')) return;
    if (panel.contains(e.target) || fab.contains(e.target)) return;
    panel.classList.remove('open');
  }, true);
  // Esc também fecha
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('open')) panel.classList.remove('open');
  });

  function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render() {
    if (!usuario) { renderLogin(); return; }
    renderApp();
  }

  function renderLogin() {
    panel.innerHTML = `
      <h3>🔄 Rotação Upseller</h3>
      <div class="sub">Entre com sua conta da Rotação</div>
      <label>E-mail</label>
      <input id="ups-email" type="email" placeholder="seu@email.com">
      <label>Senha</label>
      <input id="ups-senha" type="password" placeholder="••••••••">
      <button class="ups-btn primary" id="ups-entrar">Entrar</button>
      <div class="ups-msg" id="ups-lmsg"></div>`;
    const btn = panel.querySelector('#ups-entrar');
    const msg = panel.querySelector('#ups-lmsg');
    panel.querySelector('#ups-senha').addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
    btn.onclick = async () => {
      const email = panel.querySelector('#ups-email').value.trim().toLowerCase();
      const senha = panel.querySelector('#ups-senha').value.trim();
      msg.className = 'ups-msg';
      if (!email || !senha) { msg.className = 'ups-msg err'; msg.textContent = 'Preencha e-mail e senha.'; return; }
      btn.disabled = true; btn.textContent = 'Entrando...';
      const r = await sbReq('GET',
        `colaboradores?email=eq.${encodeURIComponent(email)}&senha=eq.${encodeURIComponent(senha)}&select=id,nome,apelido,email,ativo,is_gestor,is_super_gestor&limit=1`,
        null, false);
      btn.disabled = false; btn.textContent = 'Entrar';
      if (!r.ok || !r.json || !r.json.length) { msg.className = 'ups-msg err'; msg.textContent = 'E-mail ou senha incorretos.'; return; }
      if (r.json[0].ativo === false) { msg.className = 'ups-msg err'; msg.textContent = 'Conta inativa.'; return; }
      usuario = r.json[0]; setSessao(usuario); aplicarFab(); render();
    };
  }

  // Estado atual: lê do painel (disponivel_hoje) e do SalesSmartly (online_status local)
  async function statusPainel() {
    const r = await sbReq('GET', `colaboradores?id=eq.${usuario.id}&select=disponivel_hoje&limit=1`, null, false);
    return !(r.ok && r.json && r.json[0] && r.json[0].disponivel_hoje === false);
  }
  // Lê o online_status atual do SalesSmartly (pra saber se está Ocupado/Pausado)
  function statusSalesLocal() {
    // 0=desconectado, 1=conectado, 2=ocupado. Guardamos o último aplicado localmente.
    try {
      const v = localStorage.getItem('upseller_us_ultimo_estado');
      if (v === 'Conectado' || v === 'Ocupado' || v === 'Desconectado') return v;
    } catch (e) {}
    return null;
  }
  function setStatusSalesLocal(estado) {
    try { localStorage.setItem('upseller_us_ultimo_estado', estado); } catch (e) {}
  }

  let telaAtual = 'home'; // 'home' | 'pausa' | 'indisp'

  function tempoDesde(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? (h + 'h' + String(m).padStart(2,'0')) : (m + 'min');
  }

  async function renderApp() {
    // Estado atual: prioriza o registro aberto em historico_status (dá o "desde quando")
    let estado = 'ativo', inicioStatus = null;
    try {
      const open = await sbReq('GET', `historico_status?colaborador_id=eq.${usuario.id}&fim=is.null&select=status,inicio&order=inicio.desc&limit=1`, null, true);
      if (open.ok && open.json && open.json[0]) {
        const st = open.json[0].status;
        estado = st === 'online' ? 'ativo' : (st === 'ocupado' ? 'pausado' : 'indisp');
        inicioStatus = open.json[0].inicio;
      } else {
        const disp = await statusPainel();
        const ss = statusSalesLocal();
        estado = !disp ? 'indisp' : (ss === 'Ocupado' ? 'pausado' : 'ativo');
      }
    } catch (e) {
      const disp = await statusPainel().catch(() => true);
      estado = disp ? 'ativo' : 'indisp';
    }
    estadoAtualFab = estado;
    aplicarFab();

    if (telaAtual === 'pausa')  { renderMotivos('pausa');  return; }
    if (telaAtual === 'indisp') { renderMotivos('indisp'); return; }
    if (telaAtual === 'foto')   { renderEditorFoto();      return; }

    const E = ESTILO_ESTADO[estado];
    const foto = getFoto();
    const avaInner = foto
      ? `<div class="ups-ava" style="background-image:url('${foto.replace(/'/g,"%27")}')"></div>`
      : `<div class="ups-ava">${inicialUsuario()}</div>`;
    const tempo = inicioStatus ? ('há ' + tempoDesde(inicioStatus)) : '';

    panel.innerHTML = `
      <div class="ups-top">
        <span class="ups-brand"><span class="b-dot"></span> Rotação</span>
        <button class="ups-gear" id="ups-cfg" title="Trocar foto">⚙</button>
      </div>
      <div class="ups-ava-wrap" style="--ring:${E.ring};--glow:${E.glow};">
        <div class="ups-ring live"></div>
        ${avaInner}
        <div class="ups-edit" id="ups-foto-btn" title="Trocar foto / GIF">✎</div>
      </div>
      <div class="ups-statusword" style="color:${E.ring};">${E.label}</div>
      <div class="ups-timer">${tempo ? tempo + ' · ' : ''}${E.sub}</div>

      <div class="ups-acts">
        <button class="ups-act ${estado==='ativo'?'atual':''}" style="--bar:#22c55e" id="ups-b-ativo">
          <span class="a-ico">🟢</span><span><div>Conectar</div><div class="a-sub">${estado==='ativo'?'você já está online':'ficar online e na fila'}</div></span></button>
        <button class="ups-act ${estado==='pausado'?'atual':''}" style="--bar:#f59e0b" id="ups-b-pausa">
          <span class="a-ico">🟡</span><span><div>${estado==='pausado'?'Trocar motivo':'Pausar'}</div><div class="a-sub">ocupado, mantém os grupos</div></span></button>
        <button class="ups-act ${estado==='indisp'?'atual':''}" style="--bar:#ef4444" id="ups-b-indisp">
          <span class="a-ico">🔴</span><span><div>${estado==='indisp'?'Trocar motivo':'Ficar indisponível'}</div><div class="a-sub">sai da fila, gestor reajusta</div></span></button>
      </div>

      ${ehGestor() ? `
      <div class="ups-gestor">
        <div class="g-tit">⚙ Gestor</div>
        <button class="ups-btn primary" id="ups-b-distribuir">📥 Distribuir grupos</button>
        <div style="font-size:10px;color:#5e6f8c;margin-top:6px;line-height:1.4;">Ajuste o WhatsApp no site da Rotação; depois clique aqui.</div>
      </div>` : ''}
      <div class="ups-msg" id="ups-amsg"></div>
      <div class="ups-foot">${esc(usuario.apelido || usuario.nome)}${ehGestor() ? ' · gestor' : ''} · <a id="ups-sair">sair</a></div>`;

    panel.querySelector('#ups-sair').onclick = () => { limparSessao(); usuario = null; render(); };
    panel.querySelector('#ups-b-ativo').onclick  = () => aplicarAtivo();
    panel.querySelector('#ups-b-pausa').onclick  = () => { telaAtual = 'pausa'; renderMotivos('pausa'); };
    panel.querySelector('#ups-b-indisp').onclick = () => { telaAtual = 'indisp'; renderMotivos('indisp'); };
    panel.querySelector('#ups-cfg').onclick      = () => { telaAtual = 'foto'; renderEditorFoto(); };
    panel.querySelector('#ups-foto-btn').onclick = () => { telaAtual = 'foto'; renderEditorFoto(); };
    const bd = panel.querySelector('#ups-b-distribuir'); if (bd) bd.onclick = () => distribuirGrupos();
  }

  // Editor da foto/GIF do botão (link ou arquivo). Salva no navegador do colaborador.
  function renderEditorFoto() {
    const foto = getFoto();
    panel.innerHTML = `
      <div class="ups-top"><span class="ups-brand"><span class="b-dot"></span> Foto do botão</span></div>
      <div class="ups-ava-wrap" style="--ring:#2563eb;--glow:rgba(37,99,235,.55);margin-top:8px;">
        <div class="ups-ring"></div>
        ${foto ? `<div class="ups-ava" style="background-image:url('${foto.replace(/'/g,"%27")}')"></div>` : `<div class="ups-ava">${inicialUsuario()}</div>`}
      </div>
      <div class="ups-foto-editor">
        <label>Link de imagem ou GIF</label>
        <input id="ups-foto-url" placeholder="https://.../minha.gif" value="${foto && /^https?:/.test(foto) ? foto : ''}">
        <label>ou escolher do computador</label>
        <input id="ups-foto-file" type="file" accept="image/*">
        <div style="font-size:10px;color:#5e6f8c;margin-top:4px;">Dica: para GIF animado, use um link — fica mais leve.</div>
        <button class="ups-btn primary" id="ups-foto-salvar">Salvar</button>
        <button class="ups-btn ghost" id="ups-foto-remover">Remover foto</button>
        <button class="ups-btn ghost" id="ups-foto-voltar">‹ Voltar</button>
        <div class="ups-msg" id="ups-foto-msg"></div>
      </div>`;
    const msg = panel.querySelector('#ups-foto-msg');
    panel.querySelector('#ups-foto-voltar').onclick  = () => { telaAtual = 'home'; renderApp(); };
    panel.querySelector('#ups-foto-remover').onclick = () => { setFoto(''); telaAtual = 'home'; renderApp(); };
    panel.querySelector('#ups-foto-salvar').onclick  = () => {
      const url = panel.querySelector('#ups-foto-url').value.trim();
      if (url) { setFoto(url); telaAtual = 'home'; renderApp(); }
      else { msg.className = 'ups-msg err'; msg.textContent = 'Cole um link ou escolha um arquivo.'; }
    };
    panel.querySelector('#ups-foto-file').onchange = (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      if (f.size > 1500000) { msg.className = 'ups-msg err'; msg.textContent = 'Arquivo grande demais (máx ~1.5MB). Para GIF, use um link.'; return; }
      const rd = new FileReader();
      rd.onload = () => { setFoto(rd.result); telaAtual = 'home'; renderApp(); };
      rd.readAsDataURL(f);
    };
  }


  // Só gestor ou super-gestor vê o botão de distribuir grupos
  function ehGestor() {
    return !!(usuario && (usuario.is_gestor === true || usuario.is_super_gestor === true));
  }

  let motivoSel = null;
  let subSel = null; // subtipo escolhido (Chamado / Subtarefa)
  function renderMotivos(tipo) {
    const ehPausa = tipo === 'pausa';
    const lista = ehPausa ? MOTIVOS_PAUSA : MOTIVOS_INDISP;
    const titulo = ehPausa ? '🟡 Pausar (Ocupado)' : '🔴 Ficar Indisponível';
    const aviso = ehPausa
      ? 'Você fica Ocupado no SalesSmartly, mas mantém seus grupos.'
      : 'Você fica Desconectado. O gestor será avisado para reajustar a rotação.';
    motivoSel = null; subSel = null;
    panel.innerHTML = `
      <h3>${titulo}</h3>
      <div class="sub">${aviso}</div>
      <div style="font-size:12px;color:#94a3b8;margin:8px 0 6px;">Selecione o motivo:</div>
      <div class="ups-motivos">${lista.map(m => `<div class="ups-motivo" data-id="${m.id}"><span class="ups-radio"></span><span>${m.label}</span></div>`).join('')}</div>
      <div id="ups-sub-wrap" style="display:none;margin-top:8px;">
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;">Especifique:</div>
        <select id="ups-sub" style="width:100%;box-sizing:border-box;background:#111827;border:1px solid #1f2d45;border-radius:8px;padding:9px 12px;color:#f1f5f9;font-size:13px;outline:none;"></select>
      </div>
      <input id="ups-outro" placeholder="Descreva o motivo..." style="margin-top:8px;">
      <button class="ups-btn ${ehPausa?'amber':'red'}" id="ups-confirmar" disabled>${ehPausa?'Pausar':'Ficar indisponível'}</button>
      <button class="ups-btn ghost" id="ups-voltar-home">‹ Voltar</button>
      <div class="ups-msg" id="ups-amsg"></div>`;

    const outro = panel.querySelector('#ups-outro');
    const btnC = panel.querySelector('#ups-confirmar');
    const subWrap = panel.querySelector('#ups-sub-wrap');
    const subEl = panel.querySelector('#ups-sub');
    outro.style.display = 'none';
    panel.querySelectorAll('.ups-motivo').forEach(el => {
      el.onclick = () => {
        panel.querySelectorAll('.ups-motivo').forEach(x => x.classList.remove('sel'));
        el.classList.add('sel'); motivoSel = el.dataset.id; subSel = null;
        const m = lista.find(x => x.id === motivoSel);
        // Submenu de subtipos (Chamado / Subtarefa)
        if (m && m.sub && m.sub.length) {
          subEl.innerHTML = '<option value="">— selecione —</option>' + m.sub.map(sx => `<option value="${sx}">${sx}</option>`).join('');
          subWrap.style.display = 'block';
          subSel = '';
          subEl.onchange = () => { subSel = subEl.value; btnC.disabled = !subSel; };
          btnC.disabled = true; // precisa escolher o subtipo
        } else {
          subWrap.style.display = 'none';
        }
        // Campo de texto livre para "Outro"
        outro.style.display = motivoSel === 'outro' ? 'block' : 'none';
        if (motivoSel === 'outro') { outro.focus(); btnC.disabled = false; }
        else if (!m || !m.sub) { btnC.disabled = false; }
      };
    });
    panel.querySelector('#ups-voltar-home').onclick = () => { telaAtual = 'home'; renderApp(); };
    btnC.onclick = () => aplicarAusencia(tipo);
  }


  // ══════════════════════════════════════════════════════════
  // FASE 3 — SINCRONIZAR GRUPOS (painel decide, extensão aplica)
  // ══════════════════════════════════════════════════════════
  const CHANNEL_0317 = '12';          // channel do número 0317
  const LABEL_GP_SUPORTE = '6606142'; // id da etiqueta "GP Suporte" no SalesSmartly

  // Lê a lista de grupos do 0317 via API get-chat-list (sem depender do DOM).
  // Retorna [{ session_id, remark_name, numero }] só dos grupos de GP Suporte no 0317.
  function listarGruposSales() {
    return new Promise((resolve) => {
      const { pid, hya, cpl } = descobrir();
      if (!pid || !cpl) return resolve({ ok: false, motivo: 'faltam credenciais do SalesSmartly', grupos: [] });

      const ts = Date.now();
      const url = 'https://api.salesmartly.com/chat/chat/get-chat-list' +
        '?_xma_=' + pid + '&project_id=' + pid + (hya ? '&_hya_=' + hya : '') + '&_ta_=' + ts;

      // filtro reproduzindo o que o site envia (Grupos + canal 0317)
      const filter = JSON.stringify({
        filter_type: { value: '4', condition: 'contain', labelInValue: [{ value: '4', label: 'Grupos' }] },
        channel_list: { value: [CHANNEL_0317], condition: 'contain', filterAccounts: { '12': ['90484'] } },
        label_ids: { value: [LABEL_GP_SUPORTE], condition: 'and', labelInValue: [{ id: LABEL_GP_SUPORTE, label_name: 'GP Suporte', value: LABEL_GP_SUPORTE }] }
      });

      const todos = [];
      const pedirPagina = (page) => {
        const body = new URLSearchParams();
        body.set('sort_type', '1');
        body.set('keyword', '');
        body.set('filter', filter);
        body.set('chat_user_id', '');
        body.set('last_ids', '');
        body.set('page', String(page));
        body.set('page_size', '50');
        body.set('sort_time_field', 'last_reply_time');
        body.set('project_id', pid);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.setRequestHeader('client-type', 'pc');
        xhr.setRequestHeader('CPL', cpl);
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          let j = {};
          try { j = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
          const lista = (j && j.data && j.data.list) ? j.data.list : [];
          console.log('[Upseller] get-chat-list página', page, '→ status', xhr.status, '| code', j.code, '| msg', j.msg, '| itens', lista.length);
          if (page === 1 && lista.length) console.log('[Upseller] exemplo de grupo:', JSON.stringify(lista[0]).slice(0, 400));
          if (page === 1 && !lista.length) console.log('[Upseller] resposta crua:', (xhr.responseText||'').slice(0, 500));
          lista.forEach(g => {
            // só canal 0317 e que tenham apelido "Grupo N"
            if (String(g.channel) !== CHANNEL_0317) return;
            const remark = g.remark_name || '';
            const m = remark.match(/(\d+)/);
            if (!m) return; // sem número no apelido → ignora
            todos.push({ session_id: String(g.id), chat_user_id: String(g.chat_user_id || ''), remark_name: remark, numero: parseInt(m[1], 10) });
          });
          // se veio página cheia, tenta a próxima (até um limite de segurança)
          if (lista.length >= 50 && page < 20) { pedirPagina(page + 1); }
          else resolve({ ok: true, grupos: todos });
        };
        xhr.onerror = () => resolve({ ok: todos.length > 0, grupos: todos, motivo: 'erro parcial de rede' });
        xhr.send(body.toString());
      };
      pedirPagina(1);
    });
  }

  // Atribui um grupo (session_id) a um atendente (assign_sys_user_id) no SalesSmartly.
  function atribuirGrupoSales(sessionId, assignSysUserId, chatUserId) {
    return new Promise((resolve) => {
      const { pid, hya, cpl } = descobrir();
      if (!pid || !cpl) return resolve({ ok: false });
      const ts = Date.now();
      const url = 'https://api.salesmartly.com/chat/chat-user/reassign-session' +
        '?_xma_=' + pid + '&project_id=' + pid + (hya ? '&_hya_=' + hya : '') + '&_ta_=' + ts;
      const body = new URLSearchParams();
      body.set('session_id', String(sessionId));
      if (chatUserId) body.set('chat_user_id', String(chatUserId)); // OBRIGATÓRIO — sem ele dá erro
      body.set('assign_sys_user_id', String(assignSysUserId));
      body.set('type', '2');
      body.set('session_status', 'active');
      body.set('project_id', pid);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      xhr.setRequestHeader('client-type', 'pc');
      xhr.setRequestHeader('CPL', cpl);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        let j = {};
        try { j = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        resolve({ ok: xhr.status >= 200 && xhr.status < 300 && (j.code === 0 || j.code === 200 || j.msg === 'success' || Object.keys(j).length === 0), resp: j });
      };
      xhr.onerror = () => resolve({ ok: false });
      xhr.send(body.toString());
    });
  }

  // Espera o painel terminar de redistribuir (ele roda ao mudar disponibilidade).
  function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Núcleo da sincronização: lê a decisão do painel (grupos_whatsapp.colaborador_id),
  // casa com os grupos do SalesSmartly por número, e monta a lista de mudanças.
  // Retorna { plano: [{numero, remark, session_id, donoNome, assignId}], semId: [...], semSales: [...] }
  async function montarPlanoSync() {
    // 1) decisão do painel: quem está com cada grupo agora
    const rg = await sbReq('GET', 'grupos_whatsapp?select=numero_grupo,colaborador_id&order=numero_grupo.asc', null, false);
    const grupos = (rg.ok && rg.json) ? rg.json : [];
    // 2) colaboradores com id_salessmartly
    const rc = await sbReq('GET', 'colaboradores?select=id,nome,apelido,id_salessmartly', null, false);
    const colabs = (rc.ok && rc.json) ? rc.json : [];
    const colabPorId = {};
    colabs.forEach(c => { colabPorId[c.id] = c; });
    // 3) grupos do SalesSmartly (0317)
    const rs = await listarGruposSales();
    const salesPorNumero = {};
    (rs.grupos || []).forEach(g => { salesPorNumero[g.numero] = g; });

    const plano = [], semId = [], semSales = [];
    for (const g of grupos) {
      if (!g.colaborador_id) continue;
      const dono = colabPorId[g.colaborador_id];
      const sales = salesPorNumero[g.numero_grupo];
      if (!sales) { semSales.push(g.numero_grupo); continue; }         // grupo não achado no SalesSmartly
      if (!dono || !dono.id_salessmartly) { semId.push({ numero: g.numero_grupo, nome: dono ? (dono.apelido||dono.nome) : '?' }); continue; }
      plano.push({
        numero: g.numero_grupo,
        remark: sales.remark_name,
        session_id: sales.session_id,
        chat_user_id: sales.chat_user_id,
        donoNome: dono.apelido || dono.nome,
        assignId: String(dono.id_salessmartly)
      });
    }
    return { plano, semId, semSales, okSales: rs.ok };
  }



  // Preview + execução da sincronização de grupos.
  // Mostra o que vai mudar e pede confirmação antes de atribuir no SalesSmartly.
  // Ação do GESTOR: distribui todos os grupos conforme a rotação do site.
  async function distribuirGrupos() {
    if (!ehGestor()) { alert('Apenas gestores podem distribuir grupos.'); return; }
    await sincronizarGrupos('Distribuição conforme o site da Rotação');
  }

  async function sincronizarGrupos(contexto) {
    panel.innerHTML = `
      <h3>🔄 Sincronizando grupos</h3>
      <div class="sub">${esc(contexto)} — calculando com base na Rotação...</div>
      <div style="text-align:center;padding:20px 0;color:#94a3b8;font-size:13px;">⏳ Lendo grupos do SalesSmartly...</div>`;

    let r;
    try { r = await montarPlanoSync(); }
    catch (e) { r = { plano: [], semId: [], semSales: [], okSales: false }; }

    if (!r.okSales) {
      panel.innerHTML = `
        <h3>🔄 Sincronizar grupos</h3>
        <div class="ups-msg err" style="display:block;">Não consegui ler os grupos do SalesSmartly. Recarregue a página e tente de novo.</div>
        <button class="ups-btn ghost" id="ups-back">‹ Voltar</button>`;
      panel.querySelector('#ups-back').onclick = () => { telaAtual='home'; renderApp(); };
      return;
    }

    if (!r.plano.length) {
      const avisos = [];
      if (r.semId.length) avisos.push(`${r.semId.length} grupo(s) sem ID do dono cadastrado no painel.`);
      if (r.semSales.length) avisos.push(`${r.semSales.length} grupo(s) do painel não encontrados no SalesSmartly.`);
      panel.innerHTML = `
        <h3>🔄 Grupos sincronizados</h3>
        <div class="sub">Nenhuma mudança necessária — tudo já está no lugar.</div>
        ${avisos.length ? `<div class="ups-msg err" style="display:block;">⚠️ ${avisos.join(' ')}</div>` : ''}
        <button class="ups-btn green" id="ups-back">✓ OK</button>`;
      panel.querySelector('#ups-back').onclick = () => { telaAtual='home'; renderApp(); };
      return;
    }

    // Monta o preview
    const listaHtml = r.plano.map(p =>
      `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:5px 0;border-bottom:1px solid #1f2d45;">
        <span style="color:#e2e8f0;">${esc(p.remark)}</span>
        <span style="color:#60a5fa;">→ ${esc(p.donoNome)}</span>
      </div>`).join('');
    const avisos = [];
    if (r.semId.length) avisos.push(`${r.semId.length} grupo(s) sem ID do dono — não serão atribuídos.`);
    if (r.semSales.length) avisos.push(`${r.semSales.length} grupo(s) não achados no SalesSmartly.`);

    panel.innerHTML = `
      <h3>🔄 Confirmar atribuição</h3>
      <div class="sub">${r.plano.length} grupo(s) serão atribuídos no SalesSmartly conforme a Rotação:</div>
      <div style="max-height:220px;overflow-y:auto;margin:8px 0;background:#111827;border:1px solid #1f2d45;border-radius:8px;padding:8px 10px;">${listaHtml}</div>
      ${avisos.length ? `<div class="ups-msg err" style="display:block;">⚠️ ${avisos.join(' ')}</div>` : ''}
      <button class="ups-btn green" id="ups-exec">✅ Confirmar e atribuir</button>
      <button class="ups-btn ghost" id="ups-cancel">Cancelar</button>`;

    panel.querySelector('#ups-cancel').onclick = () => { telaAtual='home'; renderApp(); };
    panel.querySelector('#ups-exec').onclick = async () => {
      const btn = panel.querySelector('#ups-exec'); btn.disabled = true;
      let feitos = 0, erros = 0;
      for (const p of r.plano) {
        btn.textContent = `Atribuindo ${feitos+1}/${r.plano.length}...`;
        const res = await atribuirGrupoSales(p.session_id, p.assignId, p.chat_user_id);
        if (res.ok) feitos++; else erros++;
        await esperar(350); // ritmo pra não sobrecarregar
      }
      panel.innerHTML = `
        <h3>✅ Concluído</h3>
        <div class="sub">${feitos} grupo(s) atribuído(s)${erros ? `, ${erros} com erro` : ''}.</div>
        <button class="ups-btn green" id="ups-back">✓ OK</button>`;
      panel.querySelector('#ups-back').onclick = () => { telaAtual='home'; renderApp(); };
    };
  }


  // ── 🟢 ATIVO ──
  async function aplicarAtivo() {
    const msg = panel.querySelector('#ups-amsg'); if (msg) msg.className = 'ups-msg';
    const btn = panel.querySelector('#ups-b-ativo'); if (btn) { btn.disabled = true; btn.textContent = 'Aplicando...'; }
    // painel: disponível
    const r1 = await sbReq('PATCH', `colaboradores?id=eq.${usuario.id}`, { disponivel_hoje: true }, true);
    // registra período ONLINE na linha do tempo
    await registrarStatus('online', null, null);
    // SalesSmartly: conectado
    const rs = await mudarStatusSales('Conectado');
    if (rs.ok) setStatusSalesLocal('Conectado');
    if (!r1.ok) { if (msg) { msg.className = 'ups-msg err'; msg.textContent = 'Erro ao atualizar o painel.'; } return; }
    if (msg) { msg.className = 'ups-msg ok'; msg.textContent = (rs.ok ? '✅ Você está ativo e conectado!' : '✅ Ativo no painel. ⚠️ SalesSmartly: ' + rs.motivo) + ' Atualizando página...'; }
    // F5 automático para garantir a troca de status na tela.
    setTimeout(() => location.reload(), 1400);
  }

  // ── 🟡 PAUSA (Ocupado) ou 🔴 INDISPONÍVEL ──
  async function aplicarAusencia(tipo) {
    const ehPausa = tipo === 'pausa';
    const msg = panel.querySelector('#ups-amsg'); msg.className = 'ups-msg';
    let texto = '';
    if (motivoSel === 'outro') {
      texto = panel.querySelector('#ups-outro').value.trim();
      if (!texto) { msg.className = 'ups-msg err'; msg.textContent = 'Descreva o motivo.'; return; }
    } else if (subSel) {
      texto = subSel; // subtipo escolhido (Chamado: Retorno, Subtarefa: E-mails, etc.)
    } else if (subSel === '') {
      msg.className = 'ups-msg err'; msg.textContent = 'Escolha a especificação.'; return;
    }
    const btn = panel.querySelector('#ups-confirmar'); btn.disabled = true; btn.textContent = 'Aplicando...';

    // Painel: PAUSA mantém disponível; INDISPONÍVEL marca indisponível (sai da rotação)
    const patchPainel = ehPausa ? { disponivel_hoje: true } : { disponivel_hoje: false };
    const r1 = await sbReq('PATCH', `colaboradores?id=eq.${usuario.id}`, patchPainel, true);

    // Registra o período na linha do tempo (ocupado ou indisponível)
    await registrarStatus(ehPausa ? 'ocupado' : 'indisponivel', motivoSel, texto || null);

    // SalesSmartly: PAUSA -> Ocupado; INDISPONÍVEL -> Desconectado
    const alvo = ehPausa ? 'Ocupado' : 'Desconectado';
    const rs = await mudarStatusSales(alvo);
    if (rs.ok) setStatusSalesLocal(alvo);

    if (!r1.ok) { msg.className = 'ups-msg err'; msg.textContent = 'Erro ao registrar no painel.'; return; }
    const nomeEstado = ehPausa ? 'Ocupado' : 'Desconectado';
    msg.className = 'ups-msg ok';
    msg.textContent = (rs.ok ? `✅ Registrado! SalesSmartly em ${nomeEstado}.` : `✅ Registrado no painel. ⚠️ SalesSmartly: ${rs.motivo}`) + ' Atualizando página...';
    // F5 automático para garantir que o status trocou de fato na tela do SalesSmartly.
    setTimeout(() => location.reload(), 1400);
  }


  console.log('[Upseller] Userscript v5.2.0 ativo — cockpit (foto + luz de status), fecha ao clicar fora, botão arrastável, painel redimensionável.');
})();
