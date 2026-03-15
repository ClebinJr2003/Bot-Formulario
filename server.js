import "dotenv/config";
import express from "express";
import session from "express-session";
import Database from "better-sqlite3";   
import { google } from "googleapis";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  EmbedBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  ChannelType
} from "discord.js";

/**
 *  MODO SOB DEMANDA (ON-DEMAND BOT)
 * - Site (Express) sobe sempre (24h)
 * - Bot só liga quando alguma rota precisar do Discord (/api/recrutar, requireInGuild etc.)
 * - Espera o bot ficar READY antes de usar client.channels/guilds
 */

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const allowedOrigins = [
    process.env.SITE_URL || "",
    process.env.ADMIN_URL || "",
    "https://recrutamento-gpv.vercel.app"
  ].filter(Boolean);

  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
  }

  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.set("trust proxy", 1);

// ================== CONFIG DISCORD ==================
const GUILD_ID = process.env.GUILD_ID;

const CANAL_RECRUTAMENTO_ID = "1475273434081656953";
const CARGO_RECRUTADOR_ID = "1475273680857862194";
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || "";

const CANAL_REPROVADOS_ID = "1475271205148688574";
const CANAL_APROVADOS_ID = "1475273177147117741";

const CARGO_APROVADO_ID = "";

// Ideal: aqui deveria ser o ID do cargo RECRUTADO.
// Se você usa .env com RECRUTADO_ROLE_ID, pode deixar isso vazio.
const CARGO_RECRUTA_ID = "1475273680857862194";

//  Cargo "RECRUTADO" (tag)
const RECRUTADO_ROLE_ID = process.env.RECRUTADO_ROLE_ID || CARGO_RECRUTA_ID;

// Categoria opcional para tickets (coloque no .env se quiser)
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || "";

// ===== Expiração dos botões (dias) =====
const ACTION_EXPIRE_DAYS = Number(process.env.ACTION_EXPIRE_DAYS || 7);
// Intervalo do job (ms)
const JOB_INTERVAL_MS = Number(process.env.JOB_INTERVAL_MS || 60 * 60 * 1000);

// ===== Auto-fechar tickets =====
const TICKET_AUTO_CLOSE_DAYS = Number(process.env.TICKET_AUTO_CLOSE_DAYS || 7);
// Auto deletar depois de fechado (0 = não deletar)
const TICKET_DELETE_AFTER_CLOSE_DAYS = Number(process.env.TICKET_DELETE_AFTER_CLOSE_DAYS || 0);

const VIDEOS_APROVADO = [
  "https://youtu.be/GS1uxcw2WZc?si=2PJacLVz5LuPDgGw",
  "https://youtu.be/2f5dxgvjIwY?si=geSwH1uSHkfJ8Nrw",
  "https://youtu.be/mzjUWk6jsL8"
];

const INSTRUTORES_POR_HORARIO = {
  manha: ["368541902342979584"],
  tarde: ["1109240826934079608"],
  noite: ["274895980091015168"]
};

const LOGO_URL =
  "https://cdn.discordapp.com/attachments/1472106023425802396/1472114730222096658/logo-gpv.png?ex=6991652e&is=699013ae&hm=7360420c093efc4c5deeb57ff5be048070a9282531d24c1bf15650d6caae496e&";

// ================== OAUTH / SESSION CONFIG ==================
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;

const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ================== GOOGLE SHEETS CONFIG ==================
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const SHEETS_TAB_NAME = process.env.SHEETS_TAB_NAME || "PRE CADASTRO Acd";
const SHEETS_CLIENT_EMAIL = process.env.SHEETS_CLIENT_EMAIL;
let SHEETS_PRIVATE_KEY = process.env.SHEETS_PRIVATE_KEY;

if (SHEETS_PRIVATE_KEY) {
  SHEETS_PRIVATE_KEY = SHEETS_PRIVATE_KEY.replace(/\\n/g, "\n");
}

let sheets = null;

