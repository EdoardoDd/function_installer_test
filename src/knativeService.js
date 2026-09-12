"use strict";

/**
 * knativeService.js — crea/aggiorna la Knative Service (serving.knative.dev/v1)
 * su un sito, a partire da una PrismFunctionDeployment. Visibility
 * "cluster-local": la funzione non deve mai essere raggiungibile
 * direttamente dall'esterno del cluster del sito, solo tramite le
 * IngressRoute di baseline (Step 3) o la tabella pesata di workflow-master.
 */

const { applyCustomObject } = require("./customObjects");
const { FUNCTION_NAMESPACE, KNATIVE_GROUP, KNATIVE_VERSION, KNATIVE_SERVICES_PLURAL } = require("./config");

/**
 * Crea/aggiorna la Knative Service per "fn"/"image" sul cluster
 * identificato da clients (client scoped del sito, da getClientsForSite).
 * Idempotente (create-or-patch via applyCustomObject).
 */
async function ensureKnativeService(clients, fn, image) {
  const body = {
    apiVersion: `${KNATIVE_GROUP}/${KNATIVE_VERSION}`,
    kind: "Service",
    metadata: {
      name: fn,
      namespace: FUNCTION_NAMESPACE,
      labels: {
        "networking.knative.dev/visibility": "cluster-local",
      },
    },
    spec: {
      template: {
        spec: {
          containers: [{ image }],
        },
      },
    },
  };

  await applyCustomObject(clients.customApi, KNATIVE_GROUP, KNATIVE_VERSION, KNATIVE_SERVICES_PLURAL, body);
}

module.exports = { ensureKnativeService };
