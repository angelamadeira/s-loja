/* Passkey (WebAuthn) no navegador — Admin Suzu.
   Faz a ponte entre o servidor e a API do aparelho (Face ID / digital / PIN).
   Sem biblioteca: só a conversão base64url <-> ArrayBuffer que a API exige.
   A verificação criptográfica de verdade acontece no SERVIDOR (src/passkey.js). */
(function (global) {
  function deB64url(s) {
    var b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function b64url(buf) {
    var arr = new Uint8Array(buf);
    var bin = "";
    for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // O navegador exige ArrayBuffer onde o servidor mandou base64url.
  function prepCriar(o) {
    o.challenge = deB64url(o.challenge);
    o.user.id = deB64url(o.user.id);
    if (o.excludeCredentials) o.excludeCredentials = o.excludeCredentials.map(function (c) {
      return { id: deB64url(c.id), type: c.type || "public-key", transports: c.transports };
    });
    return o;
  }
  function prepObter(o) {
    o.challenge = deB64url(o.challenge);
    if (o.allowCredentials) o.allowCredentials = o.allowCredentials.map(function (c) {
      return { id: deB64url(c.id), type: c.type || "public-key", transports: c.transports };
    });
    return o;
  }

  // Serializa a credencial no formato que o servidor (@simplewebauthn) espera.
  function serializaRegistro(cred) {
    return {
      id: cred.id,
      rawId: b64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: b64url(cred.response.clientDataJSON),
        attestationObject: b64url(cred.response.attestationObject),
        transports: cred.response.getTransports ? cred.response.getTransports() : undefined,
      },
    };
  }
  function serializaLogin(cred) {
    return {
      id: cred.id,
      rawId: b64url(cred.rawId),
      type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: {
        clientDataJSON: b64url(cred.response.clientDataJSON),
        authenticatorData: b64url(cred.response.authenticatorData),
        signature: b64url(cred.response.signature),
        userHandle: cred.response.userHandle ? b64url(cred.response.userHandle) : undefined,
      },
    };
  }

  function post(url, corpo) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo || {}),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; });
    });
  }

  var Passkey = {
    suportado: function () {
      return !!(global.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
    },
    // Cadastra este aparelho (exige estar logada)
    cadastrar: function () {
      return post("/api/admin/passkey/registrar-inicio")
        .then(function (r) {
          if (!r.j || !r.j.ok) throw new Error("inicio");
          return navigator.credentials.create({ publicKey: prepCriar(r.j.options) });
        })
        .then(function (cred) {
          if (!cred) throw new Error("cancelado");
          return post("/api/admin/passkey/registrar-fim", serializaRegistro(cred));
        })
        .then(function (r) {
          if (!r.j || !r.j.ok) throw new Error((r.j && r.j.erro) || "falha");
          return true;
        });
    },
    // Entra com Face ID / digital
    entrar: function () {
      return post("/api/admin/passkey/login-inicio")
        .then(function (r) {
          if (!r.j || !r.j.ok) throw new Error("inicio");
          return navigator.credentials.get({ publicKey: prepObter(r.j.options) });
        })
        .then(function (cred) {
          if (!cred) throw new Error("cancelado");
          return post("/api/admin/passkey/login-fim", serializaLogin(cred));
        })
        .then(function (r) {
          if (!r.j || !r.j.ok) throw new Error((r.j && r.j.erro) || "falha");
          return true;
        });
    },
  };

  global.SuzuPasskey = Passkey;
})(window);