function getSheetsClient() {
  if (!SHEETS_CLIENT_EMAIL || !SHEETS_PRIVATE_KEY || !SHEETS_SPREADSHEET_ID) return null;

  const auth = new google.auth.JWT({
    email: SHEETS_CLIENT_EMAIL,
    key: SHEETS_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

// formata datas e grava em A,B,L,M,N,O,P,Z,AC usando A:AC
function formatDateBRFromISO(isoOrDateString) {
  if (!isoOrDateString) return "Não informado";

  const m = String(isoOrDateString).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${d}/${mo}/${y}`;
  }

  const dt = new Date(isoOrDateString);
  if (!Number.isNaN(dt.getTime())) {
    return dt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }

  return String(isoOrDateString);
}

function formatTodayBR() {
  return new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function appendApprovedToSheet({
  nome,
  whatsapp,
  plataforma,
  vip,
  rg,
  nascimento,
  email,
  batalhao
}) {

  if (!sheets) sheets = getSheetsClient();
  if (!sheets) {
    console.log("⚠️ Sheets não configurado.");
    return;
  }

  const DATA_START_ROW = Number(process.env.SHEETS_DATA_START_ROW || 3);

  // 🔎 LER COLUNA A (onde o bot guarda o whatsapp principal)
  const colA = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range: `${SHEETS_TAB_NAME}!A${DATA_START_ROW}:A`
  });

  const values = colA.data.values || [];

  const numeroRecebido = String(whatsapp || "").replace(/\D/g, "");

  let targetRow = null;

  //  PROCURAR NUMERO EXISTENTE
  for (let i = 0; i < values.length; i++) {

    const numeroPlanilha = String(values[i]?.[0] || "").replace(/\D/g, "");

    if (numeroPlanilha === numeroRecebido) {
      targetRow = DATA_START_ROW + i;
      console.log("📱 Número encontrado na linha:", targetRow);
      break;
    }

  }

  //  SE NÃO EXISTIR CRIA NOVA LINHA
  if (!targetRow) {
    targetRow = DATA_START_ROW + values.length;
    console.log("📄 Número novo, criando linha:", targetRow);
  }

  const hoje = new Date();

  const dataEntrada = hoje.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo"
  });

  const row = new Array(29).fill("");

  row[0]  = whatsapp || "";   // A
  row[1]  = dataEntrada;      // B
  row[8]  = batalhao || "";   // I
  row[11] = nome || "";       // L
  row[12] = whatsapp || "";   // M
  row[13] = plataforma || ""; // N
  row[14] = vip || "";        // O
  row[15] = rg || "";         // P
  row[25] = formatDateBRFromISO(nascimento) || ""; // Z
  row[28] = email || "";      // AC

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: [

        {
          range: `${SHEETS_TAB_NAME}!A${targetRow}:B${targetRow}`,
          values: [[row[0], row[1]]]
        },

        {
          range: `${SHEETS_TAB_NAME}!I${targetRow}:I${targetRow}`,
          values: [[row[8]]]
        },

        {
          range: `${SHEETS_TAB_NAME}!L${targetRow}:P${targetRow}`,
          values: [[
            row[11],
            row[12],
            row[13],
            row[14],
            row[15]
          ]]
        },

        {
          range: `${SHEETS_TAB_NAME}!Z${targetRow}:Z${targetRow}`,
          values: [[row[25]]]
        },

        {
          range: `${SHEETS_TAB_NAME}!AC${targetRow}:AC${targetRow}`,
          values: [[row[28]]]
        }

      ]
    }
  });

  console.log(`✅ Planilha atualizada na linha ${targetRow}`);

}

// ================== BANCO (SQLite) ==================
const db = new Database(process.env.SQLITE_PATH || "/tmp/recrutamento.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS applications (
  actionMessageId TEXT PRIMARY KEY,
  discordId TEXT NOT NULL,

  nome TEXT,
  whatsapp TEXT,
  plataforma TEXT,
  batalhao TEXT,
  vip TEXT,
  rg TEXT,
  nascimento TEXT,
  email TEXT,

  nick TEXT NOT NULL,
  horarioInstrucao TEXT,
  status TEXT DEFAULT 'PENDENTE',
  decidedBy TEXT,
  decidedAt TEXT,
  createdAt TEXT NOT NULL
);
`);

function tryAddColumn(sql) {
  try { db.exec(sql); } catch {}
}

tryAddColumn(`ALTER TABLE applications ADD COLUMN batalhao TEXT;`);
tryAddColumn(`ALTER TABLE applications ADD COLUMN motivo TEXT;`);
tryAddColumn(`ALTER TABLE applications ADD COLUMN ticketChannelId TEXT;`);
tryAddColumn(`ALTER TABLE applications ADD COLUMN ticketCreatedAt TEXT;`);
tryAddColumn(`ALTER TABLE applications ADD COLUMN ticketClosedAt TEXT;`);
tryAddColumn(`ALTER TABLE applications ADD COLUMN confirmedAt TEXT;`);
tryAddColumn(`ALTER TABLE applications ADD COLUMN expiredAt TEXT;`);

const stmtInsert = db.prepare(`
INSERT OR REPLACE INTO applications
(actionMessageId, discordId, nome, whatsapp, plataforma, batalhao, vip, rg, nascimento, email, nick, horarioInstrucao, status, createdAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'PENDENTE\', ?)
`);

const stmtGet = db.prepare(`SELECT * FROM applications WHERE actionMessageId = ?`);

//  NOVO: evitar duplicados (pendente) + status no site
const stmtFindPendByDiscord = db.prepare(`
SELECT actionMessageId, status, createdAt
FROM applications
WHERE discordId = ? AND status = 'PENDENTE'
ORDER BY datetime(createdAt) DESC
LIMIT 1
`);

const stmtFindPendByWhatsapp = db.prepare(`
SELECT actionMessageId, status, createdAt
FROM applications
WHERE whatsapp = ? AND status = 'PENDENTE'
ORDER BY datetime(createdAt) DESC
LIMIT 1
`);

const stmtGetLatestByDiscord = db.prepare(`
SELECT actionMessageId, status, motivo, decidedBy, decidedAt, createdAt,
       nome, whatsapp, plataforma, batalhao, vip, rg, nascimento, email, nick, horarioInstrucao,
       ticketChannelId, ticketCreatedAt, ticketClosedAt, confirmedAt, expiredAt
FROM applications
WHERE discordId = ?
ORDER BY datetime(createdAt) DESC
LIMIT 1
`);

const stmtDecide = db.prepare(`
UPDATE applications
SET status = ?, decidedBy = ?, decidedAt = ?, motivo = COALESCE(?, motivo)
WHERE actionMessageId = ? AND status = 'PENDENTE'
`);

const stmtSetTicketMeta = db.prepare(`
UPDATE applications
SET ticketChannelId = ?, ticketCreatedAt = ?
WHERE actionMessageId = ? AND discordId = ?
`);

const stmtCloseTicket = db.prepare(`
UPDATE applications
SET ticketClosedAt = ?
WHERE actionMessageId = ? AND ticketChannelId = ?
`);

const stmtSetConfirmed = db.prepare(`
UPDATE applications
SET confirmedAt = ?
WHERE actionMessageId = ? AND discordId = ?
`);

const stmtMarkExpired = db.prepare(`
UPDATE applications
SET expiredAt = ?
WHERE actionMessageId = ? AND status = 'PENDENTE' AND expiredAt IS NULL
`);

const stmtGetPendentes = db.prepare(`
SELECT actionMessageId, createdAt
FROM applications
WHERE status = 'PENDENTE'
`);

const stmtApprovedWithTicket = db.prepare(`
SELECT actionMessageId, ticketChannelId, ticketCreatedAt, ticketClosedAt
FROM applications
WHERE status = 'APROVADO' AND ticketChannelId IS NOT NULL
`);

// ================== DISCORD CLIENT ==================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

//  BOT SOB DEMANDA
let botStarted = false;
let botReadyResolve;
let botReadyReject;
let botReadyPromise = new Promise((resolve, reject) => {
  botReadyResolve = resolve;
  botReadyReject = reject;
});

async function startBotIfNeeded() {
  if (botStarted) return botReadyPromise;

  botStarted = true;
  console.log("🤖 Iniciando bot sob demanda...");

  client.once(Events.ClientReady, () => {
    console.log(`🤖 Bot online: ${client.user.tag}`);
    botReadyResolve(true);
  });

  client.once(Events.Error, (e) => {
    console.log("❌ Erro no bot:", e?.message || e);
    botReadyReject(e);
  });

  await client.login(process.env.BOT_TOKEN);
  return botReadyPromise;
}

// ================== SESSÃO / STATIC ==================
app.use(
  session({
    secret: SESSION_SECRET || "dev_secret_change_me", // defina SESSION_SECRET no Render
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);

app.use(express.static("public"));

// ================== HELPERS ==================
function horarioBonito(h) {
  if (h === "manha") return "Manhã";
  if (h === "tarde") return "Tarde";
  if (h === "noite") return "Noite";
  return h || "Não informado";
}

function diasBonitos(diasSemana) {
  if (Array.isArray(diasSemana)) return diasSemana.length ? diasSemana.join(", ") : "Não informado";
  return diasSemana || "Não informado";
}

function requireDiscordAuth(req, res, next) {
  if (!req.session?.discordUser?.id) {
    return res.status(401).json({ ok: false, error: "Você precisa entrar com Discord para enviar o formulário." });
  }
  next();
}

async function requireInGuild(req, res, next) {
  try {
    if (!GUILD_ID) return res.status(500).json({ ok: false, error: "GUILD_ID não configurado no .env" });
    const userId = req.session?.discordUser?.id;
    if (!userId) return res.status(401).json({ ok: false, error: "Faça login com Discord." });

    await startBotIfNeeded();

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch(userId);

    req.session.inGuild = true;
    return next();
  } catch {
    return res.status(403).json({
      ok: false,
      error: "Você precisa estar dentro do servidor da G.P.V para enviar o formulário."
    });
  }
}

function isRecrutador(member) {
  return !!member?.roles?.cache?.has(CARGO_RECRUTADOR_ID);
}

function isAdmin(member) {
  return !!(ADMIN_ROLE_ID && member?.roles?.cache?.has(ADMIN_ROLE_ID));
}

function canAccessPanel(member) {
  return isAdmin(member) || isRecrutador(member);
}

async function requirePanelAccess(req, res, next) {
  try {
    const userId = req.session?.discordUser?.id;
    if (!userId) {
      return res.status(401).json({ ok: false, error: "Faça login com Discord." });
    }

    await startBotIfNeeded();
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(userId);

    if (!canAccessPanel(member)) {
      return res.status(403).json({ ok: false, error: "Sem permissão para acessar o painel." });
    }

    req.panelMember = member;
    req.panelRole = isAdmin(member) ? "admin" : "recrutador";
    return next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Não foi possível validar o acesso ao painel." });
  }
}

function allInstrutoresSet() {
  return new Set(Object.values(INSTRUTORES_POR_HORARIO).flat());
}

function canManageTicket(member) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;
  if (member.roles?.cache?.has(CARGO_RECRUTADOR_ID)) return true;
  return allInstrutoresSet().has(member.id);
}

function disabledActionRow(reasonLabel = "Expirado") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("aprovar").setLabel("✅ Aprovar").setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId("reprovar").setLabel(`❌ Reprovar (${reasonLabel})`).setStyle(ButtonStyle.Danger).setDisabled(true)
  );
}

function confirmRow(actionMessageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_videos:${actionMessageId}`)
      .setLabel("✅ Confirmo que assisti")
      .setStyle(ButtonStyle.Primary)
  );
}

function slugifyChannelName(txt) {
  return String(txt || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "candidato";
}

function makeUniqueTicketName(nickOrNome, actionMessageId) {
  const base = `instrucao-${slugifyChannelName(nickOrNome)}`;
  const tail = String(actionMessageId).slice(-4);
  return `${base}-${tail}`.slice(0, 90);
}

async function fetchRecruitmentChannel() {
  await startBotIfNeeded();
  return client.channels.fetch(CANAL_RECRUTAMENTO_ID);
}

/**
 * fetch JSON com tratamento de 429 + HTML
 * - se 429: devolve { rateLimited: true, retryAfterSec }
 * - se vier HTML: devolve erro amigável
 */
async function discordFetchJson(url, options = {}, label = "discord") {
  const resp = await fetch(url, options);
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  const text = await resp.text();

  // 429
  if (resp.status === 429) {
    let retryAfter = 60;

    // Discord geralmente manda JSON com retry_after
    if (ct.includes("application/json")) {
      try {
        const j = JSON.parse(text);
        if (typeof j?.retry_after === "number") retryAfter = Math.ceil(j.retry_after);
      } catch {}
    }

    // Às vezes existe header Retry-After
    const ra = resp.headers.get("retry-after");
    if (ra && !Number.isNaN(Number(ra))) retryAfter = Math.ceil(Number(ra));

    return { ok: false, rateLimited: true, retryAfterSec: retryAfter, status: resp.status, raw: text.slice(0, 200) };
  }

  // Não-JSON
  if (!ct.includes("application/json")) {
    return {
      ok: false,
      status: resp.status,
      error: `[${label}] Esperava JSON, veio ${ct || "sem content-type"}`,
      raw: text.slice(0, 200)
    };
  }

  // JSON inválido
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: resp.status, error: `[${label}] JSON inválido`, raw: text.slice(0, 200) };
  }

  // HTTP erro
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: `[${label}] HTTP ${resp.status}`, data: json };
  }

  return { ok: true, status: resp.status, data: json };
}

//  DM em massa pra todos que tiverem o cargo "RECRUTADO"
async function dmCargoRecrutado(mensagem) {
  try {
    if (!GUILD_ID) return { ok: false, error: "GUILD_ID não configurado." };
    if (!RECRUTADO_ROLE_ID) return { ok: false, error: "RECRUTADO_ROLE_ID/CARGO_RECRUTA_ID não configurado." };

    await startBotIfNeeded();

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.members.fetch().catch(() => null);

    const role = await guild.roles.fetch(RECRUTADO_ROLE_ID).catch(() => null);
    if (!role) return { ok: false, error: "Cargo RECRUTADO não encontrado (ID errado?)." };

    let enviados = 0;
    let falharam = 0;

    for (const [, member] of role.members) {
      if (member.user?.bot) continue;
      try {
        await member.send(mensagem);
        enviados++;
      } catch {
        falharam++;
      }
    }

    return { ok: true, enviados, falharam, total: role.members.size };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function createTicketChannel({ guild, candidatoId, instrutoresIds, nickOrNome, actionMessageId }) {
  const baseName = makeUniqueTicketName(nickOrNome, actionMessageId);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: candidatoId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles
      ]
    },
    {
      id: CARGO_RECRUTADOR_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles
      ]
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles
      ]
    }
  ];

  for (const uid of instrutoresIds || []) {
    overwrites.push({
      id: uid,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles
      ]
    });
  }

  const payload = {
    name: baseName,
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    topic: `Ticket de instrução • actionMessageId=${actionMessageId} • candidato=${candidatoId}`
  };

  if (TICKET_CATEGORY_ID) payload.parent = TICKET_CATEGORY_ID;

  return guild.channels.create(payload);
}

function ticketControlsRow(actionMessageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_finalize:${actionMessageId}`)
      .setLabel("🗑️ Finalizar canal")
      .setStyle(ButtonStyle.Danger)
  );
}

