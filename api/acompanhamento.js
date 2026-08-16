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

function estadoVazio() {
  return { assuntos: ["", "", "", ""], marcas: {} };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const redis = getRedis();
    const mes = (req.query && req.query.mes) || mesAtualSaoPaulo();
    const key = `acompanhamento:${mes}`;

    if (req.method === "GET") {
      const raw = await redis.get(key);
      const dados = raw ? JSON.parse(raw) : estadoVazio();
      res.status(200).json({ mes, assuntos: dados.assuntos, marcas: dados.marcas });
      return;
    }

    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
      const raw = await redis.get(key);
      const dados = raw ? JSON.parse(raw) : estadoVazio();

      if (body.tipo === "assunto") {
        const idx = parseInt(body.semanaIndex, 10);
        if (idx >= 0 && idx <= 3) {
          dados.assuntos[idx] = String(body.valor || "").slice(0, 200);
        }
      } else if (body.tipo === "marca") {
        const idx = parseInt(body.semanaIndex, 10);
        const consultora = String(body.consultora || "").trim();
        if (consultora && idx >= 0 && idx <= 3) {
          if (!dados.marcas[consultora]) { dados.marcas[consultora] = [false, false, false, false]; }
          dados.marcas[consultora][idx] = !!body.valor;
        }
      } else {
        res.status(400).json({ error: "tipo invalido" });
        return;
      }

      await redis.set(key, JSON.stringify(dados));
      res.status(200).json({ mes, assuntos: dados.assuntos, marcas: dados.marcas });
      return;
    }

    res.status(405).json({ error: "Metodo nao suportado" });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
