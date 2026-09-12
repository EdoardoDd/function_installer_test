/**
 * function-installer — controller separato da workflow-master (ciclo di
 * vita diverso: installare una funzione e' raro, aggiustare i pesi di
 * instradamento e' continuo). Gira su cloud-node, mai su un sito edge.
 *
 * COSA FA (a regime): osserva PrismFunctionDeployment e per ogni sito in
 * spec.sites crea/aggiorna la Knative Service (cluster-local) piu' le due
 * IngressRoute di baseline, riusando lo stesso canale di credenziali
 * remote-writer gia' usato da workflow-master (nessun kubeconfig admin
 * coinvolto). Per questo controller ogni sito e' remoto — cloud-node non
 * e' mai uno dei siti nominati in spec.sites (vedi k8sClients.js).
 *
 * STEP 1 (corrente): solo il reconciliation loop di base — watch +
 * logging, nessuna scrittura remota. Vedi functionDeployment.js per il
 * piano dei prossimi step.
 *
 *  Questo file fa solo da "colla", stesso schema di index.js in
 *  workflow-master. La ciccia vera sta in:
 *   - config.js              : env e costanti varie
 *   - k8sClients.js          : client verso cluster locale, sfcc e siti remoti
 *   - customObjects.js       : helper (create-or-patch / delete) per le CRD
 *   - functionDeployment.js  : riconciliazione di PrismFunctionDeployment
 */

const k8s = require("@kubernetes/client-node");

const { NAMESPACE, PRISM_GROUP, PRISM_VERSION } = require("./config");
const { kc, customApi } = require("./k8sClients");
const { reconcileFunctionDeployment } = require("./functionDeployment");

/** Osserva le PrismFunctionDeployment e le riconcilia ad ogni cambio. */
function watchFunctionDeployments(watch) {
  const listWatch = new k8s.ListWatch(
    `/apis/${PRISM_GROUP}/${PRISM_VERSION}/namespaces/${NAMESPACE}/prismfunctiondeployments`,
    watch,
    () => customApi.listNamespacedCustomObject(PRISM_GROUP, PRISM_VERSION, NAMESPACE, "prismfunctiondeployments")
  );
  listWatch.on("add", (obj) => {
    reconcileFunctionDeployment(obj).catch((err) => console.error("Errore in reconcile (add):", err));
  });
  listWatch.on("update", (obj) => {
    reconcileFunctionDeployment(obj).catch((err) => console.error("Errore in reconcile (update):", err));
  });
  listWatch.on("error", (err) => console.error("Errore nel watch di PrismFunctionDeployment:", err));
}

async function main() {
  console.log(`function-installer avviato, NAMESPACE=${NAMESPACE}`);

  const watch = new k8s.Watch(kc);
  watchFunctionDeployments(watch);
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