function ticketFinalizeConfirmRow(actionMessageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_finalize_confirm:${actionMessageId}`)
      .setLabel("✅ Confirmar exclusão")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`ticket_finalize_cancel:${actionMessageId}`)
      .setLabel("↩️ Cancelar")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function closeTicketChannel({ channel, closedBy, reason = "Fechado" }) {
  try {
    const topic = channel.topic || "";
    const match = topic.match(/candidato=(\d+)/);
    const candidatoId = match?.[1];

    if (candidatoId) {
      await channel.permissionOverwrites.edit(candidatoId, { SendMessages: false }).catch(() => null);
    }

    if (!channel.name.startsWith("fechado-")) {
      await channel.setName(`fechado-${channel.name}`.slice(0, 90)).catch(() => null);
    }

    await channel.send(
      `🔒 Ticket **fechado**. Motivo: **${reason}**${closedBy ? ` | Por: <@${closedBy}>` : ""}`
    ).catch(() => null);
  } catch {}
}

// ================== MAP/LOCK ==================
const applications = new Map();
const processingLocks = new Set();

// ================== API: STATUS LOGIN ==================
app.get("/api/me", (req, res) => {
  if (!req.session?.discordUser) return res.json({ ok: true, logged: false });
  return res.json({
    ok: true,
    logged: true,
    inGuild: !!req.session.inGuild,
    user: req.session.discordUser
  });
});

// status da inscrição (para mostrar no site)
// Retorna a inscrição mais recente do usuário logado.
app.get("/api/status", requireDiscordAuth, async (req, res) => {
  try {
    const discordId = String(req.session.discordUser.id);
    const latest = stmtGetLatestByDiscord.get(discordId);

    if (!latest) {
      return res.json({ ok: true, hasApplication: false, status: null });
    }

    return res.json({
      ok: true,
      hasApplication: true,
      actionMessageId: latest.actionMessageId,
      status: latest.status,
      motivo: latest.motivo || null,
      decidedBy: latest.decidedBy || null,
      decidedAt: latest.decidedAt || null,
      createdAt: latest.createdAt,

      // útil pro front (se quiser mostrar um resumo)
      nome: latest.nome || latest.nick || null,
      whatsapp: latest.whatsapp || null,
      plataforma: latest.plataforma || null,
      batalhao: latest.batalhao || null,
      vip: latest.vip || null,
      rg: latest.rg || null,
      nascimento: latest.nascimento || null,
      email: latest.email || null,
      horarioInstrucao: latest.horarioInstrucao || null,

      // ticket
      confirmedAt: latest.confirmedAt || null,
      ticketChannelId: latest.ticketChannelId || null,
      ticketCreatedAt: latest.ticketCreatedAt || null,
      ticketClosedAt: latest.ticketClosedAt || null,

      // expiração
      expiredAt: latest.expiredAt || null
    });
  } catch (e) {
    console.log("❌ /api/status erro:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    botStarted,
    time: new Date().toISOString()
  });
});

// ================== PAINEL ADMIN / RECRUTADOR ==================
app.get("/api/panel/me", requirePanelAccess, async (req, res) => {
  return res.json({
    ok: true,
    role: req.panelRole,
    user: {
      id: req.session.discordUser.id,
      username: req.session.discordUser.username,
      global_name: req.session.discordUser.global_name || null
    }
  });
});

app.get("/api/panel/stats", requirePanelAccess, async (req, res) => {
  try {
    const total = db.prepare("SELECT COUNT(*) as c FROM applications").get()?.c || 0;
    const pendentes = db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'PENDENTE'").get()?.c || 0;
    const aprovados = db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'APROVADO'").get()?.c || 0;
    const reprovados = db.prepare("SELECT COUNT(*) as c FROM applications WHERE status = 'REPROVADO'").get()?.c || 0;

    return res.json({ ok: true, total, pendentes, aprovados, reprovados });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao carregar estatísticas." });
  }
});

app.get("/api/panel/ranking", requirePanelAccess, async (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT decidedBy, COUNT(*) as total
      FROM applications
      WHERE status = 'APROVADO' AND decidedBy IS NOT NULL
      GROUP BY decidedBy
      ORDER BY total DESC
      LIMIT 20
    `).all();

    const ranking = await Promise.all(rows.map(async (r) => {
      let username = r.decidedBy;
      try {
        await startBotIfNeeded();
        const u = await client.users.fetch(r.decidedBy);
        username = u?.globalName || u?.username || r.decidedBy;
      } catch {}
      return { userId: r.decidedBy, username, total: r.total };
    }));

    return res.json({ ok: true, ranking });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao carregar ranking." });
  }
});

