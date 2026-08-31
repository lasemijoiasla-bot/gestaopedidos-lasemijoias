import Redis from "ioredis";

let redisClient = null;
function getRedis() {
  if (!redisClient) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL nao configurada na Vercel.");
    redisClient = new Redis(url);
  }
  return redisClient;
}

function mesAtualSaoPaulo() {
  const now = new Date();
  const str = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  return str.slice(0, 7);
}

function linhaVazia() {
  return {
    situacaoPg: "",
    pedidoProximoMes: "",
    responsavelMontagem: "",
    checklist: "",
    assunto: "",
    dataUltimoContato: "",
    obs: "",
  };
}

function normConsultora(nome) {
  return String(nome || "").toLowerCase();
}

const CAMPOS_TEXTO = ["pedidoProximoMes", "obs", "dataUltimoContato"];
const CAMPOS_SELECT = ["situacaoPg", "checklist", "assunto"];
const RESPONSAVEIS_KEY = "acompanhamento:responsaveis";
const RETENCAO_DIAS = 90;

async function limparBucketsAntigos(redis) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENCAO_DIAS);
  const cutoffMes = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}`;
  const keys = await redis.keys("acompanhamento:*");
  const paraApagar = keys.filter((k) => {
    const mesChave = k.slice("acompanhamento:".length);
    return /^\d{4}-\d{2}$/.test(mesChave) && mesChave < cutoffMes;
  });
  if (paraApagar.length > 0) {
    await redis.del(...paraApagar);
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const redis = getRedis();
    const mes = (req.query && req.query.mes) || mesAtualSaoPaulo();
    const key = `acompanhamento:${mes}`;

    if (req.method === "GET") {
      const raw = await redis.get(key);
      const dados = raw ? JSON.parse(raw) : { linhas: {} };
      const rawResp = await redis.get(RESPONSAVEIS_KEY);
      const responsaveis = rawResp ? JSON.parse(rawResp) : {};
      try { await limparBucketsAntigos(redis); } catch (e) { /* limpeza nao deve derrubar a leitura */ }
      res.status(200).json({ mes, linhas: dados.linhas || {}, responsaveis: responsaveis || {} });
      return;
    }

    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");

      if (body.campo === "responsavelMontagem") {
        const consultora = String(body.consultora || "").trim();
        if (!consultora) {
          res.status(400).json({ error: "consultora obrigatoria" });
          return;
        }
        const rawResp = await redis.get(RESPONSAVEIS_KEY);
        const responsaveis = rawResp ? JSON.parse(rawResp) : {};
        responsaveis[normConsultora(consultora)] = String(body.valor || "").slice(0, 60);
        await redis.set(RESPONSAVEIS_KEY, JSON.stringify(responsaveis));

        const raw = await redis.get(key);
        const dados = raw ? JSON.parse(raw) : { linhas: {} };
        if (!dados.linhas || typeof dados.linhas !== "object") { dados.linhas = {}; }
        const codigo = String(body.codigo || "").trim();
        if (codigo) {
          if (!dados.linhas[codigo]) { dados.linhas[codigo] = linhaVazia(); }
          dados.linhas[codigo].responsavelMontagem = String(body.valor || "").slice(0, 60);
          await redis.set(key, JSON.stringify(dados));
        }

        res.status(200).json({ mes, linhas: dados.linhas, responsaveis });
        return;
      }

      const raw = await redis.get(key);
      const dados = raw ? JSON.parse(raw) : { linhas: {} };
      if (!dados.linhas || typeof dados.linhas !== "object") { dados.linhas = {}; }
      const codigo = String(body.codigo || "").trim();
      if (!codigo) {
        res.status(400).json({ error: "codigo obrigatorio" });
        return;
      }
      if (!dados.linhas[codigo]) { dados.linhas[codigo] = linhaVazia(); }

      if (CAMPOS_TEXTO.indexOf(body.campo) >= 0) {
        dados.linhas[codigo][body.campo] = String(body.valor || "").slice(0, 300);
      } else if (CAMPOS_SELECT.indexOf(body.campo) >= 0) {
        dados.linhas[codigo][body.campo] = String(body.valor || "").slice(0, 60);
      } else {
        res.status(400).json({ error: "campo invalido" });
        return;
      }

      await redis.set(key, JSON.stringify(dados));
      res.status(200).json({ mes, linhas: dados.linhas });
      return;
    }

    res.status(405).json({ error: "Metodo nao suportado" });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
