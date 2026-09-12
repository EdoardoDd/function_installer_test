"use strict";

/**
 * functionDeployment.js — riconciliazione di una PrismFunctionDeployment.
 *
 * STEP 3 (in validazione): per ogni sito in spec.sites, crea/aggiorna la
 * Knative Service E le due IngressRoute di baseline (portate dentro da
 * tools/install-function-baseline.sh, vedi ingressBaseline.js). Best-effort
 * per sito, stesso pattern di routingPolicy.js in workflow-master: un
 * fallimento su un sito viene loggato ma non blocca gli altri.
 *
 * Ancora TODO (prossimi step, deliberatamente non qui):
 *   - Step 4: cleanup (delete) sui siti rimossi da spec.sites, confrontando
 *     spec.sites con l'ultimo status.sites[] noto
 *   - Step 5: scrittura di status.sites[] sulla CR con l'esito per sito
 */

const { getClientsForSite } = require("./k8sClients");
const { ensureKnativeService } = require("./knativeService");
const { ensureBaselineIngressRoutes } = require("./ingressBaseline");

/** Applica Knative Service + IngressRoute di baseline su un singolo sito. */
async function installOnSite(site, fn, image) {
  const clients = await getClientsForSite(site);
  await ensureKnativeService(clients, fn, image);
  await ensureBaselineIngressRoutes(clients, fn);
  console.log(`  '${fn}' installata/aggiornata su '${site}' (image=${image}, baseline IngressRoute incluse).`);
}

/**
 * Riconcilia una PrismFunctionDeployment: per ogni sito in spec.sites,
 * installa la Knative Service + baseline. Un fallimento su un sito non
 * blocca gli altri (stesso pattern di buildAndApplyTraefikObjects in
 * workflow-master).
 */
async function reconcileFunctionDeployment(deployment) {
  const name = deployment.metadata.name;
  const { function: fn, image, sites } = deployment.spec;

  console.log(`PrismFunctionDeployment '${name}' vista: function=${fn}, image=${image}, sites=[${(sites || []).join(", ")}]`);

  for (const site of sites || []) {
    try {
      await installOnSite(site, fn, image);
    } catch (err) {
      console.error(`Impossibile installare '${fn}' su '${site}':`, err.message || err);
    }
  }
}

module.exports = { reconcileFunctionDeployment };