app.get("/api/panel/history", requirePanelAccess, async (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT actionMessageId, discordId, nome, whatsapp, plataforma, batalhao, vip, rg, nascimento, email,
             nick, horarioInstrucao, status, motivo, decidedBy, decidedAt, createdAt,
             ticketChannelId, ticketCreatedAt, ticketClosedAt, confirmedAt, expiredAt
      FROM applications
      ORDER BY datetime(createdAt) DESC
      LIMIT 200
    `).all();

    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao carregar histórico." });
  }
});

app.get("/api/panel/applications", requirePanelAccess, async (req, res) => {
  try {
    const status = String(req.query.status || "").trim().toUpperCase();
    const allowed = new Set(["PENDENTE", "APROVADO", "REPROVADO"]);
    const sqlBase = `
      SELECT actionMessageId, discordId, nome, whatsapp, plataforma, batalhao, vip, rg, nascimento, email,
             nick, horarioInstrucao, status, motivo, decidedBy, decidedAt, createdAt,
             ticketChannelId, ticketCreatedAt, ticketClosedAt, confirmedAt, expiredAt
      FROM applications
    `;

    const rows = allowed.has(status)
      ? db.prepare(sqlBase + " WHERE status = ? ORDER BY datetime(createdAt) DESC LIMIT 200").all(status)
      : db.prepare(sqlBase + " ORDER BY datetime(createdAt) DESC LIMIT 200").all();

    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao carregar inscrições." });
  }
});

app.post("/api/panel/approve/:actionMessageId", requirePanelAccess, async (req, res) => {
  try {
    await handleDecision({
      actionMessageId: String(req.params.actionMessageId),
      decidedById: String(req.session.discordUser.id),
      isAprovar: true,
      motivo: null,
      interaction: null
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao aprovar pelo painel." });
  }
});

app.post("/api/panel/reprove/:actionMessageId", requirePanelAccess, async (req, res) => {
  try {
    const motivo = String(req.body?.motivo || "").trim();
    if (!motivo) {
      return res.status(400).json({ ok: false, error: "Motivo obrigatório." });
    }

    await handleDecision({
      actionMessageId: String(req.params.actionMessageId),
      decidedById: String(req.session.discordUser.id),
      isAprovar: false,
      motivo,
      interaction: null
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao reprovar pelo painel." });
  }
});

app.get("/admin", requirePanelAccess, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Painel G.P.V</title>
  <style>
    body{font-family:Arial,sans-serif;background:#0b1220;color:#e5e7eb;margin:0;padding:20px}
    .wrap{max-width:1200px;margin:0 auto}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}
    .card{background:#111827;border:1px solid rgba(212,175,55,.25);border-radius:14px;padding:16px}
    .title{font-size:14px;color:#cbd5f5}
    .value{font-size:28px;font-weight:700;color:#f5d76e;margin-top:6px}
    .row{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
    button,select,input{padding:10px;border-radius:10px;border:1px solid rgba(212,175,55,.25);background:#020617;color:#fff}
    button{cursor:pointer;background:linear-gradient(135deg,#d4af37,#f5d76e);color:#020617;font-weight:700;border:none}
    table{width:100%;border-collapse:collapse;background:#111827;border-radius:14px;overflow:hidden}
    th,td{padding:10px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left;font-size:14px;vertical-align:top}
    th{color:#f5d76e}
    .muted{color:#cbd5f5;font-size:13px}
    .badge{padding:4px 8px;border-radius:999px;font-size:12px;font-weight:700}
    .PENDENTE{background:#3b82f633}
    .APROVADO{background:#22c55e33}
    .REPROVADO{background:#ef444433}
    .ranking{background:#111827;border-radius:14px;padding:16px;margin-top:16px}
    .actions{display:flex;gap:6px;flex-wrap:wrap}
  </style>
</head>
<body>
<div class="wrap">
  <h1>Painel G.P.V</h1>
  <div class="muted" id="me">Carregando...</div>

  <div class="grid">
    <div class="card"><div class="title">Total</div><div class="value" id="sTotal">0</div></div>
    <div class="card"><div class="title">Pendentes</div><div class="value" id="sPend">0</div></div>
    <div class="card"><div class="title">Aprovados</div><div class="value" id="sAprov">0</div></div>
    <div class="card"><div class="title">Reprovados</div><div class="value" id="sReprov">0</div></div>
  </div>

  <div class="row">
    <select id="statusFilter">
      <option value="">Todos</option>
      <option value="PENDENTE">Pendentes</option>
      <option value="APROVADO">Aprovados</option>
      <option value="REPROVADO">Reprovados</option>
    </select>
    <button onclick="loadApplications()">Atualizar lista</button>
  </div>

  <table>
    <thead>
      <tr>
        <th>Nome</th>
        <th>Discord</th>
        <th>Status</th>
        <th>Criado em</th>
        <th>Ações</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>

  <div class="ranking">
    <h2>Ranking de recrutadores</h2>
    <div id="ranking"></div>
  </div>
</div>

<script>
async function j(url, options={}) {
  const r = await fetch(url, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Erro");
  return data;
}

async function loadMe() {
  const data = await j("/api/panel/me");
  document.getElementById("me").textContent =
    "Logado como: " + (data.user.global_name || data.user.username) + " • Perfil: " + data.role;
}

async function loadStats() {
  const data = await j("/api/panel/stats");
  document.getElementById("sTotal").textContent = data.total;
  document.getElementById("sPend").textContent = data.pendentes;
  document.getElementById("sAprov").textContent = data.aprovados;
  document.getElementById("sReprov").textContent = data.reprovados;
}

async function approve(id) {
  await j("/api/panel/approve/" + id, { method: "POST", headers: { "Content-Type": "application/json" } });
  await boot();
}

async function reprove(id) {
  const motivo = prompt("Motivo da reprovação:");
  if (!motivo) return;
  await j("/api/panel/reprove/" + id, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ motivo })
  });
  await boot();
}

async function loadApplications() {
  const status = document.getElementById("statusFilter").value;
  const data = await j("/api/panel/applications" + (status ? ("?status=" + encodeURIComponent(status)) : ""));
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = "";

  for (const item of data.items) {
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td><strong>\${item.nome || item.nick || "Não informado"}</strong><div class="muted">\${item.batalhao || ""}</div></td>
      <td><div>\${item.discordId}</div><div class="muted">\${item.whatsapp || ""}</div></td>
      <td><span class="badge \${item.status}">\${item.status}</span></td>
      <td>\${item.createdAt || ""}</td>
      <td class="actions">
        \${item.status === "PENDENTE" ? '<button onclick="approve(\\'' + item.actionMessageId + '\\')">Aprovar</button><button onclick="reprove(\\'' + item.actionMessageId + '\\')">Reprovar</button>' : '<span class="muted">Sem ações</span>'}
      </td>
    \`;
    tbody.appendChild(tr);
  }
}

async function loadRanking() {
  const data = await j("/api/panel/ranking");
  const el = document.getElementById("ranking");
  if (!data.ranking.length) {
    el.innerHTML = '<div class="muted">Nenhum aprovado ainda.</div>';
    return;
  }
  el.innerHTML = data.ranking.map((r, i) => \`<div>\${i+1}. <strong>\${r.username}</strong> — \${r.total} aprovado(s)</div>\`).join("");
}

async function boot() {
  try {
    await loadMe();
    await loadStats();
    await loadApplications();
    await loadRanking();
  } catch (e) {
    alert(e.message || "Erro ao carregar painel");
  }
}
boot();
</script>
</body>
</html>`);
});

