#!/usr/bin/env bash
# Ripatcha il Role "workflow-master-remote-writer" (aggiunge la regola
# serving.knative.dev mancante) su tutti i siti, usando i kubeconfig
# admin GIA' presenti sul disco (niente getKubeconfigUtils: prende
# direttamente i file da KUBECONFIG_DIR).
#
# Uso:
#   ./patch-rbac-all-sites.sh
#
# Prerequisiti:
#  - in KUBECONFIG_DIR deve esistere un file <node-name>.yaml per ciascun
#    sito (stesso pattern usato finora da getKubeconfigUtils)
#  - questi kubeconfig devono gia' avere il "server:" corretto (IP reale
#    del nodo, non 127.0.0.1) - lo script lo corregge comunque da solo,
#    risolvendo l'IP dal BiVM, quindi va bene anche se sono ancora "grezzi"
set -euo pipefail

KUBECONFIG_DIR="${KUBECONFIG_DIR:-/home/edoardo/ccbp-cli/SlicesFile/kubeconfigs}"
BIVM_NAMESPACE="${BIVM_NAMESPACE:-default}"

SITES=(cloud-node edge-node-1 edge-node-2 edge-node-3 edge-node-4 edge-node-5 edge-node-6 edge-node-7 edge-node-8 edge-node-9)

for node in "${SITES[@]}"; do
  echo "== ${node} ==" >&2

  KUBECONFIG_FILE="${KUBECONFIG_DIR}/${node}.yaml"
  if [[ ! -f "$KUBECONFIG_FILE" ]]; then
    echo "   ATTENZIONE: '${KUBECONFIG_FILE}' non trovato, salto ${node}." >&2
    continue
  fi

  # corregge il "server: https://127.0.0.1:6443" con l'IP reale del nodo,
  # risolto dal suo BiVM su sfcc - non fa nulla se e' gia' stato corretto
  NODE_IP=$(kubectl get bivm "$node" -n "$BIVM_NAMESPACE" -o jsonpath='{.status.privateIPv4}')
  if [[ -z "$NODE_IP" ]]; then
    echo "   ATTENZIONE: BiVM '${node}' senza status.privateIPv4, salto." >&2
    continue
  fi
  sed -i "s#https://127\\.0\\.0\\.1:6443#https://${NODE_IP}:6443#" "$KUBECONFIG_FILE"

  # Role/RoleBinding "storico" in prism-system (traefik/services/endpointslices) -
  # invariato, qui solo per idempotenza/coerenza col resto del setup.
  kubectl --kubeconfig="$KUBECONFIG_FILE" -n prism-system apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-master-remote-writer
  namespace: prism-system
rules:
  - apiGroups: ["traefik.io"]
    resources: ["ingressroutes", "traefikservices"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
EOF

  # Role/RoleBinding DEDICATO in "default" (FUNCTION_NAMESPACE) per le
  # Knative Service - un Role e' scoped al proprio namespace, quindi la
  # regola serving.knative.dev messa nel Role di prism-system non ha mai
  # avuto effetto su "default". RoleBinding puo' legare un ServiceAccount
  # di un altro namespace, quindi restiamo con un unico ServiceAccount.
  kubectl --kubeconfig="$KUBECONFIG_FILE" -n default apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-master-remote-writer-knative
  namespace: default
rules:
  - apiGroups: ["serving.knative.dev"]
    resources: ["services"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: workflow-master-remote-writer-knative
  namespace: default
subjects:
  - kind: ServiceAccount
    name: workflow-master-remote-writer
    namespace: prism-system
roleRef:
  kind: Role
  name: workflow-master-remote-writer-knative
  apiGroup: rbac.authorization.k8s.io
EOF
done

echo "Fatto." >&2
