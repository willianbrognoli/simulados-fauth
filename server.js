'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { QUESTOES, TEMAS } = require('./questoes');

// ---------------- configuração ----------------
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (SECRET.length < 32) {
  console.error('Defina a variável SESSION_SECRET com pelo menos 32 caracteres.');
  process.exit(1);
}

const DURACAO_SEG = 3 * 60 * 60;          // 3 horas de prova
const INTERVALO_MS = 24 * 60 * 60 * 1000; // 1 tentativa a cada 24h
const MAX_SAIDAS = 3;                     // na 3ª saída da tela a prova é entregue
const POR_ID = new Map(QUESTOES.map(q => [q.id, q]));
const TOTAL = QUESTOES.length;

// ---------------- utilitários ----------------
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
const mascararCPF = c => `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**`;
const nomeCurto = n => { const p = n.trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0]; };

const hmac = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function assinar(dados) {
  const p = Buffer.from(JSON.stringify(dados)).toString('base64url');
  return `${p}.${hmac(p)}`;
}
function verificar(tok) {
  if (!tok) return null;
  const [p, s] = tok.split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(hmac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() ? d : null;
  } catch { return null; }
}
function lerCookie(req, nome) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${nome}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function setSessao(res, alunoId) {
  const dias = 7;
  const tok = assinar({ id: alunoId, exp: Date.now() + dias * 864e5 });
  res.setHeader('Set-Cookie', `sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${dias * 86400}${PROD ? '; Secure' : ''}`);
}