// ================== OAUTH START ==================
app.get("/auth/discord", (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_REDIRECT_URI) {
    return res.status(500).send("OAuth não configurado. Falta DISCORD_CLIENT_ID ou DISCORD_REDIRECT_URI.");
  }

  //  anti-spam: impede iniciar OAuth em sequência
  const now = Date.now();
  const last = req.session.lastOauthStartAt || 0;
  if (now - last < 2500) {
    return res.redirect(`/error/rate_limit?sec=3`);
  }
  req.session.lastOauthStartAt = now;

  const state = Math.random().toString(36).slice(2);
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds",
    state
  });

  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// ================== OAUTH CALLBACK ==================
app.get("/auth/discord/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) return res.status(400).send("Faltou code no callback.");
    if (!state || state !== req.session.oauthState) return res.status(400).send("State inválido. Tente novamente.");

    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
      return res.status(500).send("OAuth não configurado (CLIENT_ID/SECRET/REDIRECT).");
    }
    if (!GUILD_ID) return res.status(500).send("Faltou GUILD_ID no .env");

    const tokenParams = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tokenOut = await discordFetchJson(
      "https://discord.com/api/oauth2/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString()
      },
      "discord token"
    );

    if (tokenOut?.rateLimited) {
      delete req.session.oauthState;
      return res.redirect(`/error/rate_limit?sec=${tokenOut.retryAfterSec || 60}`);
    }

    if (!tokenOut.ok) {
      console.log("❌ token error:", tokenOut?.status, tokenOut?.error, tokenOut?.raw, tokenOut?.data);
      return res.status(400).send("Erro ao autenticar com Discord. Tente novamente.");
    }

    const accessToken = tokenOut.data.access_token;

    const userOut = await discordFetchJson(
      "https://discord.com/api/users/@me",
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "discord users/@me"
    );

    if (userOut?.rateLimited) {
      delete req.session.oauthState;
      return res.redirect(`/error/rate_limit?sec=${userOut.retryAfterSec || 60}`);
    }
    if (!userOut.ok) {
      console.log("❌ user error:", userOut?.status, userOut?.error, userOut?.raw, userOut?.data);
      return res.status(400).send("Erro ao pegar usuário do Discord.");
    }

    // valida se está no servidor usando o BOT (tira /users/@me/guilds)
    await startBotIfNeeded();
    const guild = await client.guilds.fetch(GUILD_ID);

    try {
      await guild.members.fetch(userOut.data.id);
    } catch {
      req.session.discordUser = null;
      req.session.inGuild = false;
      delete req.session.oauthState;
      return res.redirect(`/?error=voce_precisa_entrar_no_servidor`);
    }

    req.session.discordUser = {
      id: userOut.data.id,
      username: userOut.data.username,
      global_name: userOut.data.global_name || null
    };
    req.session.inGuild = true;

    delete req.session.oauthState;
    return res.redirect(process.env.ADMIN_URL || process.env.SITE_URL || "/");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Erro interno no login do Discord.");
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ================== ROTA DO FORM ==================
app.post("/api/recrutar", requireDiscordAuth, requireInGuild, async (req, res) => {
  try {
    await startBotIfNeeded();

    const data = req.body;
    data.discordId = String(req.session.discordUser.id);

    data.nome = (data.nome || "").trim() || "Não informado";
    // padroniza whatsapp (só dígitos) pra evitar duplicado e manter consistência
    const wppRaw = (data.whatsapp || "").trim();
    const wppClean = wppRaw.replace(/\D+/g, "");
    data.whatsapp = wppClean || "Não informado";
    data.plataforma = data.plataforma || "Não informado";
    data.batalhao = data.batalhao || "Não informado";
    data.vip = data.vip || "Não informado";
    data.porteArmas = data.porteArmas || "Não informado";
    data.reputacao = data.reputacao || "Não informado";
    data.rg = (data.rg || "").trim() || "Não informado";
    data.nascimento = data.nascimento || "Não informado";
    data.email = (data.email || "").trim() || "Não informado";
    data.nivel = (data.nivel || "").trim() || "Não informado";
    data.cidadeCadastrado = (data.cidadeCadastrado || "").trim() || "Não informado";

    data.nick = (data.nick || "").trim() || data.nome || "Não informado";

    data.horarioInstrucao = data.horarioInstrucao || "Não informado";
    data.diasSemana = data.diasSemana || "Não informado";

    data.comoConheceu = (data.comoConheceu || "").trim() || "Não informado";
    data.porqueQuer = (data.porqueQuer || "").trim() || "Não informado";
    data.aceitouTermos = data.aceitouTermos === "Sim" || data.aceitouTermos === true;
    const aceitouTxt = data.aceitouTermos ? "Sim" : "Não";

    if (!data?.nome || data.nome === "Não informado") {
      return res.status(400).json({ ok: false, error: "Nome obrigatório." });
    }

    // bloquear inscrição duplicada (PENDENTE)
    // - por discordId
    // - por whatsapp (se informado)
    const pendDiscord = stmtFindPendByDiscord.get(String(data.discordId));
    if (pendDiscord) {
      return res.status(409).json({
        ok: false,
        error: "Você já tem uma inscrição PENDENTE. Aguarde a análise.",
        actionMessageId: pendDiscord.actionMessageId,
        createdAt: pendDiscord.createdAt
      });
    }

    if (data.whatsapp && data.whatsapp !== "Não informado") {
      const pendWpp = stmtFindPendByWhatsapp.get(String(data.whatsapp));
      if (pendWpp) {
        return res.status(409).json({
          ok: false,
          error: "Já existe uma inscrição PENDENTE com esse WhatsApp. Aguarde a análise.",
          actionMessageId: pendWpp.actionMessageId,
          createdAt: pendWpp.createdAt
        });
      }
    }

    const canal = await client.channels.fetch(CANAL_RECRUTAMENTO_ID);

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Novo Recrutamento – G.P.V")
      .setDescription(`<@&${CARGO_RECRUTADOR_ID}>`)
      .setColor(0xD4AF37)
      .setThumbnail(LOGO_URL)
      .addFields(
        { name: "👤 Nome", value: `${data.nome}`, inline: true },
        { name: "🆔 Discord", value: `<@${data.discordId}> (${data.discordId})`, inline: true },
        { name: "📱 WhatsApp", value: `${data.whatsapp}`, inline: true },

        { name: "💻 Plataforma", value: `${data.plataforma}`, inline: true },
        { name: "🏛️ Batalhão", value: `${data.batalhao}`, inline: true },
        { name: "⭐ Sócio/VIP", value: `${data.vip}`, inline: true },
        { name: "🪪 RG", value: `${data.rg}`, inline: true },
        { name: "🎮 Nível", value: `${data.nivel}`, inline: true },
        { name: "📊 Reputação", value: `${data.reputacao}`, inline: true },
        { name: "🏙️ Cidade / Email e Discord cadastrado", value: `${data.cidadeCadastrado}`, inline: true },

        { name: "🎂 Nascimento", value: `${data.nascimento}`, inline: true },
        { name: "📧 Email", value: `${data.email}`, inline: true },

        { name: "🧠 Como conheceu", value: `${data.comoConheceu}`, inline: false },
        { name: "🎯 Por que quer entrar", value: `${data.porqueQuer}`, inline: false },

        { name: "✅ Aceitou os termos", value: `${aceitouTxt}`, inline: true }
      )
      .setFooter({ text: "G.P.V • Servir e Proteger" })
      .setTimestamp(new Date());

    await canal.send({ embeds: [embed] });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("aprovar").setLabel("✅ Aprovar").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("reprovar").setLabel("❌ Reprovar").setStyle(ButtonStyle.Danger)
    );

    const actionMsg = await canal.send({
      content: `Ações para o recrutamento acima (Nome: **${data.nome}**):`,
      components: [row]
    });

    applications.set(actionMsg.id, {
      discordId: String(data.discordId),
      nome: data.nome,
      whatsapp: data.whatsapp,
      plataforma: data.plataforma,
      batalhao: data.batalhao,
      vip: data.vip,
      rg: data.rg,
      nascimento: data.nascimento,
      email: data.email,
      nick: data.nick,
      horarioInstrucao: data.horarioInstrucao
    });

    stmtInsert.run(
      actionMsg.id,
      String(data.discordId),
      data.nome,
      data.whatsapp,
      data.plataforma,
      data.batalhao,
      data.vip,
      data.rg,
      data.nascimento,
      data.email,
      data.nick,
      data.horarioInstrucao,
      new Date().toISOString()
    );

    // DM instrutores (mantido)
    const lista = INSTRUTORES_POR_HORARIO[data.horarioInstrucao] || [];
    const avisoInstrutor =
`📌 **Nova inscrição G.P.V**

👤 **Nome:** ${data.nome}
🆔 **Discord:** <@${data.discordId}> (${data.discordId})
📱 **WhatsApp:** ${data.whatsapp}
💻 **Plataforma:** ${data.plataforma}
🏛️ **Batalhão:** ${data.batalhao}
⭐ **Sócio/VIP:** ${data.vip}
🪪 **RG:** ${data.rg}
🎂 **Nascimento:** ${data.nascimento}
📧 **Email:** ${data.email}

✅ **Aceitou os termos:** ${aceitouTxt}`;

    for (const instrutorId of lista) {
      try {
        const user = await client.users.fetch(instrutorId);
        await user.send(avisoInstrutor);
      } catch (e) {
        console.log("Falha ao mandar DM para instrutor:", instrutorId, e?.code || e?.message);
      }
    }

    // DM pra todos com cargo RECRUTADO
    const avisoRecrutado =
`📩 **Novo formulário enviado (G.P.V)**

👤 **Nome:** ${data.nome}
🆔 **Discord:** <@${data.discordId}> (${data.discordId})
📱 **WhatsApp:** ${data.whatsapp}
💻 **Plataforma:** ${data.plataforma}
🏛️ **Batalhão:** ${data.batalhao}
⭐ **Sócio/VIP:** ${data.vip}
🪪 **RG:** ${data.rg}
🎂 **Nascimento:** ${data.nascimento}
📧 **Email:** ${data.email}

🧠 **Como conheceu:** ${data.comoConheceu}
🎯 **Por que quer entrar:** ${data.porqueQuer}

✅ **Aceitou os termos:** ${aceitouTxt}`;

    const resultadoDM = await dmCargoRecrutado(avisoRecrutado);
    console.log("📨 DM cargo RECRUTADO:", resultadoDM);

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

// ================== DECISÃO (aprovar/reprovar) ==================
async function handleDecision({ actionMessageId, decidedById, isAprovar, motivo = null, interaction }) {
  if (processingLocks.has(actionMessageId)) {
    if (interaction && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⏳ Já estão processando essa inscrição. Aguarde.", ephemeral: true }).catch(() => null);
    }
    return;
  }
  processingLocks.add(actionMessageId);

  try {
    await startBotIfNeeded();

    const dbRecord = stmtGet.get(actionMessageId);
    const record = dbRecord || applications.get(actionMessageId);

    if (!record) {
      processingLocks.delete(actionMessageId);
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "⚠️ Não achei os dados dessa inscrição.", ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (dbRecord && dbRecord.status !== "PENDENTE") {
      processingLocks.delete(actionMessageId);
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `⚠️ Essa inscrição já foi **${dbRecord.status}** por <@${dbRecord.decidedBy}>.`,
          ephemeral: true
        }).catch(() => null);
      }
      return;
    }

    const candidatoId = record.discordId;
    const decidedAt = new Date().toISOString();
    const newStatus = isAprovar ? "APROVADO" : "REPROVADO";

    const updated = stmtDecide.run(newStatus, decidedById, decidedAt, motivo, actionMessageId);
    if (updated.changes === 0) {
      processingLocks.delete(actionMessageId);
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "⚠️ Alguém já decidiu agora mesmo.", ephemeral: true }).catch(() => null);
      }
      return;
    }

    const contentUpdate =
      `${isAprovar ? "✅" : "❌"} **${newStatus}** por <@${decidedById}> | ` +
      `Candidato: <@${candidatoId}> (Nome: **${record.nome || record.nick}**)` +
      (isAprovar ? "" : (motivo ? `\n📝 **Motivo:** ${motivo}` : ""));

    if (interaction?.isButton?.()) {
      await interaction.update({ content: contentUpdate, components: [disabledActionRow("Decidido")] })
        .catch(() => null);
    } else {
      const canal = await fetchRecruitmentChannel().catch(() => null);
      if (canal) {
        const msg = await canal.messages.fetch(actionMessageId).catch(() => null);
        if (msg) {
          await msg.edit({ content: contentUpdate, components: [disabledActionRow("Decidido")] }).catch(() => null);
        }
      }
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "✅ Decisão registrada.", ephemeral: true }).catch(() => null);
      }
    }

    //  Planilha
    if (isAprovar) {
      try {
        await appendApprovedToSheet({
          nome: record.nome,
          whatsapp: record.whatsapp,
          plataforma: record.plataforma,
          batalhao: record.batalhao,
          vip: record.vip,
          rg: record.rg,
          nascimento: record.nascimento,
          email: record.email,
          entrouEm: decidedAt
        });
      } catch (e) {
        console.log("❌ Falha ao registrar na planilha:", e?.message || e);
      }
    }

    // DM candidato
    try {
      const user = await client.users.fetch(candidatoId);

      if (isAprovar) {
        const links = VIDEOS_APROVADO
          .filter(Boolean)
          .map((u, i) => `**Vídeo ${i + 1}:** ${u}`)
          .join("\n");

        const embedDm = new EmbedBuilder()
          .setTitle("✅ Você foi APROVADO na G.P.V!")
          .setColor(0x2ecc71)
          .setThumbnail(LOGO_URL)
          .setDescription(
            "📌 **Passo obrigatório:** assista os 3 vídeos abaixo.\n" +
            "Depois clique em **“Confirmo que assisti”**.\n\n" +
            links
          )
          .setTimestamp(new Date());

        await user.send({
          embeds: [embedDm],
          components: [confirmRow(actionMessageId)]
        }).catch(() => null);
      } else {
        const motivoTxt = motivo ? `\n\n📝 **Motivo:** ${motivo}` : "";
        await user.send("❌ **REPROVADO.** Sua inscrição não foi aprovada no momento." + motivoTxt).catch(() => null);
      }
    } catch (e) {
      console.log("Falha ao mandar DM para candidato:", e?.code || e?.message);
    }

    // cargo automático (mantido)
    if (isAprovar && CARGO_APROVADO_ID) {
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const memberToPromote = await guild.members.fetch(candidatoId);

        // Tentar alterar o nick do aprovado conforme o campo 'nick' do formulário
        try {
          const desiredNick = (record.nick || "").trim();
          if (desiredNick) {
            const botMemberNick = await guild.members.fetch(client.user.id);
            // precisa ter permissão e o cargo do bot estar acima do alvo
            const canNick = botMemberNick.permissions.has(PermissionFlagsBits.ManageNicknames);
            const higher = botMemberNick.roles.highest.position > memberToPromote.roles.highest.position;
            if (canNick && higher) {
              await memberToPromote.setNickname(desiredNick).catch(() => null);
            }
          }
        } catch {}

        const botMember = await guild.members.fetch(client.user.id);

        if (botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
          const roleToAdd = await guild.roles.fetch(CARGO_APROVADO_ID);
          if (roleToAdd && botMember.roles.highest.position > roleToAdd.position) {
            await memberToPromote.roles.add(roleToAdd);
            if (CARGO_RECRUTA_ID) {
              const roleToRemove = await guild.roles.fetch(CARGO_RECRUTA_ID).catch(() => null);
              if (roleToRemove) await memberToPromote.roles.remove(roleToRemove).catch(() => null);
            }
          }
        }
      } catch {}
    }

    // log
    const canalLogId = isAprovar ? CANAL_APROVADOS_ID : CANAL_REPROVADOS_ID;
    const canalLog = await client.channels.fetch(canalLogId).catch(() => null);

    if (canalLog) {
      const embedLog = new EmbedBuilder()
        .setTitle(isAprovar ? "✅ Recrutamento Aprovado" : "❌ Recrutamento Reprovado")
        .setColor(isAprovar ? 0x2ecc71 : 0xe74c3c)
        .setThumbnail(LOGO_URL)
        .addFields(
          { name: "👤 Candidato", value: `<@${candidatoId}> (${candidatoId})`, inline: false },
          { name: "🏷️ Nome", value: `**${record.nome || record.nick}**`, inline: true },
          { name: "🛡️ Decidido por", value: `<@${decidedById}>`, inline: false },
          { name: "🕒 Data", value: `${decidedAt}`, inline: false }
        )
        .setTimestamp(new Date());

      if (!isAprovar && motivo) embedLog.addFields({ name: "📝 Motivo", value: motivo.slice(0, 1024), inline: false });

      await canalLog.send({ embeds: [embedLog] }).catch(() => null);
    }

    applications.delete(actionMessageId);
    processingLocks.delete(actionMessageId);
  } catch (e) {
    processingLocks.delete(actionMessageId);
    if (interaction && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⚠️ Erro ao processar. Verifique permissões/IDs.", ephemeral: true }).catch(() => null);
    }
  }
}

