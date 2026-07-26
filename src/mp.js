// Cliente fino da API REST do Mercado Pago — isolado do resto do sistema.
//
// Único ponto do código que fala com o MP. Faz o `fetch` bruto (sem SDK),
// recebendo `fetchImpl` como último parâmetro (default `globalThis.fetch`)
// pra permitir mock nos testes — nenhuma chamada de rede real acontece aqui
// em test.
//
// Fronteira de unidade: em TODO o resto do sistema o dinheiro é centavos
// (Number inteiro). O MP exige o valor em REAIS (`transaction_amount`).
// A conversão `totalCents / 100` acontece só nesta borda, em `criaPagamento`.

const MP_BASE = "https://api.mercadopago.com/v1/payments";

export async function criaPagamento(env, params, fetchImpl = globalThis.fetch) {
  const {
    totalCents,
    metodo,
    parcelas = 1,
    token,
    paymentMethodId,
    issuerId,
    cpf,
    email,
    // uuid da compra (não o `ref` curto de 6 hex) — protege contra colisão
    // de idempotência entre pedidos diferentes (ver "MP idempotency key" no
    // relatório do Fase4a). `ref` continua existindo só como referência
    // humana em `descricao`.
    idempotencyKey,
    descricao,
  } = params || {};

  const body = {
    transaction_amount: totalCents / 100,
    description: descricao,
    payment_method_id: metodo === "pix" ? "pix" : paymentMethodId,
    installments: parcelas,
    payer: {
      email,
      identification: { type: "CPF", number: cpf },
    },
  };
  if (metodo !== "pix" && token) {
    body.token = token;
  }
  if (metodo !== "pix" && issuerId) {
    body.issuer_id = issuerId;
  }

  const res = await fetchImpl(MP_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  // Erro do MP (token de cartão inválido/expirado, 4xx/5xx) não tem `status`
  // no corpo — sem este guard, `data.status` vira undefined e o chamador
  // (handlePagar) mapeava isso pra "pendente" por padrão, guardando uma
  // tentativa de cartão RECUSADA como se estivesse esperando confirmação
  // (tela de Pix com QR em branco). Devolve um resultado tipado em vez de
  // lançar — handlePagar decide o status interno (ver IMPORTANTE #2).
  if (!res.ok) {
    let statusDetail;
    try {
      const errBody = await res.json();
      statusDetail = (errBody && (errBody.message || errBody.error)) || `http_${res.status}`;
    } catch (_) {
      statusDetail = `http_${res.status}`;
    }
    return { status: "error", statusDetail };
  }

  const data = await res.json();

  const resultado = {
    id: data.id,
    status: data.status,
    statusDetail: data.status_detail,
  };

  if (metodo === "pix") {
    const txData = data.point_of_interaction && data.point_of_interaction.transaction_data;
    if (txData) {
      resultado.pix = {
        qrBase64: txData.qr_code_base64,
        copiaECola: txData.qr_code,
      };
    }
  }

  return resultado;
}

// GET /v1/payments/{id} com o QR/copia-e-cola do Pix, quando existir — usado por
// GET /api/compra pra devolver o Pix atual de uma compra pendente numa tela
// retornável (/pix/<ref>): a página pode ser recarregada/reaberta sem ter o QR
// gerado no momento de /api/pagar, então precisa buscar de novo do MP.
export async function consultaPagamentoFull(env, id, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${MP_BASE}/${id}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
    },
  });

  // 4xx/5xx do MP (ou corpo não-JSON): degrada sem lançar — status undefined faz
  // o chamador (webhook/handleCompra) tratar como "sem novidade" e tentar depois,
  // em vez de estourar uma exceção que viraria 500 sem corpo.
  if (!res.ok) return { id, status: undefined };

  const data = await res.json();

  const resultado = { id: data.id, status: data.status };
  const txData = data.point_of_interaction && data.point_of_interaction.transaction_data;
  if (txData) {
    resultado.pix = {
      qrBase64: txData.qr_code_base64,
      copiaECola: txData.qr_code,
    };
  }
  return resultado;
}

// Mantida por compatibilidade (usada pelo webhook) — só {id,status}, nunca pix.
export async function consultaPagamento(env, id, fetchImpl = globalThis.fetch) {
  const full = await consultaPagamentoFull(env, id, fetchImpl);
  return { id: full.id, status: full.status };
}