function embaralhar(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Constitucional primeiro (como na prova real), Previdenciário depois; ordem sorteada dentro de cada bloco
function novaOrdem() {
  const cf = QUESTOES.filter(q => q.materia === 'Direito Constitucional').map(q => q.id);
  const pv = QUESTOES.filter(q => q.materia !== 'Direito Constitucional').map(q => q.id);
  return [...embaralhar(cf), ...embaralhar(pv)];
}

// limitador simples para login/cadastro
const limites = new Map();
setInterval(() => { const t = Date.now(); for (const [k, v] of limites) if (v.reset < t) limites.delete(k); }, 10 * 60e3).unref();
const limitar = (max, janelaMs) => (req, res, next) => {
  const k = req.ip + req.path, agora = Date.now(), r = limites.get(k);
  if (!r || r.reset < agora) { limites.set(k, { n: 1, reset: agora + janelaMs }); return next(); }
  if (++r.n > max) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  next();
};

const h = fn => (req, res, next) => fn(req, res).catch(next);
const erro = (res, msg, st = 400) => res.status(st).json({ erro: msg });

function auth(req, res, next) {
  const s = verificar(lerCookie(req, 'sid'));
  if (!s) return erro(res, 'Sessão expirada. Entre novamente.', 401);
  req.alunoId = s.id;
  next();
}

// ---------------- regras da prova ----------------
async function finalizar(db, t, motivo) {
  const resp = t.respostas || {};
  let certos = 0, errados = 0, brancos = 0;
  const porTema = {};
  for (const id of t.ordem) {
    const q = POR_ID.get(id);
    if (!q) continue;
    const pt = porTema[q.tema] || (porTema[q.tema] = { materia: q.materia, total: 0, certos: 0, errados: 0, brancos: 0 });
    pt.total++;
    const r = resp[id];
    if (r !== 'C' && r !== 'E') { brancos++; pt.brancos++; }
    else if (r === q.gabarito) { certos++; pt.certos++; }
    else { errados++; pt.errados++; }
  }
  const fim = Math.min(Date.now(), new Date(t.expira_em).getTime());
  const dur = Math.max(0, Math.round((fim - new Date(t.iniciada_em).getTime()) / 1000));
  const { rows } = await db.query(
    `UPDATE tentativas SET finalizada_em = to_timestamp($2::double precision / 1000), motivo_fim = $3,
       certos = $4, errados = $5, brancos = $6, nota = $7, duracao_seg = $8, por_tema = $9
     WHERE id = $1 AND finalizada_em IS NULL RETURNING *`,
    [t.id, fim, motivo, certos, errados, brancos, certos - errados, dur, porTema]);
  return rows[0] || null;
}

// devolve a prova aberta; se o tempo acabou, entrega automaticamente
async function provaAberta(alunoId) {
  const { rows } = await pool.query('SELECT * FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NULL', [alunoId]);
  const t = rows[0];
  if (!t) return null;
  if (new Date(t.expira_em).getTime() <= Date.now()) { await finalizar(pool, t, 'tempo'); return null; }
  return t;
}
async function ultimaFinalizada(alunoId) {
  const { rows } = await pool.query('SELECT id FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NOT NULL ORDER BY finalizada_em DESC LIMIT 1', [alunoId]);
  return rows[0] ? rows[0].id : null;
}

// ---------------- app ----------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data: https://adrianefauth.com.br; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// text/plain para aceitar o navigator.sendBeacon
app.use(express.json({ limit: '20kb', type: ['application/json', 'text/plain'] }));

app.get('/health', h(async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

// ----- conta -----
app.post('/api/cadastro', limitar(10, 15 * 60e3), h(async (req, res) => {
  const b = req.body || {};
  const nome = String(b.nome || '').trim().replace(/\s+/g, ' ');
  const cpf = String(b.cpf || '').replace(/\D/g, '');
  const email = String(b.email || '').trim().toLowerCase();
  const whatsapp = String(b.whatsapp || '').replace(/\D/g, '');
  const senha = String(b.senha || '');
  if (nome.length < 5 || nome.length > 120 || !nome.includes(' ')) return erro(res, 'Informe seu nome completo.');
  if (!cpfValido(cpf)) return erro(res, 'CPF inválido. Confira os números digitados.');
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return erro(res, 'E-mail inválido.');
  if (whatsapp.length < 10 || whatsapp.length > 11) return erro(res, 'WhatsApp inválido. Informe DDD + número.');
  if (senha.length < 6 || senha.length > 72) return erro(res, 'A senha precisa ter pelo menos 6 caracteres.');
  const hash = await bcrypt.hash(senha, 10);
  try {
    const { rows } = await pool.query(
      'INSERT INTO alunos (nome, cpf, email, whatsapp, senha_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [nome, cpf, email, whatsapp, hash]);
    setSessao(res, rows[0].id);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return erro(res, 'Este CPF já tem cadastro. Use a aba Entrar.', 409);
    throw e;
  }
}));

app.post('/api/login', limitar(10, 15 * 60e3), h(async (req, res) => {
  const cpf = String((req.body || {}).cpf || '').replace(/\D/g, '');
  const senha = String((req.body || {}).senha || '');
  const { rows } = await pool.query('SELECT id, senha_hash FROM alunos WHERE cpf = $1', [cpf]);
  if (!rows[0] || !(await bcrypt.compare(senha, rows[0].senha_hash))) return erro(res, 'CPF ou senha incorretos.', 401);
  setSessao(res, rows[0].id);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${PROD ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/me', auth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT nome, cpf FROM alunos WHERE id = $1', [req.alunoId]);
  if (!rows[0]) return erro(res, 'Sessão inválida.', 401);
  const aberta = await provaAberta(req.alunoId);
  const ult = await pool.query('SELECT iniciada_em FROM tentativas WHERE aluno_id = $1 ORDER BY iniciada_em DESC LIMIT 1', [req.alunoId]);
  const proxima = ult.rows[0] ? new Date(ult.rows[0].iniciada_em).getTime() + INTERVALO_MS : 0;
  res.json({
    nome: rows[0].nome,
    cpf: mascararCPF(rows[0].cpf),
    tentativaAberta: !!aberta,
    podeIniciar: !aberta && proxima <= Date.now(),
    proximaEm: !aberta && proxima > Date.now() ? new Date(proxima).toISOString() : null,
    agora: new Date().toISOString(),
    regras: { total: TOTAL, duracaoMin: DURACAO_SEG / 60, maxSaidas: MAX_SAIDAS },
  });
}));

app.get('/api/temas', auth, (req, res) => res.json(TEMAS));

// ----- prova -----
app.post('/api/tentativas', auth, h(async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM alunos WHERE id = $1 FOR UPDATE', [req.alunoId]); // trava contra cliques duplos
    const ab = await c.query('SELECT * FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NULL', [req.alunoId]);
    if (ab.rows[0]) {
      if (new Date(ab.rows[0].expira_em).getTime() > Date.now()) { await c.query('COMMIT'); return res.json({ ok: true, retomada: true }); }
      await finalizar(c, ab.rows[0], 'tempo');
    }
    const ult = await c.query('SELECT iniciada_em FROM tentativas WHERE aluno_id = $1 ORDER BY iniciada_em DESC LIMIT 1', [req.alunoId]);
    if (ult.rows[0]) {
      const proxima = new Date(ult.rows[0].iniciada_em).getTime() + INTERVALO_MS;
      if (proxima > Date.now()) {
        await c.query('ROLLBACK');
        return res.status(429).json({ erro: 'Você já fez o simulado nas últimas 24 horas.', proximaEm: new Date(proxima).toISOString() });
      }
    }
    await c.query(
      `INSERT INTO tentativas (aluno_id, expira_em, ordem, primeira)
       VALUES ($1, now() + make_interval(secs => $2), $3, $4)`,
      [req.alunoId, DURACAO_SEG, novaOrdem(), !ult.rows[0]]);
    await c.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}));

app.get('/api/tentativas/atual', auth, h(async (req, res) => {
  const t = await provaAberta(req.alunoId);
  if (!t) return res.status(404).json({ erro: 'Nenhuma prova em andamento.', ultimaId: await ultimaFinalizada(req.alunoId) });
  const { rows } = await pool.query('SELECT nome, cpf FROM alunos WHERE id = $1', [req.alunoId]);
  res.json({
    id: t.id,
    expiraEm: t.expira_em,
    duracaoSeg: DURACAO_SEG,
    agora: new Date().toISOString(),
    saidas: t.violacoes,
    maxSaidas: MAX_SAIDAS,
    respostas: t.respostas,
    marca: `${rows[0].nome} · ${mascararCPF(rows[0].cpf)}`,
    questoes: t.ordem.map((id, i) => { const q = POR_ID.get(id); return { id, n: i + 1, materia: q.materia, texto: q.texto }; }),
  });
}));

app.put('/api/tentativas/atual/resposta', auth, h(async (req, res) => {
  const qid = Number((req.body || {}).qid);
  const resp = (req.body || {}).resp ?? null;
  if (![null, 'C', 'E'].includes(resp)) return erro(res, 'Resposta inválida.');
  const t = await provaAberta(req.alunoId);
  if (!t) return res.status(409).json({ erro: 'A prova já foi encerrada.', encerrada: true, id: await ultimaFinalizada(req.alunoId) });
  if (!t.ordem.includes(qid)) return erro(res, 'Item inválido.');
  if (resp) {
    await pool.query(`UPDATE tentativas SET respostas = jsonb_set(respostas, ARRAY[$2::text], to_jsonb($3::text)) WHERE id = $1 AND finalizada_em IS NULL`, [t.id, String(qid), resp]);
  } else {
    await pool.query(`UPDATE tentativas SET respostas = respostas - $2::text WHERE id = $1 AND finalizada_em IS NULL`, [t.id, String(qid)]);
  }
  res.json({ ok: true });
}));

app.post('/api/tentativas/atual/violacao', auth, h(async (req, res) => {
  const tipo = String((req.body || {}).tipo || 'saida').slice(0, 40);
  const t = await provaAberta(req.alunoId);
  if (!t) return res.json({ encerrada: true, id: await ultimaFinalizada(req.alunoId) });
  // conta no máximo 1 saída a cada 3 s (uma troca de aba dispara vários eventos)
  const { rows } = await pool.query(
    `UPDATE tentativas SET violacoes = violacoes + 1, ultima_violacao = now(),
       eventos = eventos || jsonb_build_array(jsonb_build_object('tipo', $2::text, 'em', now()))
     WHERE id = $1 AND finalizada_em IS NULL AND (ultima_violacao IS NULL OR ultima_violacao < now() - interval '3 seconds')
     RETURNING *`, [t.id, tipo]);
  const atual = rows[0] || t;
  if (atual.violacoes >= MAX_SAIDAS) {
    await finalizar(pool, atual, 'saidas');
    return res.json({ encerrada: true, id: atual.id, saidas: atual.violacoes });
  }
  res.json({ saidas: atual.violacoes, max: MAX_SAIDAS, contou: !!rows[0] });
}));

app.post('/api/tentativas/atual/finalizar', auth, h(async (req, res) => {
  const t = await provaAberta(req.alunoId);
  if (!t) return res.json({ id: await ultimaFinalizada(req.alunoId) });
  const f = await finalizar(pool, t, 'entregue');
  res.json({ id: f ? f.id : t.id });
}));

app.get('/api/tentativas', auth, h(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, iniciada_em, finalizada_em, motivo_fim, certos, errados, brancos, nota, duracao_seg, por_tema, violacoes, primeira
     FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NOT NULL ORDER BY iniciada_em`, [req.alunoId]);
  res.json(rows);
}));

app.get('/api/tentativas/:id', auth, h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tentativas WHERE id = $1 AND aluno_id = $2 AND finalizada_em IS NOT NULL', [Number(req.params.id) || 0, req.alunoId]);
  const t = rows[0];
  if (!t) return erro(res, 'Resultado não encontrado.', 404);
  const anterior = await pool.query(
    'SELECT por_tema FROM tentativas WHERE aluno_id = $1 AND finalizada_em IS NOT NULL AND iniciada_em < $2 ORDER BY iniciada_em DESC LIMIT 1',
    [req.alunoId, t.iniciada_em]);
  res.json({
    id: t.id, iniciada_em: t.iniciada_em, motivo_fim: t.motivo_fim, certos: t.certos, errados: t.errados, brancos: t.brancos,
    nota: t.nota, duracao_seg: t.duracao_seg, violacoes: t.violacoes, primeira: t.primeira, por_tema: t.por_tema,
    por_tema_anterior: anterior.rows[0] ? anterior.rows[0].por_tema : null,
    total: TOTAL,
    temas: TEMAS,
    revisao: t.ordem.map((id, i) => {
      const q = POR_ID.get(id);
      return { n: i + 1, materia: q.materia, tema: q.tema, texto: q.texto, resposta: t.respostas[id] || null, gabarito: q.gabarito, comentario: q.comentario };
    }),
  });
}));

// ----- ranking -----
// modo=primeira: ranking oficial, só a 1ª tentativa de cada aluno (justo: ninguém decorou o gabarito)
// modo=melhor: melhor nota de cada aluno
app.get('/api/ranking', auth, h(async (req, res) => {
  const melhor = req.query.modo === 'melhor';
  const base = melhor
    ? `SELECT DISTINCT ON (t.aluno_id) t.aluno_id, t.nota, t.certos, t.duracao_seg, t.finalizada_em
       FROM tentativas t WHERE t.finalizada_em IS NOT NULL ORDER BY t.aluno_id, t.nota DESC, t.duracao_seg ASC`
    : `SELECT t.aluno_id, t.nota, t.certos, t.duracao_seg, t.finalizada_em
       FROM tentativas t WHERE t.primeira AND t.finalizada_em IS NOT NULL`;
  const sql = `WITH b AS (${base}),
    r AS (SELECT b.*, a.nome, RANK() OVER (ORDER BY b.nota DESC, b.duracao_seg ASC) AS pos FROM b JOIN alunos a ON a.id = b.aluno_id)`;
  const [lista, eu, total] = await Promise.all([
    pool.query(`${sql} SELECT * FROM r ORDER BY pos, finalizada_em LIMIT 50`),
    pool.query(`${sql} SELECT * FROM r WHERE aluno_id = $1`, [req.alunoId]),
    pool.query(`${sql} SELECT count(*)::int AS n FROM r`),
  ]);
  const fmt = l => ({ pos: Number(l.pos), nome: nomeCurto(l.nome), nota: l.nota, certos: l.certos, duracao_seg: l.duracao_seg, eu: l.aluno_id === req.alunoId });
  res.json({ lista: lista.rows.map(fmt), eu: eu.rows[0] ? fmt(eu.rows[0]) : null, total: total.rows[0].n });
}));

// ----- exportação de alunos (leads) para a equipe -----
app.get('/api/admin/alunos.csv', h(async (req, res) => {
  const tok = String(req.query.token || '');
  if (!ADMIN_TOKEN || tok.length !== ADMIN_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN))) return erro(res, 'Não autorizado.', 401);
  const { rows } = await pool.query(
    `SELECT a.nome, a.cpf, a.email, a.whatsapp, a.criado_em, count(t.id) FILTER (WHERE t.finalizada_em IS NOT NULL) AS provas, max(t.nota) AS melhor_nota
     FROM alunos a LEFT JOIN tentativas t ON t.aluno_id = a.id GROUP BY a.id ORDER BY a.criado_em`);
  const cel = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['nome;cpf;email;whatsapp;cadastro;provas;melhor_nota',
    ...rows.map(r => [r.nome, r.cpf, r.email, r.whatsapp, new Date(r.criado_em).toISOString(), r.provas, r.melhor_nota].map(cel).join(';'))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="alunos-simulado-inss.csv"');
  res.send('\uFEFF' + csv);
}));

// ----- páginas -----
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, p) => res.setHeader('Cache-Control', p.endsWith('.html') ? 'no-store' : 'public, max-age=3600'),
}));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return erro(res, 'Requisição inválida.');
  console.error(err);
  erro(res, 'Erro interno. Tente novamente.', 500);
});

init().then(() => app.listen(PORT, () => console.log(`Simulado INSS rodando na porta ${PORT}`)))
  .catch(e => { console.error(e); process.exit(1); });
