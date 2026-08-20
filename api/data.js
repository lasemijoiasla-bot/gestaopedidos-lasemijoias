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
    const [revendedores, abertos, baixados, vendas] = await Promise.all([
      fetchAllRevendedores(),
      fetchAllPages("/pedido?status=1"),
      fetchAllPages("/pedido?status=2"),
      fetchAllPages("/venda?status=1"),
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
        supervisora: p.supervisor_nome || null,
        valorTotal,
        valorPreBaixa,
        dataPedido: criacaoDate.toLocaleDateString("pt-BR"),
        dataAcerto: acertoDate.toLocaleDateString("pt-BR"),
        diasEmAberto,
        diasAteAcerto,
        semMovimentacao: diasEmAberto > 7 && valorPreBaixa === 0,
        abaixoMeta: diasAteAcerto <= 10 && valorPreBaixa < meta,
        status: "aberto",
      };
    });

    // Baixados recentes (mesma janela usada no sync completo) para o
    // Acompanhamento nao perder consultoras que baixaram entre um sync e outro.
    const janelaDe = new Date(today);
    janelaDe.setMonth(janelaDe.getMonth() - 3);
    const janelaAte = new Date(today);
    janelaAte.setMonth(janelaAte.getMonth() + 2);

    const itemsBaixados = [];
    for (const p of baixados) {
      if (!p.data_acerto) continue;
      const acertoDate = new Date((p.data_acerto || "").split(" ")[0]);
      if (isNaN(acertoDate.getTime())) continue;
      let baixaDate = null;
      if (p.data_baixa) {
        const bd = new Date((p.data_baixa || "").split(" ")[0]);
        if (!isNaN(bd.getTime())) baixaDate = bd;
      }
      const dentroPelaAcerto = acertoDate >= janelaDe && acertoDate <= janelaAte;
      const dentroPelaBaixa = baixaDate && baixaDate >= janelaDe && baixaDate <= janelaAte;
      if (!dentroPelaAcerto && !dentroPelaBaixa) continue;

      const criacaoDateB = new Date((p.data_criacao || "").split(" ")[0]);
      const revIdB = p.comprador ? String(p.comprador.id) : null;
      const revInfoB = revIdB ? revMap[revIdB] : null;
      const valorTotalB = parseFloat(p.valor_total) || 0;

      itemsBaixados.push({
        codigo: p.codigo_pedido,
        revendedora: p.comprador ? p.comprador.nome : "-",
        nivel: revInfoB ? revInfoB.nivel : "BASICA",
        meta: revInfoB ? revInfoB.meta : 500,
        cidade: revInfoB ? revInfoB.cidade : null,
        telefone: revInfoB ? revInfoB.telefone : null,
        supervisora: p.supervisor_nome || null,
        valorTotal: valorTotalB,
        valorPreBaixa: valorTotalB,
        dataPedido: isNaN(criacaoDateB.getTime()) ? acertoDate.toLocaleDateString("pt-BR") : criacaoDateB.toLocaleDateString("pt-BR"),
        dataAcerto: acertoDate.toLocaleDateString("pt-BR"),
        dataBaixa: baixaDate ? baixaDate.toLocaleDateString("pt-BR") : null,
        diasEmAberto: 0,
        diasAteAcerto: 0,
        semMovimentacao: false,
        abaixoMeta: false,
        status: "baixado",
      });
    }

    const rankGrouped = {};
    const resumoSupervisorGrouped = {};
    let resumoBaixadoMes = { mes: mesAtual, total: 0, qtd: 0 };
    for (const p of baixados) {
      if (!p.data_baixa) continue;
      const mesRef = p.data_baixa.split(" ")[0].slice(0, 7);
      if (mesRef !== mesAtual) continue;

      const valor = parseFloat(p.valor_total) || 0;
      resumoBaixadoMes.total += valor;
      resumoBaixadoMes.qtd += 1;

      if (p.supervisor_nome) {
        const keySup = `${mesRef}|${p.supervisor_nome}`;
        if (!resumoSupervisorGrouped[keySup]) {
          resumoSupervisorGrouped[keySup] = { mes: mesRef, supervisora: p.supervisor_nome, total: 0, qtd: 0 };
        }
        resumoSupervisorGrouped[keySup].total += valor;
        resumoSupervisorGrouped[keySup].qtd += 1;
      }

      const revId = p.comprador ? String(p.comprador.id) : null;
      const revInfo = revId ? revMap[revId] : null;
      const nivelRanking = revInfo ? revInfo.nivel : "BASICA";
      const key = `${mesRef}|${nivelRanking}|${revId}`;
      if (!rankGrouped[key]) {
        rankGrouped[key] = { mes: mesRef, nivel: nivelRanking, revendedora: p.comprador ? p.comprador.nome : "-", supervisora: p.supervisor_nome || null, total: 0, qtd: 0 };
      }
      rankGrouped[key].total += valor;
      rankGrouped[key].qtd += 1;
    }
    const rankingMesAtual = Object.values(rankGrouped);
    const resumoSupervisoraMes = Object.values(resumoSupervisorGrouped);

    let resumoVendaMes = { mes: mesAtual, total: 0, qtd: 0 };
    for (const v of vendas) {
      if (!v.data_criacao) continue;
      const mesRef = v.data_criacao.split(" ")[0].slice(0, 7);
      if (mesRef !== mesAtual) continue;
      resumoVendaMes.total += parseFloat(v.valor_final) || 0;
      resumoVendaMes.qtd += 1;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      updatedAt: now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      items,
      itemsBaixados,
      mesAtual,
      resumoBaixadoMes,
      rankingMesAtual,
      resumoSupervisoraMes,
      resumoVendaMes,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
