"use strict";

/**
 * functionDeployment.js — riconciliazione di una PrismFunctionDeployment.
 *
 * Per ogni sito in spec.sites: crea/aggiorna la Knative Service E le due
 * IngressRoute di baseline (portate dentro da
 * tools/install-function-baseline.sh, vedi ingressBaseline.js). Best-effort
 * per sito, stesso pattern di routingPolicy.js in workflow-master: un
 * fallimento su un sito viene loggato ma non blocca gli altri.
 *
 * STEP 4 - cleanup: i siti presenti nell'ultimo status.sites[] noto ma non
 * piu' in spec.sites vengono disinstallati (Knative Service + entrambe le
 * IngressRoute rimosse dal sito). status.sites[] e' quindi la fonte di
 * verita' per "dove avevamo installato la funzione l'ultima volta" - scelta
 * deliberata rispetto all'alternativa di interrogare live tutti i siti
 * storicamente noti: piu' semplice, e sufficiente perche' e' lo stesso
 * controller a scrivere quello stato ad ogni riconciliazione (Step 5).
 *
 * STEP 5 - status: dopo il giro di install/cleanup, scrive status.sites[]
 * con l'esito per sito (installed/error + message). Richiede che il CRD
 * dichiari "subresources: status" (altrimenti l'RBAC su
 * "prismfunctiondeployments/status" non ha nessun endpoint a cui
 * applicarsi) - vedi crds/prism-functiondeployment-crd.yaml.
 */

const { getClientsForSite, customApi } = require("./k8sClients");
const { ensureKnativeService } = require("./knativeService");
const { ensureBaselineIngressRoutes } = require("./ingressBaseline");
const { deleteCustomObject } = require("./customObjects");
const {
  NAMESPACE,
  FUNCTION_NAMESPACE,
  PRISM_GROUP,
  PRISM_VERSION,
  KNATIVE_GROUP,
  KNATIVE_VERSION,
  KNATIVE_SERVICES_PLURAL,
  TRAEFIK_GROUP,
  TRAEFIK_VERSION,
  MERGE_PATCH_OPTS,
} = require("./config");

const PRISM_PLURAL = "prismfunctiondeployments";

/** Applica Knative Service + IngressRoute di baseline su un singolo sito. */
async function installOnSite(site, fn, image) {
  const clients = await getClientsForSite(site);
  await ensureKnativeService(clients, fn, image);
  await ensureBaselineIngressRoutes(clients, fn);
  console.log(`  '${fn}' installata/aggiornata su '${site}' (image=${image}, baseline IngressRoute incluse).`);
}

/**
 * Rimuove Knative Service + entrambe le IngressRoute di baseline da un
 * sito uscito da spec.sites. Idempotente (deleteCustomObject tollera 404).
 */
async function uninstallFromSite(site, fn) {
  const clients = await getClientsForSite(site);
  await deleteCustomObject(clients.customApi, KNATIVE_GROUP, KNATIVE_VERSION, FUNCTION_NAMESPACE, KNATIVE_SERVICES_PLURAL, fn);
  await deleteCustomObject(clients.customApi, TRAEFIK_GROUP, TRAEFIK_VERSION, NAMESPACE, "ingressroutes", `${fn}-local`);
  await deleteCustomObject(clients.customApi, TRAEFIK_GROUP, TRAEFIK_VERSION, NAMESPACE, "ingressroutes", `${fn}-internal`);
  console.log(`  '${fn}' rimossa da '${site}' (non piu' in spec.sites).`);
}

/** Estrae dettagli utili da un errore del client fetch-based di @kubernetes/client-node. */
function describeError(err) {
  const statusCode = err?.statusCode ?? err?.response?.statusCode;
  const cause = err?.cause?.message || err?.cause;
  const body = typeof err?.body === "string" ? err.body : JSON.stringify(err?.body?.message || err?.body || "");
  const parts = [err.message || String(err)];
  if (statusCode) parts.push(`statusCode=${statusCode}`);
  if (cause) parts.push(`cause=${cause}`);
  if (body && body !== '""') parts.push(`body=${body}`);
  return parts.join(" | ");
}

/** Scrive status.sites[] sulla CR (subresource /status, merge patch). */
async function patchStatus(name, namespace, sitesStatus) {
  const body = { status: { sites: sitesStatus } };
  try {
    await customApi.patchNamespacedCustomObjectStatus(
      PRISM_GROUP,
      PRISM_VERSION,
      namespace,
      PRISM_PLURAL,
      name,
      body,
      undefined,
      undefined,
      undefined,
      MERGE_PATCH_OPTS
    );
  } catch (err) {
    console.error(`Impossibile aggiornare status di '${name}':`, describeError(err));
  }
}

/**
 * Riconcilia una PrismFunctionDeployment: cleanup sui siti rimossi da
 * spec.sites (Step 4), poi install/update best-effort sui siti desiderati,
 * poi scrittura di status.sites[] con l'esito (Step 5).
 */
async function reconcileFunctionDeployment(deployment) {
  const name = deployment.metadata.name;
  const namespace = deployment.metadata.namespace;
  const { function: fn, image, sites } = deployment.spec;
  const desiredSites = sites || [];
  const previousSites = ((deployment.status && deployment.status.sites) || []).map((s) => s.site);

  console.log(`PrismFunctionDeployment '${name}' vista: function=${fn}, image=${image}, sites=[${desiredSites.join(", ")}]`);

  const removedSites = previousSites.filter((s) => !desiredSites.includes(s));
  for (const site of removedSites) {
    try {
      await uninstallFromSite(site, fn);
    } catch (err) {
      console.error(`Impossibile rimuovere '${fn}' da '${site}':`, describeError(err));
    }
  }

  const sitesStatus = [];
  for (const site of desiredSites) {
    try {
      await installOnSite(site, fn, image);
      sitesStatus.push({ site, state: "installed", message: "" });
    } catch (err) {
      const message = describeError(err);
      console.error(`Impossibile installare '${fn}' su '${site}':`, message);
      sitesStatus.push({ site, state: "error", message });
    }
  }

  await patchStatus(name, namespace, sitesStatus);
}

module.exports = { reconcileFunctionDeployment };