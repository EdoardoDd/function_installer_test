"use strict";

/**
 * ingressBaseline.js — crea/aggiorna le due IngressRoute di baseline per
 * una funzione su un sito, portando dentro il controller la logica finora
 * in tools/install-function-baseline.sh (che resta comunque utilizzabile
 * a mano per un intervento una tantum, ma non e' piu' l'unico posto dove
 * questa logica vive).
 *
 * <fn>-local    (entryPoint "web"):      baseline, "servi localmente". Se
 *               questo sito diventa attivo per un workflow su questa
 *               funzione, workflow-master la SOVRASCRIVE (stesso nome)
 *               con la versione pesata - nessun conflitto, e' voluto.
 * <fn>-internal (entryPoint "internal"): sempre "servi localmente", MAI
 *               toccata da workflow-master - e' il target dei puntatori
 *               mesh, rompe la ricorsione dello split.
 *
 * Nessuno split qui: entrambe puntano SEMPRE a kourier-internal al 100%,
 * stesso comportamento esatto dello script originale (incluso il
 * dettaglio che solo la "-internal" porta passHostHeader: true).
 */

const { applyCustomObject } = require("./customObjects");
const { NAMESPACE, FUNCTION_NAMESPACE, TRAEFIK_GROUP, TRAEFIK_VERSION } = require("./config");

/**
 * Crea/aggiorna le due IngressRoute di baseline per "fn" sul cluster
 * identificato da clients (client scoped del sito, da getClientsForSite).
 * Idempotente (create-or-patch via applyCustomObject).
 */
async function ensureBaselineIngressRoutes(clients, fn) {
  const host = `${fn}.${FUNCTION_NAMESPACE}.svc.cluster.local`;

  const localIr = {
    apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
    kind: "IngressRoute",
    metadata: { name: `${fn}-local`, namespace: NAMESPACE },
    spec: {
      entryPoints: ["web"],
      routes: [
        {
          match: `Host(\`${host}\`)`,
          kind: "Rule",
          services: [{ name: "kourier-internal", namespace: "kourier-system", port: 80 }],
        },
      ],
    },
  };

  const internalIr = {
    apiVersion: `${TRAEFIK_GROUP}/${TRAEFIK_VERSION}`,
    kind: "IngressRoute",
    metadata: { name: `${fn}-internal`, namespace: NAMESPACE },
    spec: {
      entryPoints: ["internal"],
      routes: [
        {
          match: `Host(\`${host}\`)`,
          kind: "Rule",
          services: [{ name: "kourier-internal", namespace: "kourier-system", port: 80, passHostHeader: true }],
        },
      ],
    },
  };

  await applyCustomObject(clients.customApi, TRAEFIK_GROUP, TRAEFIK_VERSION, "ingressroutes", localIr);
  await applyCustomObject(clients.customApi, TRAEFIK_GROUP, TRAEFIK_VERSION, "ingressroutes", internalIr);
}

module.exports = { ensureBaselineIngressRoutes };
