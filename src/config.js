"use strict";

/**
 * config.js — costanti e variabili d'ambiente condivise da tutti i moduli
 * di function-installer. Nessuna logica qui: solo valori di configurazione,
 * stesso pattern di config.js in workflow-master.
 *
 * DIFFERENZA rispetto a workflow-master: qui NON esiste un concetto di
 * "sito locale" (LOCAL_SITE). function-installer gira su cloud-node, che
 * non e' mai uno dei siti nominati in PrismFunctionDeployment.spec.sites —
 * per questo controller OGNI sito e' remoto, senza eccezioni. Vedi
 * k8sClients.js.
 *
 * DUE NAMESPACE, come in workflow-master: NAMESPACE ("prism-system") e'
 * dove vivono le TraefikService/IngressRoute; FUNCTION_NAMESPACE
 * ("default") e' dove vive la Knative Service stessa. Corretto (vs una
 * versione precedente di questo file): la Knative Service va creata in
 * FUNCTION_NAMESPACE, NON in NAMESPACE — deve combaciare esattamente con
 * l'Host che workflow-master gia' costruisce
 * (`<function>.${FUNCTION_NAMESPACE}.svc.cluster.local`), quindi stesso
 * valore/stessa env var, nessun disallineamento tra i due controller.
 */

const NAMESPACE = process.env.PRISM_NAMESPACE || "prism-system";
const FUNCTION_NAMESPACE = process.env.PRISM_FUNCTION_NAMESPACE || "default";

const SFCC_KUBECONFIG_PATH = process.env.PRISM_SFCC_KUBECONFIG_PATH || "/etc/prism/sfcc-kubeconfig/kubeconfig";
const REMOTE_WRITER_NAMESPACE = process.env.PRISM_REMOTE_WRITER_NAMESPACE || "prism-remote-writers";

const TRAEFIK_GROUP = "traefik.io";
const TRAEFIK_VERSION = "v1alpha1";

// Group/version del CRD PrismFunctionDeployment.
const PRISM_GROUP = "prism.local";
const PRISM_VERSION = "v1alpha1";

// Group/version di Knative Serving.
const KNATIVE_GROUP = "serving.knative.dev";
const KNATIVE_VERSION = "v1";
const KNATIVE_SERVICES_PLURAL = "services";

const MERGE_PATCH_OPTS = { headers: { "Content-Type": "application/merge-patch+json" } };

module.exports = {
  NAMESPACE,
  FUNCTION_NAMESPACE,
  SFCC_KUBECONFIG_PATH,
  REMOTE_WRITER_NAMESPACE,
  TRAEFIK_GROUP,
  TRAEFIK_VERSION,
  PRISM_GROUP,
  PRISM_VERSION,
  KNATIVE_GROUP,
  KNATIVE_VERSION,
  KNATIVE_SERVICES_PLURAL,
  MERGE_PATCH_OPTS,
};
