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
    ref,
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
      "X-Idempotency-Key": ref,
    },
    body: JSON.stringify(body),
  });

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

export async function consultaPagamento(env, id, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${MP_BASE}/${id}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
    },
  });

  const data = await res.json();

  return { id: data.id, status: data.status };
}
