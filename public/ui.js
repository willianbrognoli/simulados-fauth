'use strict';
/* Utilitários compartilhados por todas as telas */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ESTRELA = '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 0 L56 44 L100 50 L56 56 L50 100 L44 56 L0 50 L44 44 Z"/></svg>';

async function api(url, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let d = {};
  try { d = await r.json(); } catch {}
  if (r.status === 401 && !opts.semRedirect) { location.href = '/'; throw new Error('Sessão expirada'); }
  if (!r.ok) { const e = new Error(d.erro || 'Erro inesperado. Tente novamente.'); e.status = r.status; e.dados = d; throw e; }
  return d;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');

let _toastT;
function toast(msg, tipo = '') {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'toast on ' + tipo;
  clearTimeout(_toastT);
  _toastT = setTimeout(() => t.classList.remove('on'), 3800);
}

function cpfValido(cpf) {
  cpf = String(cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(cpf[i]) * (n + 1 - i);
    if ((soma * 10) % 11 % 10 !== Number(cpf[n])) return false;
  }
  return true;
}
function mascaraCPF(v) {
  v = v.replace(/\D/g, '').slice(0, 11);
  return v.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}
function mascaraTel(v) {
  v = v.replace(/\D/g, '').slice(0, 11);
  if (v.length <= 2) return v;
  if (v.length <= 6) return `(${v.slice(0, 2)}) ${v.slice(2)}`;
  if (v.length <= 10) return `(${v.slice(0, 2)}) ${v.slice(2, 6)}-${v.slice(6)}`;
  return `(${v.slice(0, 2)}) ${v.slice(2, 7)}-${v.slice(7)}`;
}

function fmtDur(seg) {
  seg = seg || 0;
  const h = Math.floor(seg / 3600), m = Math.floor(seg % 3600 / 60);
  return h ? `${h}h${pad(m)}` : `${m} min`;
}
const fmtData = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

// número subindo animado
function contar(el, alvo, ms = 1200, sufixo = '') {
  if (!el) return;
  const ini = performance.now();
  const passo = t => {
    const p = Math.min(1, (t - ini) / ms), e = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(alvo * e) + sufixo;
    if (p < 1) requestAnimationFrame(passo);
  };
  requestAnimationFrame(passo);
}

// estrelas da marca piscando no fundo
function estrelas(box, n = 18) {
  if (!box) return;
  let h = '';
  for (let i = 0; i < n; i++) {
    const s = 6 + Math.random() * 16;
    h += `<span class="star" style="left:${Math.random() * 100}%;top:${Math.random() * 100}%;width:${s}px;height:${s}px;--d:${4 + Math.random() * 6}s;--dl:${-Math.random() * 8}s;--o:${0.35 + Math.random() * 0.55}">${ESTRELA}</span>`;
  }
  box.innerHTML = h;
}

// revela elementos .rv ao rolar
function revelar() {
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
  $$('.rv:not(.in)').forEach(el => io.observe(el));
}

// anel de nota
const CIRC = 2 * Math.PI * 52;
function anel(box, valor, max) {
  box.innerHTML = `<svg viewBox="0 0 120 120"><defs><linearGradient id="gO" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD171"/><stop offset="1" stop-color="#E5B95C"/></linearGradient></defs>
    <circle class="bg" cx="60" cy="60" r="52" fill="none" stroke-width="10"/>
    <circle class="fg" cx="60" cy="60" r="52" fill="none" stroke-width="10" stroke="url(#gO)" stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/></svg>
    <div class="ct"><b>0</b><span>nota líquida</span></div>`;
  const pct = Math.max(0, Math.min(1, valor / max));
  requestAnimationFrame(() => setTimeout(() => { $('.fg', box).style.strokeDashoffset = CIRC * (1 - pct); }, 120));
  const b = $('.ct b', box);
  if (valor < 0) b.textContent = valor; else contar(b, valor, 1500);
}

// classificação de desempenho por tema
function classe(p) {
  if (p >= 80) return { c: 'ok', t: 'Dominado' };
  if (p >= 60) return { c: 'ok', t: 'Bom caminho' };
  if (p >= 40) return { c: 'mid', t: 'Atenção' };
  return { c: 'bad', t: 'Prioridade' };
}

// barras por tema (+ tendência em relação à prova anterior)
function renderTemas(box, porTema, temas, anterior) {
  const ordem = Object.keys(temas).filter(t => porTema[t]);
  box.innerHTML = ordem.map(t => {
    const x = porTema[t], p = Math.round(x.certos / x.total * 100), k = classe(p);
    let tend = '';
    if (anterior && anterior[t]) {
      const pa = Math.round(anterior[t].certos / anterior[t].total * 100);
      if (p > pa) tend = `<span class="tend up">▲ ${p - pa}</span>`;
      else if (p < pa) tend = `<span class="tend down">▼ ${pa - p}</span>`;
    }
    return `<div class="tema"><span class="nm">${esc(t)} <span class="tag ${k.c}">${k.t}</span></span><span class="pc">${p}% ${tend}</span>
      <div class="barra"><i class="${k.c}" data-w="${p}"></i></div>
      <small>${x.certos} certo(s) · ${x.errados} errado(s) · ${x.brancos} em branco · ${esc(x.materia)}</small></div>`;
  }).join('');
  setTimeout(() => $$('.barra i[data-w]', box).forEach(i => i.style.width = Math.max(3, i.dataset.w) + '%'), 150);
}

// pontos fortes e o que estudar
function renderFoco(boxBem, boxMal, porTema, temas) {
  const lista = Object.keys(porTema).map(t => ({ t, p: Math.round(porTema[t].certos / porTema[t].total * 100), x: porTema[t] }));
  const bem = lista.filter(l => l.p >= 60).sort((a, b) => b.p - a.p).slice(0, 3);
  const mal = lista.filter(l => l.p < 60).sort((a, b) => a.p - b.p).slice(0, 4);
  boxBem.innerHTML = bem.length ? bem.map(l => `<li><span class="n">${l.p}%</span><div><b>${esc(l.t)}</b><span>${l.x.certos} de ${l.x.total} itens certos. Continue revisando para manter.</span></div></li>`).join('')
    : '<li><div><b>Ainda nenhum tema acima de 60%</b><span>Faça a revisão do gabarito comentado e tente de novo amanhã.</span></div></li>';
  boxMal.innerHTML = mal.length ? mal.map(l => `<li><span class="n">${l.p}%</span><div><b>${esc(l.t)}</b><span>${esc((temas[l.t] || {}).dica || '')}</span></div></li>`).join('')
    : '<li><div><b>Nenhum tema abaixo de 60%</b><span>Excelente! Agora o foco é velocidade e reduzir os erros, que descontam ponto.</span></div></li>';
}

// confete nas cores da marca
function confete(ms = 2600) {
  const cv = document.createElement('canvas');
  cv.className = 'confete';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const W = cv.width = innerWidth, H = cv.height = innerHeight;
  const cores = ['#FFD171', '#E5B95C', '#1749b5', '#3b78ff', '#ffffff', '#031636'];
  const ps = Array.from({ length: 160 }, () => ({ x: W / 2 + (Math.random() - .5) * 200, y: H * .35, vx: (Math.random() - .5) * 14, vy: -Math.random() * 14 - 4, s: 5 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - .5) * .3, c: cores[Math.random() * cores.length | 0] }));
  const ini = performance.now();
  (function quadro(t) {
    ctx.clearRect(0, 0, W, H);
    ps.forEach(p => { p.vy += .35; p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); });
    if (t - ini < ms) requestAnimationFrame(quadro); else cv.remove();
  })(ini);
}