// ================== INTERACTIONS ==================
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId?.startsWith("confirm_videos:")) {
      const [, actionMessageId] = interaction.customId.split(":");
      const userId = interaction.user.id;

      await startBotIfNeeded();

      const now = new Date().toISOString();
      const r = stmtSetConfirmed.run(now, actionMessageId, userId);

      const rec = stmtGet.get(actionMessageId);
      if (!rec) {
        await interaction.reply({ content: "⚠️ Não encontrei sua inscrição.", ephemeral: true }).catch(() => null);
        return;
      }

      if (rec.status !== "APROVADO") {
        await interaction.reply({ content: "⚠️ Sua inscrição ainda não foi aprovada.", ephemeral: true }).catch(() => null);
        return;
      }

      if (rec.ticketChannelId) {
        await interaction.reply({ content: "✅ Você já confirmou antes. Seu ticket já existe.", ephemeral: true }).catch(() => null);
        return;
      }

      try {
        const guild = await client.guilds.fetch(GUILD_ID);

        const instrutores = INSTRUTORES_POR_HORARIO[rec.horarioInstrucao] || [];
        const nomeCanal = rec.nome || rec.nick || interaction.user.username;

        const ticket = await createTicketChannel({
          guild,
          candidatoId: userId,
          instrutoresIds: instrutores,
          nickOrNome: nomeCanal,
          actionMessageId
        });

        stmtSetTicketMeta.run(ticket.id, new Date().toISOString(), actionMessageId, userId);

        const mentionsInstrutores = (instrutores || []).map((id) => `<@${id}>`).join(" ");

        await ticket.send({
          content:
            `✅ <@${userId}> confirmou que assistiu os vídeos.\n` +
            `${mentionsInstrutores ? `Instrutores: ${mentionsInstrutores}\n` : ""}` +
            `Use o botão abaixo para finalizar o canal quando terminar.`,
          components: [ticketControlsRow(actionMessageId)]
        }).catch(() => null);

        if (r.changes > 0) {
          await interaction.reply({ content: "✅ Confirmado! Ticket criado no servidor.", ephemeral: true }).catch(() => null);
        } else {
          await interaction.reply({ content: "✅ Ticket criado (você já tinha confirmado antes).", ephemeral: true }).catch(() => null);
        }
      } catch (e) {
        console.log("❌ Falha ao criar ticket no confirmar:", e);
        const msg =
          `⚠️ Confirmei, mas não consegui criar o ticket.\n` +
          `Erro: **${e?.code || "sem_code"}** | ${e?.message || String(e)}\n` +
          `TICKET_CATEGORY_ID: **${TICKET_CATEGORY_ID ? "OK" : "VAZIO"}**`;

        await interaction.reply({ content: msg, ephemeral: true }).catch(() => null);
      }
      return;
    }

    if (interaction.customId?.startsWith("ticket_finalize:")) {
      if (!canManageTicket(interaction.member)) {
        return interaction.reply({ content: "❌ Você não tem permissão para finalizar este canal.", ephemeral: true }).catch(() => null);
      }
      const [, actionMessageId] = interaction.customId.split(":");
      return interaction.reply({
        content: "⚠️ Tem certeza que deseja **EXCLUIR** este canal?",
        components: [ticketFinalizeConfirmRow(actionMessageId)],
        ephemeral: true
      }).catch(() => null);
    }

    if (interaction.customId?.startsWith("ticket_finalize_confirm:")) {
      if (!canManageTicket(interaction.member)) {
        return interaction.reply({ content: "❌ Você não tem permissão.", ephemeral: true }).catch(() => null);
      }

      await interaction.reply({ content: "🗑️ Canal será excluído em 3s...", ephemeral: true }).catch(() => null);

      const ch = interaction.channel;
      setTimeout(async () => {
        await ch?.delete("Finalizado por recrutador/instrutor").catch(() => null);
      }, 3000);
      return;
    }

    if (interaction.customId?.startsWith("ticket_finalize_cancel:")) {
      return interaction.reply({ content: "✅ Cancelado.", ephemeral: true }).catch(() => null);
    }

    if (!isRecrutador(interaction.member)) {
      return interaction.reply({ content: "❌ Apenas recrutadores podem usar isso.", ephemeral: true });
    }

    const actionMessageId = interaction.message.id;

    if (interaction.customId === "aprovar") {
      return handleDecision({
        actionMessageId,
        decidedById: interaction.user.id,
        isAprovar: true,
        motivo: null,
        interaction
      });
    }

    if (interaction.customId === "reprovar") {
      const modal = new ModalBuilder()
        .setCustomId(`modal_reprovar:${actionMessageId}`)
        .setTitle("Motivo da Reprovação");

      const motivoInput = new TextInputBuilder()
        .setCustomId("motivo")
        .setLabel("Explique o motivo (obrigatório)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(600);

      modal.addComponents(new ActionRowBuilder().addComponents(motivoInput));
      return interaction.showModal(modal);
    }
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    if (!interaction.customId?.startsWith("modal_reprovar:")) return;

    if (!isRecrutador(interaction.member)) {
      return interaction.reply({ content: "❌ Apenas recrutadores podem usar isso.", ephemeral: true });
    }

    const [, actionMessageId] = interaction.customId.split(":");
    const motivo = (interaction.fields.getTextInputValue("motivo") || "").trim();

    if (!motivo) {
      return interaction.reply({ content: "❌ Motivo obrigatório.", ephemeral: true });
    }

    return handleDecision({
      actionMessageId,
      decidedById: interaction.user.id,
      isAprovar: false,
      motivo,
      interaction
    });
  }
});

