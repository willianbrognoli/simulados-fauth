'use strict';
let P = null, idx = 0, desvio = 0, timer = null;
let iniciou = false, encerrando = false, ignorarAte = 0, ultimaSaida = 0, salvoT;

const temFS = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const emFS = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
async function pedirFS() {
  if (!temFS) return;
  ignorarAte = Date.now() + 1500; // a própria transição de tela cheia não conta como saída
  const el = document.documentElement;
  await (el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen());
}
function sairFS() {
  try { if (emFS()) (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {}
}

estrelas($('#gate .stars'), 20);

// ---------- carregamento ----------
async function carregar() {
  try {
    P = await api('/api/tentativas/atual');
  } catch (e) {
    if (e.status === 404) {
      const id = e.dados && e.dados.ultimaId;
      location.replace(id ? `/resultado?id=${id}` : '/painel');
      return;
    }
    toast(e.message, 'erro');
    return;
  }
  desvio = Date.now() - new Date(P.agora).getTime();
  const jaComecou = Object.keys(P.respostas).length > 0 || P.saidas > 0;
  if (jaComecou) {
    $('#gate-tit').innerHTML = 'Sua prova está <em>em andamento.</em>';
    $('#gate-sub').textContent = `Você já respondeu ${Object.keys(P.respostas).length} itens e tem ${P.saidas} de ${P.maxSaidas} saídas registradas.`;
  }
  $('#gate-btn').textContent = jaComecou ? 'Retomar a prova em tela cheia' : 'Entrar em tela cheia e começar';
  $('#gate-btn').disabled = false;
  marcaDagua();
  montarMapa();
  atualizarSaidas();
  iniciarTimer();
  iniciarRitmo();
  vigiar();
}

$('#gate-btn').addEventListener('click', async () => {
  try { await pedirFS(); } catch { return toast('Permita a tela cheia para fazer a prova.', 'erro'); }
  iniciou = true;
  $('#gate').classList.add('oculto');
  document.body.classList.remove('blur-prova');
  const primeiraEmBranco = P.questoes.findIndex(q => !P.respostas[q.id]);
  mostrar(primeiraEmBranco === -1 ? 0 : primeiraEmBranco);
});

// ---------- vigilância anti-cola ----------
function vigiar() {
  document.addEventListener('visibilitychange', () => { if (document.hidden) saida('trocou-de-aba'); });
  window.addEventListener('blur', () => saida('saiu-da-janela'));
  const aoMudarFS = () => { if (temFS && iniciou && !emFS()) saida('saiu-da-tela-cheia'); };
  document.addEventListener('fullscreenchange', aoMudarFS);
  document.addEventListener('webkitfullscreenchange', aoMudarFS);
  window.addEventListener('pagehide', () => {
    if (!encerrando) navigator.sendBeacon('/api/tentativas/atual/violacao', JSON.stringify({ tipo: 'fechou-ou-recarregou' }));
  });
}

async function saida(tipo) {
  if (encerrando || Date.now() < ignorarAte) return;
  document.body.classList.add('blur-prova');
  if (iniciou) abrirAviso(null);
  const agora = Date.now();
  if (agora - ultimaSaida < 2500) { if (iniciou) abrirAviso({}); return; } // vários eventos da mesma saída
  ultimaSaida = agora;
  try {
    const r = await api('/api/tentativas/atual/violacao', { method: 'POST', body: { tipo } });
    if (r.encerrada) return ir(r.id);
    P.saidas = r.saidas;
    atualizarSaidas();
    if (iniciou) abrirAviso(r);
  } catch { if (iniciou) abrirAviso({}); }
}

function abrirAviso(r) {
  const rest = P.maxSaidas - P.saidas;
  $('#av-txt').innerHTML = r === null
    ? 'Registrando a saída…'
    : `A saída foi registrada <b>(${P.saidas} de ${P.maxSaidas})</b>. ` +
      (rest <= 1 ? '<b>Na próxima saída, a prova será entregue automaticamente.</b>' : `Restam ${rest} avisos antes da entrega automática.`);
  $('#m-aviso').classList.add('on');
}
$('#av-ok').addEventListener('click', async () => {
  try { await pedirFS(); } catch {}
  $('#m-aviso').classList.remove('on');
  document.body.classList.remove('blur-prova');
});

function atualizarSaidas() {
  const el = $('#saidas');
  el.textContent = `Saídas: ${P.saidas}/${P.maxSaidas}`;
  el.className = 'saidas' + (P.saidas >= P.maxSaidas - 1 ? ' s2' : P.saidas > 0 ? ' s1' : '');
}

// bloqueios de cópia, impressão e ferramentas
['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'dragstart'].forEach(ev => document.addEventListener(ev, e => e.preventDefault()));
document.addEventListener('keydown', e => {
  const k = (e.key || '').toLowerCase();
  const bloq = ((e.ctrlKey || e.metaKey) && ['c', 'x', 'v', 'a', 'p', 's', 'u', 'f', 'g'].includes(k))
    || ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c', 's'].includes(k))
    || k === 'f12' || k === 'printscreen';
  if (bloq) { e.preventDefault(); e.stopPropagation(); toast('Ação bloqueada durante a prova.', 'erro'); return; }
  if (!iniciou || encerrando || $('.modal.on') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'c') responder('C');
  else if (k === 'e') responder('E');
  else if (k === 'arrowright') mostrar(idx + 1);
  else if (k === 'arrowleft') mostrar(idx - 1);
});
document.addEventListener('keyup', e => {
  if (e.key === 'PrintScreen' && navigator.clipboard) navigator.clipboard.writeText('').catch(() => {});
});

// marca d'água com nome e CPF do aluno (inibe prints e fotos)
function marcaDagua() {
  let h = '';
  for (let r = 0; r < 9; r++) for (let c = 0; c < 4; c++) h += `<span style="top:${r * 12 + 1}%;left:${c * 30 - 8 + (r % 2) * 14}%">${esc(P.marca)}</span>`;
  $('.marca').innerHTML = h;
}

// ---------- cronômetro (sempre pelo relógio do servidor) ----------
function iniciarTimer() {
  const fim = new Date(P.expiraEm).getTime();
  const tick = () => {
    const r = fim - (Date.now() - desvio);
    if (r <= 0) {
      clearInterval(timer);
      $('#tempo b').textContent = '00:00:00';
      toast('Tempo esgotado! Entregando sua prova…');
      entregar();
      return;
    }
    $('#tempo b').textContent = `${pad(Math.floor(r / 36e5))}:${pad(Math.floor(r % 36e5 / 6e4))}:${pad(Math.floor(r % 6e4 / 1e3))}`;
    $('#tempo').classList.toggle('alerta', r < 10 * 60e3);
  };
  tick();
  timer = setInterval(tick, 1000);
}

// ---------- ritmo por item (só treino: estourar o tempo não tem consequência) ----------
const gastoQ = {};   // ms gastos em cada item (soma de todas as visitas a ele)
let alvoQ = 0, ultTickQ = 0;
function iniciarRitmo() {
  alvoQ = Math.floor((P.duracaoSeg || 10800) / P.questoes.length) * 1000; // 3h / 80 = 2:15
  const s = alvoQ / 1000;
  $('#ritmo-gate').textContent = `${Math.floor(s / 60)}min${s % 60 ? pad(s % 60) + 's' : ''}`;
  ultTickQ = Date.now();
  setInterval(tickRitmo, 250);
}
function tickRitmo() {
  const agora = Date.now(), dt = agora - ultTickQ;
  ultTickQ = agora;
  // pausa com o portão, modal de aviso ou aba escondida
  if (!iniciou || encerrando || document.hidden || document.body.classList.contains('blur-prova')) return;
  const id = P.questoes[idx].id;
  gastoQ[id] = (gastoQ[id] || 0) + dt;
  pintarRitmo();
}
function pintarRitmo() {
  if (!alvoQ) return;
  const g = gastoQ[P.questoes[idx].id] || 0, r = alvoQ - g;
  const seg = r > 0 ? Math.ceil(r / 1000) : Math.floor(-r / 1000);
  const el = $('#qtimer');
  $('#qtimer b').textContent = (r > 0 ? '' : '+') + `${Math.floor(seg / 60)}:${pad(seg % 60)}`;
  $('#qtimer small').textContent = r > 0 ? 'Tempo do item' : 'Acima do ritmo';
  el.classList.toggle('quase', r > 0 && r <= 20000);
  el.classList.toggle('passou', r <= 0);
  el.style.setProperty('--p', Math.min(1, g / alvoQ));
}

// ---------- itens ----------
function montarMapa() {
  let h = '', mat = '';
  P.questoes.forEach((q, i) => {
    if (q.materia !== mat) { if (mat) h += '</div>'; mat = q.materia; h += `<h4>${esc(mat)}</h4><div class="grade">`; }
    h += `<button data-i="${i}" aria-label="Item ${q.n}">${q.n}</button>`;
  });
  $('#mapa').innerHTML = h + '</div>';
  $('#mapa').addEventListener('click', e => { const b = e.target.closest('button'); if (b) mostrar(Number(b.dataset.i)); });
}

function mostrar(i) {
  idx = Math.max(0, Math.min(P.questoes.length - 1, i));
  const q = P.questoes[idx];
  const card = $('#qcard');
  card.classList.remove('anima'); void card.offsetWidth; card.classList.add('anima');
  $('#q-num').textContent = `Item ${q.n} de ${P.questoes.length}`;
  $('#q-mat').textContent = q.materia;
  $('#q-txt').innerHTML = fmt(q.texto);
  $('#prev').disabled = idx === 0;
  $('#next').textContent = idx === P.questoes.length - 1 ? 'Revisar e entregar' : 'Próximo →';
  estado();
  pintarRitmo();
  if (innerWidth < 900) scrollTo({ top: 0, behavior: 'smooth' });
}

function estado() {
  const q = P.questoes[idx], r = P.respostas[q.id];
  $$('.resp').forEach(b => b.classList.toggle('on', b.dataset.r === r));
  const bs = $$('#mapa button');
  P.questoes.forEach((x, i) => { bs[i].className = (P.respostas[x.id] || '') + (i === idx ? ' atual' : ''); });
  const n = Object.keys(P.respostas).length, pc = Math.round(n / P.questoes.length * 100);
  $('#prog-txt').textContent = `${n} de ${P.questoes.length} respondidos`;
  $('#prog-pc').textContent = pc + '%';
  $('#prog i').style.width = pc + '%';
}

function responder(r) {
  const q = P.questoes[idx];
  salvar(q.id, P.respostas[q.id] === r ? null : r); // clicar de novo desmarca
}

async function salvar(qid, resp) {
  const ant = P.respostas[qid];
  if (resp) P.respostas[qid] = resp; else delete P.respostas[qid];
  estado();
  try {
    await api('/api/tentativas/atual/resposta', { method: 'PUT', body: { qid, resp } });
    const s = $('#salvo');
    s.textContent = resp ? '✓ resposta salva' : '✓ item em branco';
    s.classList.add('on');
    clearTimeout(salvoT);
    salvoT = setTimeout(() => s.classList.remove('on'), 1400);
  } catch (e) {
    if (e.dados && e.dados.encerrada) return ir(e.dados.id);
    if (ant) P.respostas[qid] = ant; else delete P.respostas[qid];
    estado();
    toast('Não foi possível salvar. Verifique sua internet e tente de novo.', 'erro');
  }
}

$$('.resp').forEach(b => b.addEventListener('click', () => responder(b.dataset.r)));
$('#limpar').addEventListener('click', () => { const q = P.questoes[idx]; if (P.respostas[q.id]) salvar(q.id, null); });
$('#prev').addEventListener('click', () => mostrar(idx - 1));
$('#next').addEventListener('click', () => idx === P.questoes.length - 1 ? abrirEntrega() : mostrar(idx + 1));

// ---------- entrega ----------
function abrirEntrega() {
  const n = Object.keys(P.respostas).length, b = P.questoes.length - n;
  $('#ent-txt').innerHTML = `Você respondeu <b>${n}</b> de ${P.questoes.length} itens${b ? ` e deixou <b>${b}</b> em branco` : ''}. Depois de entregar, não é possível voltar.`;
  $('#m-entregar').classList.add('on');
}
$('#bt-entregar').addEventListener('click', abrirEntrega);
$$('[data-fechar]').forEach(b => b.addEventListener('click', () => b.closest('.modal').classList.remove('on')));
$('#ent-ok').addEventListener('click', () => { $('#ent-ok').disabled = true; entregar(); });

async function entregar() {
  if (encerrando) return;
  encerrando = true;
  try {
    const r = await api('/api/tentativas/atual/finalizar', { method: 'POST' });
    ir(r.id);
  } catch (e) {
    encerrando = false;
    $('#ent-ok').disabled = false;
    toast(e.message, 'erro');
  }
}

function ir(id) {
  encerrando = true;
  clearInterval(timer);
  sairFS();
  location.replace(id ? `/resultado?id=${id}&novo=1` : '/painel');
}

carregar();
