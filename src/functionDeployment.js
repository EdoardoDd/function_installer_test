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
 *
 * CANCELLAZIONE DELLA CR - il ListWatch di index.js reagisce solo ad
 * "add"/"update": se la PrismFunctionDeployment viene cancellata, senza
 * altro accorgimento nessun sito verrebbe mai ripulito (la risorsa
 * sparisce e basta, nessun evento utile arriva). Si usa quindi un
 * finalizer standard: alla prima riconciliazione lo si aggiunge alla CR
 * (questo BLOCCA la cancellazione finche' non viene rimosso); quando
 * arriva un evento "update" con metadata.deletionTimestamp valorizzato
 * (kubectl ha segnato la CR per la cancellazione ma non l'ha ancora
 * rimossa, proprio perche' il finalizer e' ancora presente), si fa il
 * cleanup di TUTTI i siti conosciuti (spec.sites + status.sites, per
 * sicurezza - la CR potrebbe essere cancellata subito dopo una modifica
 * non ancora riflessa in status.sites) e infine si rimuove il finalizer,
 * a quel punto Kubernetes la cancella per davvero.
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

// Finalizer applicato ad ogni PrismFunctionDeployment: blocca la
// cancellazione finche' il cleanup sui siti non e' completato.
const CLEANUP_FINALIZER = "prism.local/function-installer-cleanup";

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
 * Sostituisce metadata.finalizers sulla CR (merge patch: un JSON merge
 * patch rimpiazza un array per intero, comportamento voluto qui - passiamo
 * sempre la lista completa gia' calcolata, mai un "delta").
 */
async function patchFinalizers(name, namespace, finalizers) {
  await customApi.patchNamespacedCustomObject(
    PRISM_GROUP,
    PRISM_VERSION,
    namespace,
    PRISM_PLURAL,
    name,
    { metadata: { finalizers } },
    undefined,
    undefined,
    undefined,
    MERGE_PATCH_OPTS
  );
}

/**
 * Cancellazione in corso (metadata.deletionTimestamp valorizzato): pulisce
 * TUTTI i siti conosciuti - unione di spec.sites e status.sites, cosi' un
 * sito aggiunto/rimosso appena prima della cancellazione (magari non
 * ancora riflesso in status.sites) viene comunque ripulito - poi rimuove
 * il finalizer per lasciare completare la cancellazione a Kubernetes.
 */
async function finalizeFunctionDeployment(deployment) {
  const name = deployment.metadata.name;
  const namespace = deployment.metadata.namespace;
  const finalizers = deployment.metadata.finalizers || [];

  if (!finalizers.includes(CLEANUP_FINALIZER)) {
    // Gia' finalizzata (o mai stata finalizzata) - nulla da fare.
    return;
  }

  const fn = deployment.spec.function;
  const specSites = deployment.spec.sites || [];
  const statusSites = ((deployment.status && deployment.status.sites) || []).map((s) => s.site);
  const allKnownSites = [...new Set([...specSites, ...statusSites])];

  console.log(`PrismFunctionDeployment '${name}' in cancellazione: cleanup di '${fn}' su [${allKnownSites.join(", ")}]`);

  for (const site of allKnownSites) {
    try {
      await uninstallFromSite(site, fn);
    } catch (err) {
      console.error(`Impossibile rimuovere '${fn}' da '${site}' durante la cancellazione:`, describeError(err));
      // Best-effort anche qui: un sito irraggiungibile non deve bloccare
      // per sempre la cancellazione della CR (nessun retry automatico,
      // vedi nota su retry/resync nel README - limite noto).
    }
  }

  const remainingFinalizers = finalizers.filter((f) => f !== CLEANUP_FINALIZER);
  await patchFinalizers(name, namespace, remainingFinalizers);
  console.log(`Finalizer rimosso da '${name}', cancellazione della CR completata da Kubernetes.`);
}

/**
 * Riconcilia una PrismFunctionDeployment: cleanup sui siti rimossi da
 * spec.sites (Step 4), poi install/update best-effort sui siti desiderati,
 * poi scrittura di status.sites[] con l'esito (Step 5).
 *
 * Se la CR e' in cancellazione (deletionTimestamp valorizzato), delega
 * tutto a finalizeFunctionDeployment e NON fa il normale giro di
 * install/status - non avrebbe senso reinstallare qualcosa che sta per
 * sparire.
 */
async function reconcileFunctionDeployment(deployment) {
  const name = deployment.metadata.name;
  const namespace = deployment.metadata.namespace;

  if (deployment.metadata.deletionTimestamp) {
    await finalizeFunctionDeployment(deployment);
    return;
  }

  const finalizers = deployment.metadata.finalizers || [];
  if (!finalizers.includes(CLEANUP_FINALIZER)) {
    await patchFinalizers(name, namespace, [...finalizers, CLEANUP_FINALIZER]);
    console.log(`Finalizer aggiunto a '${name}' (garantisce il cleanup dei siti se la CR viene cancellata).`);
  }

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