// ================== /fechar (texto) no ticket ==================
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const content = (message.content || "").trim();
    if (!content.startsWith("/fechar")) return;

    const ch = message.channel;
    if (!ch?.topic?.includes("actionMessageId=")) {
      return message.reply("⚠️ Esse comando só funciona dentro de um ticket de instrução.").catch(() => null);
    }

    if (!canManageTicket(message.member)) {
      return message.reply("❌ Você não tem permissão para fechar este ticket.").catch(() => null);
    }

    const reason = content.replace("/fechar", "").trim() || "Fechado manualmente";
    await closeTicketChannel({ channel: ch, closedBy: message.author.id, reason });

    const topic = ch.topic || "";
    const actionMatch = topic.match(/actionMessageId=([0-9]+)/);
    const actionMessageId = actionMatch?.[1];
    if (actionMessageId) {
      stmtCloseTicket.run(new Date().toISOString(), actionMessageId, ch.id);
    }
  } catch {}
});

// ================== JOBS (só rodam depois do bot ligar) ==================
async function expireOldActionsJob() {
  try {
    const rows = stmtGetPendentes.all();
    if (!rows?.length) return;

    const now = Date.now();
    const expireMs = ACTION_EXPIRE_DAYS * 24 * 60 * 60 * 1000;

    const canal = await fetchRecruitmentChannel().catch(() => null);
    if (!canal) return;

    for (const r of rows) {
      const createdAtMs = Date.parse(r.createdAt);
      if (!createdAtMs) continue;

      if (now - createdAtMs >= expireMs) {
        const mark = stmtMarkExpired.run(new Date().toISOString(), r.actionMessageId);
        if (mark.changes === 0) continue;

        const msg = await canal.messages.fetch(r.actionMessageId).catch(() => null);
        if (!msg) continue;

        const content = msg.content || "";
        const suffix = "\n⏳ **Expirado automaticamente** (botões desativados).";
        const newContent = content.includes("Expirado automaticamente") ? content : (content + suffix);

        await msg.edit({
          content: newContent,
          components: [disabledActionRow("Expirado")]
        }).catch(() => null);
      }
    }
  } catch (e) {
    console.log("⚠️ Job expiração falhou:", e?.message || e);
  }
}

