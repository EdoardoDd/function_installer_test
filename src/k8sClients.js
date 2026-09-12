"use strict";

/**
 * k8sClients.js — client @kubernetes/client-node usati da function-installer:
 * quello in-cluster (il nostro, su cloud-node — usato solo per
 * osservare/aggiornare lo status delle PrismFunctionDeployment, MAI per
 * scrivere Knative Service o IngressRoute), quello verso sfcc (sola
 * lettura, lazy, stesso canale di workflow-master), e quelli verso i
 * cluster remoti dei siti edge (scoped, letti dal Secret depositato da
 * FileGetter — stesso identico canale di credenziali, nessuna
 * duplicazione).
 *
 * DIFFERENZA rispetto a workflow-master/k8sClients.js: qui NON esiste un
 * ramo "locale" in getClientsForSite. cloud-node non e' mai uno dei siti
 * in spec.sites, quindi per questo controller ogni sito e' sempre remoto —
 * niente caso speciale.
 *
 * ATTENZIONE: le firme dei metodi di @kubernetes/client-node cambiano tra
 * major version (parametri posizionali vs oggetto opzioni). Se una
 * chiamata *Api fallisce con un errore relativo agli argomenti, verificare
 * la versione installata (`npm ls @kubernetes/client-node`) e adattare la
 * forma della chiamata di conseguenza — non e' un problema di logica.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const k8s = require("@kubernetes/client-node");

const { SFCC_KUBECONFIG_PATH, REMOTE_WRITER_NAMESPACE } = require("./config");

// --- Client in-cluster (il nostro cluster locale, cloud-node) -----------
// Usato SOLO per osservare le PrismFunctionDeployment e patchare il loro
// status: mai per scrivere Knative Service/IngressRoute su un sito, che
// passano sempre da getClientsForSite().

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

// --- Client verso sfcc, SOLO in lettura ---------------------------------
// Identico a workflow-master: caricato pigramente cosi' il controller puo'
// partire anche prima che il Secret verso sfcc sia disponibile, invece di
// andare in CrashLoopBackOff.

let sfccKcInstance = null;
function getSfccKc() {
  if (!sfccKcInstance) {
    const sfccKc = new k8s.KubeConfig();
    sfccKc.loadFromFile(SFCC_KUBECONFIG_PATH); // se fallisce, sfccKcInstance resta null: si ritenta al prossimo giro
    sfccKcInstance = sfccKc;
  }
  return sfccKcInstance;
}
function getSfccCoreApi() {
  return getSfccKc().makeApiClient(k8s.CoreV1Api);
}

// --- Client scoped verso i cluster remoti dei siti edge -----------------

const REMOTE_KUBECONFIG_DIR = os.tmpdir();
const remoteKcCache = new Map();

/**
 * Ritorna il KubeConfig scoped per il sito indicato. Legge il kubeconfig
 * da un Secret su sfcc (namespace REMOTE_WRITER_NAMESPACE, nome
 * "remote-writer-<site>") — STESSO Secret gia' usato da workflow-master,
 * nessun canale nuovo. Cache in-memory: letto una volta sola.
 */
async function getRemoteKc(site) {
  if (remoteKcCache.has(site)) {
    return remoteKcCache.get(site);
  }

  const secretName = `remote-writer-${site}`;
  let secret;
  try {
    const res = await getSfccCoreApi().readNamespacedSecret(secretName, REMOTE_WRITER_NAMESPACE);
    secret = res.body;
  } catch (err) {
    throw new Error(
      `Impossibile leggere il Secret '${secretName}' su sfcc (namespace '${REMOTE_WRITER_NAMESPACE}'): ${err.message || err}. ` +
        `Verifica che il FileGetter per '${site}' sia stato applicato ed eseguito con successo.`
    );
  }

  const encoded = secret.data && secret.data.kubeconfig;
  if (!encoded) {
    throw new Error(`Il Secret '${secretName}' non ha la chiave 'kubeconfig'.`);
  }
  const content = Buffer.from(encoded, "base64").toString("utf8");

  const tmpPath = path.join(REMOTE_KUBECONFIG_DIR, `function-installer-remote-kubeconfig-${site}.yaml`);
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });

  const remoteKc = new k8s.KubeConfig();
  remoteKc.loadFromFile(tmpPath);
  remoteKcCache.set(site, remoteKc);
  return remoteKc;
}

/**
 * Ritorna {customApi} per il sito indicato — i client costruiti dal
 * kubeconfig scoped di quel sito. Niente ramo "locale": per
 * function-installer ogni sito e' sempre remoto (vedi commento in testa
 * al file).
 */
async function getClientsForSite(site) {
  const remoteKc = await getRemoteKc(site);
  return {
    customApi: remoteKc.makeApiClient(k8s.CustomObjectsApi),
  };
}

module.exports = {
  kc,
  customApi,
  getSfccCoreApi,
  getClientsForSite,
};
