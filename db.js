'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 15,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS alunos (
  id          SERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  cpf         CHAR(11) NOT NULL UNIQUE,
  email       TEXT NOT NULL,
  whatsapp    TEXT NOT NULL,
  senha_hash  TEXT NOT NULL,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tentativas (
  id               SERIAL PRIMARY KEY,
  aluno_id         INT NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
  iniciada_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em        TIMESTAMPTZ NOT NULL,
  finalizada_em    TIMESTAMPTZ,
  ordem            INT[] NOT NULL,
  respostas        JSONB NOT NULL DEFAULT '{}'::jsonb,
  violacoes        INT NOT NULL DEFAULT 0,
  ultima_violacao  TIMESTAMPTZ,
  eventos          JSONB NOT NULL DEFAULT '[]'::jsonb,
  motivo_fim       TEXT,
  certos           INT,
  errados          INT,
  brancos          INT,
  nota             INT,
  duracao_seg      INT,
  por_tema         JSONB,
  primeira         BOOLEAN NOT NULL DEFAULT false
);

-- no máximo uma prova aberta por aluno
CREATE UNIQUE INDEX IF NOT EXISTS tentativas_uma_aberta ON tentativas (aluno_id) WHERE finalizada_em IS NULL;
CREATE INDEX IF NOT EXISTS tentativas_aluno ON tentativas (aluno_id, iniciada_em DESC);
CREATE INDEX IF NOT EXISTS tentativas_ranking ON tentativas (nota DESC, duracao_seg) WHERE finalizada_em IS NOT NULL;

-- 29/10/2026: login pelo Firebase (a senha fica no Firebase; senha_hash só para contas antigas)
ALTER TABLE alunos ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
ALTER TABLE alunos ALTER COLUMN senha_hash DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alunos_firebase_uid ON alunos (firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alunos_email ON alunos (lower(email)) WHERE firebase_uid IS NOT NULL;

-- 29/10/2026: vários simulados ('inss80' = o simulado antigo de 80 itens, guardado; 's1' e 's2' = os atuais)
ALTER TABLE tentativas ADD COLUMN IF NOT EXISTS simulado TEXT NOT NULL DEFAULT 'inss80';
CREATE INDEX IF NOT EXISTS tentativas_aluno_sim ON tentativas (aluno_id, simulado, iniciada_em DESC);
`;

async function init() {
  for (let i = 1; i <= 15; i++) {
    try {
      await pool.query(SCHEMA);
      console.log('Banco pronto.');
      return;
    } catch (e) {
      console.log(`Aguardando o Postgres (tentativa ${i}/15): ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw new Error('Não foi possível conectar ao Postgres. Confira DATABASE_URL.');
}

module.exports = { pool, init };