async function autoCloseTicketsJob() {
  try {
    const rows = stmtApprovedWithTicket.all();
    if (!rows?.length) return;

    const now = Date.now();
    const closeMs = TICKET_AUTO_CLOSE_DAYS * 24 * 60 * 60 * 1000;
    const deleteMs = TICKET_DELETE_AFTER_CLOSE_DAYS * 24 * 60 * 60 * 1000;

    for (const r of rows) {
      if (!r.ticketChannelId || !r.ticketCreatedAt) continue;

      const createdMs = Date.parse(r.ticketCreatedAt);
      if (!createdMs) continue;

      const ch = await client.channels.fetch(r.ticketChannelId).catch(() => null);
      if (!ch) continue;

      if (!r.ticketClosedAt && (now - createdMs >= closeMs)) {
        await closeTicketChannel({
          channel: ch,
          closedBy: null,
          reason: `Auto-fechado (${TICKET_AUTO_CLOSE_DAYS}d)`
        });
        stmtCloseTicket.run(new Date().toISOString(), r.actionMessageId, r.ticketChannelId);
      }

      if (TICKET_DELETE_AFTER_CLOSE_DAYS > 0 && r.ticketClosedAt) {
        const closedMs = Date.parse(r.ticketClosedAt);
        if (closedMs && (now - closedMs >= deleteMs)) {
          await ch.send("🗑️ Ticket será removido (limpeza automática).").catch(() => null);
          await ch.delete("Auto delete ticket").catch(() => null);
        }
      }
    }
  } catch (e) {
    console.log("⚠️ Job auto-close ticket falhou:", e?.message || e);
  }
}

let jobsStarted = false;
client.on(Events.ClientReady, async () => {
  if (jobsStarted) return;
  jobsStarted = true;

  await expireOldActionsJob().catch(() => null);
  await autoCloseTicketsJob().catch(() => null);

  setInterval(() => {
    expireOldActionsJob().catch(() => null);
    autoCloseTicketsJob().catch(() => null);
  }, JOB_INTERVAL_MS);
});

//  404 em JSON para /api (e qualquer rota que cair aqui)
app.get("/error/rate_limit", (req, res) => {
  const sec = Number(req.query.sec || 60);

  res.send(`
    <html>
      <head>
        <title>Discord ocupado</title>
        <style>
          body {
            background:#0b1220;
            color:white;
            font-family:Arial;
            display:flex;
            justify-content:center;
            align-items:center;
            height:100vh;
          }
          .box {
            background:#111827;
            padding:40px;
            border-radius:10px;
            text-align:center;
            max-width:500px;
          }
          .btn {
            margin-top:20px;
            padding:10px 20px;
            background:#eab308;
            border:none;
            border-radius:6px;
            cursor:pointer;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>⚠️ Discord ocupado (limite temporário)</h2>
          <p>O Discord bloqueou temporariamente novas autorizações.</p>
          <p>Aguarde cerca de <b>${sec}</b> segundos e tente novamente.</p>
          <button class="btn" onclick="window.location='/'">
            Voltar ao formulário
          </button>
        </div>
      </body>
    </html>
  `);
});
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Rota não encontrada." });
});

//  handler de erro (garante JSON em 500)
app.use((err, req, res, next) => {
  console.error("Erro não tratado:", err);
  res.status(500).json({ ok: false, error: "Erro interno." });
});

// ================== START (SITE SEMPRE) ==================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});

// ❗️não damos client.login aqui (sob demanda)