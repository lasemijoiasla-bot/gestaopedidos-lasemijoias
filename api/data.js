export default async function handler(req, res) {
  const token = process.env.JUERI_API_TOKEN;
  const clienteSistema = process.env.JUERI_CLIENTE_SISTEMA;

  if (!token || !clienteSistema) {
    res.status(500).json({ error: "JUERI_API_TOKEN ou JUERI_CLIENTE_SISTEMA nao configurados na Vercel." });
    return;
  }

  const base = `https://jueri.com.br/sis/api/v1/${clienteSistema}`;
  const headers = { Authorization: `Bearer ${token}` };

  async function fetchAllPages(path) {
    let items = [];
    let page = 1;
    let lastPage = 1;
    do {
      const r = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, { headers });
      if (!r.ok) throw new Error(`Falha ao buscar ${path}: ${r.status}`);
      const j = await r.json();
      items = items.concat(j.data || []);
      lastPage = j.last_page || 1;
      page++;
    } while (page <= lastPage);
    return items;
  }

  async function fetchAllRevendedores() {
    let items = [];
    let page = 1;
    let hasNext = true;
    while (hasNext) {
      const r = await fetch(`${base}/revendedor?status=1&per_page=100&page=${page}`, { headers });
      if (!r.ok) throw new Error(`Falha ao buscar revendedor: ${r.status}`);
      const j = await r.json();
      items = items.concat(j.data || []);
      hasNext = !!j.next_page_url;
      page++;
    }
    return items;
  }

  try {
    const [revendedores, abertos, baixados] = await Promise.all([
      fetchAllRevendedores(),
      fetchAllPages("/pedido?status=1"),
      fetchAllPages("/pedido?status=2"),
    ]);

    const revMap = {};
    for (const rev of revendedores) {
      revMap[String(rev.id)] = {
        nivel: rev.level_revendedor,
        meta: parseFloat(rev.meta_mensal) || 500,
        cidade: rev.cidade,
        telefone: rev.telefone_1,
      };
    }

    const now = new Date();
    const todaySaoPauloStr = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const today = new Date(todaySaoPauloStr + "T00:00:00");
    const mesAtual = todaySaoPauloStr.slice(0, 7);

    function diffDias(a, b) {
      return Math.floor((a - b) / 86400000);
    }

    const items = abertos.map((p) => {
      const criacaoDate = new Date((p.data_criacao || "").split(" ")[0]);
      const acertoDate = new Date((p.data_acerto || "").split(" ")[0]);
      const diasEmAberto = diffDias(today, criacaoDate);
      const diasAteAcerto = diffDias(acertoDate, today);
      const valorPreBaixa = parseFloat(p.valor_pre_baixa) || 0;
      const valorTotal = parseFloat(p.valor_total) || 0;
      const revId = p.comprador ? String(p.comprador.id) : null;
      const revInfo = revId ? revMap[revId] : null;
      const meta = revInfo ? revInfo.meta : 500;
      const nivel = revInfo ? revInfo.nivel : "BASICA";

      return {
        codigo: p.codigo_pedido,
        revendedora: p.comprador ? p.comprador.nome : "-",
        nivel,
        meta,
        cidade: revInfo ? revInfo.cidade : null,
        telefone: revInfo ? revInfo.telefone : null,
        valorTotal,
        valorPreBaixa,
        dataPedido: criacaoDate.toLocaleDateString("pt-BR"),
        dataAcerto: acertoDate.toLocaleDateString("pt-BR"),
        diasEmAberto,
        diasAteAcerto,
        semMovimentacao: diasEmAberto > 7 && valorPreBaixa === 0,
        abaixoMeta: diasAteAcerto <= 10 && valorPreBaixa < meta,
      };
    });

    const rankGrouped = {};
    let resumoBaixadoMes = { mes: mesAtual, total: 0, qtd: 0 };
    for (const p of baixados) {
      if (!p.data_baixa) continue;
      const mesRef = p.data_baixa.split(" ")[0].slice(0, 7);
      if (mesRef !== mesAtual) continue;

      const valor = parseFloat(p.valor_total) || 0;
      resumoBaixadoMes.total += valor;
      resumoBaixadoMes.qtd += 1;

      const revId = p.comprador ? String(p.comprador.id) : null;
      const revInfo = revId ? revMap[revId] : null;
      if (!revInfo) continue;
      const key = `${mesRef}|${revInfo.nivel}|${revId}`;
      if (!rankGrouped[key]) {
        rankGrouped[key] = { mes: mesRef, nivel: revInfo.nivel, revendedora: p.comprador.nome, total: 0, qtd: 0 };
      }
      rankGrouped[key].total += valor;
      rankGrouped[key].qtd += 1;
    }
    const rankingMesAtual = Object.values(rankGrouped);

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      updatedAt: now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      items,
      mesAtual,
      resumoBaixadoMes,
      rankingMesAtual,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
