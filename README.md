# function-installer

Controller PRISM che osserva le risorse `PrismFunctionDeployment` e, per ogni sito dichiarato in `spec.sites`, installa una Knative Service (`cluster-local`) più le due IngressRoute Traefik di baseline necessarie a raggiungerla. È il fratello di `workflow-master` (stesso testbed, stesso canale di credenziali), ma è un controller separato perché ha un ciclo di vita diverso: installare una funzione è un'operazione rara, mentre aggiustare i pesi di instradamento tra i siti (compito di `workflow-master`) è continuo. Gira su `cloud-node`, mai su un sito edge — e non richiede alcuna `PrismMasterAssignment`: reagisce a ogni `PrismFunctionDeployment` che vede, sempre attivo dal primo avvio.

## Provisioning dell'infrastruttura

Come per `workflow-master`, l'infrastruttura (le VM dei siti, incluso `cloud-node`) è gestita tramite BiVM/`slices-bi-operator` su `sfcc`, con `ccbp-cli` come punto di accesso da riga di comando. Il kubeconfig di un nodo si ottiene con:

```bash
getKubeconfigUtils <project> <experiment> cloud-node
```

Il file scritto da `getKubeconfigUtils` ha `server: https://127.0.0.1:6443`, valido solo se `kubectl` gira sul nodo stesso. Da una macchina esterna va corretto sostituendo l'IP reale del nodo (letto dal suo `BiVM` su `sfcc`) — non esiste uno script dedicato nel repo per questo, per scelta esplicita: un comando singolo è più semplice e immediato da tenere a mente:

```bash
getKubeconfigUtils <project> <experiment> cloud-node && \
  sed -i "s#https://127.0.0.1:6443#https://$(kubectl get bivm cloud-node -n default -o jsonpath='{.status.privateIPv4}'):6443#" \
    ~/ccbp-cli/SlicesFile/kubeconfigs/cloud-node.yaml
```

Il cluster va creato applicando il manifest BiVM che referenzia `cloud.yaml` come cloud-init per `cloud-node` (analogo a come `edge.yaml` viene referenziato per gli `edge-node-*`):

```bash
kubectl apply -f prism_infra.yaml
```

`cloud.yaml` provisiona, in ordine:

- **k3s** come control plane indipendente (`--disable traefik`, `--disable servicelb`, `--write-kubeconfig-mode 644`). `cloud-node` non è trattato come caso speciale di "solo control-plane": il paper PRISM tratta esplicitamente il Cloud come sito di esecuzione a tutti gli effetti ("The Cloud can also execute its workflow internally, and it also expose its triggers"), quindi riceve lo stesso identico stack di serving di un edge-node.
- **Helm**, per installare i chart successivi.
- **Knative Serving + Kourier**, stessa versione degli edge-node, con `config-network` puntato su `kourier.ingress.networking.knative.dev`.
- **kube-prometheus-stack** (namespace `monitoring`).
- **Traefik**, con due `entryPoint` dedicati: `web` (nodePort 30080, traffico client-facing, può essere splittato da `workflow-master`) e `internal` (nodePort 30090, solo mesh interno tra siti, mai splittato).
- **Self-provisioning della credenziale di scrittura remota**: `cloud-node` genera per sé stesso, con l'accesso admin che ha già in questo momento del boot, un `ServiceAccount workflow-master-remote-writer` e **due** coppie `Role`/`RoleBinding` distinte:
  - una in `prism-system` (IngressRoute/TraefikService, Service core, EndpointSlice);
  - una dedicata in `default` (cioè `FUNCTION_NAMESPACE`), per la sola Knative Service.

  I due namespace sono diversi apposta, e servono due `Role`/`RoleBinding` apposta: un `Role` (a differenza di un `ClusterRole`) concede permessi solo nel proprio namespace, quindi una regola per `serving.knative.dev` messa nel `Role` di `prism-system` non avrebbe mai avuto effetto sulla Knative Service, che vive in `default`. Il secondo `RoleBinding` lega comunque lo stesso, unico `ServiceAccount` — un `RoleBinding` può referenziare un `ServiceAccount` di un namespace diverso dal proprio, non serve duplicarlo. Nessun kubeconfig admin lascia mai il nodo; il kubeconfig scoped risultante viene scritto in `/etc/prism/self-remote-writer-kubeconfig.yaml`. È lo stesso identico meccanismo già usato dagli edge-node — necessario perché `cloud-node` è ora un sito installabile a tutti gli effetti (può comparire in `spec.sites`).
- **`function-installer` stesso**: clonato da un'immagine già pubblicata (nessun build al boot, nessun segreto nell'immagine — il kubeconfig verso `sfcc` è montato a runtime da un `Secret`), applica `rbac.yaml`, il CRD `PrismFunctionDeployment` e `deployment.yaml`. A differenza di `workflow-master`, parte già attivo: non aspetta nessuna `PrismMasterAssignment`.

> `--write-kubeconfig-mode 644` rende `/etc/rancher/k3s/k3s.yaml` leggibile da chiunque abbia un account sulla VM (non solo root) — necessario perché `getKubeconfigUtils` lo legge via SSH senza `sudo`. È un kubeconfig admin del cluster locale del nodo reso world-readable: una scelta consapevole, accettabile qui perché le VM sono a uso singolo, ma da tenere presente.

> `--disable servicelb` disattiva il `ServiceLB` integrato di k3s. Il manifest di Kourier crea, oltre a `kourier-internal` (ClusterIP, l'unico che usiamo — Traefik instrada sempre lì), anche un Service `kourier` di tipo `LoadBalancer` che non usiamo mai. Senza disabilitarlo, k3s gli assegna un nodePort **casuale** che può collidere con i nodePort fissi di Traefik (30080/30443/30090), facendo fallire l'installazione del chart in modo intermittente e difficile da riprodurre (visto in pratica su un sito su dieci, in un giro di provisioning su dieci nodi).

Verifica dopo il boot:

```bash
kubectl --kubeconfig=<cloud-node.yaml> get pods -A
kubectl --kubeconfig=<cloud-node.yaml> get deployment function-installer -n prism-system
kubectl --kubeconfig=<cloud-node.yaml> logs deploy/function-installer -n prism-system
```

## Bootstrap dell'accesso

`function-installer` ha bisogno degli stessi due accessi in lettura verso `sfcc` già usati da `workflow-master`, e li ottiene con lo **stesso identico script**, esteso a coprire anche `cloud-node`:

1. Un `Secret remote-writer-<sito>` per namespace, per ogni sito in `spec.sites` di una `PrismFunctionDeployment` — depositato da un `FileGetter` che preleva `/etc/prism/self-remote-writer-kubeconfig.yaml` dal nodo.
2. Un kubeconfig di sola lettura sui `bivm` (`workflow-master-bivm-reader`), distribuito come `Secret sfcc-kubeconfig-bivm-reader` — serve a risolvere gli stessi identici puntatori che gestisce `workflow-master`.

`cloud-node` non è un caso speciale qui: lo script individua tutti i siti (prefisso `edge-node-` più `cloud-node`, se presente) via BiVM e ripete gli stessi passi per ciascuno.

```bash
./bootstrap-cluster-access.sh ubuntu ~/.ssh/<chiave>
```

Il token generato permette a `function-installer` di leggere i `bivm` (per risolvere gli IP dei siti quando serve) e i `Secret remote-writer-*`, mai altro. Va rilanciato ogni volta che viene aggiunto un nuovo sito (edge o `cloud-node`) al testbed.

Verifica:

```bash
kubectl -n prism-remote-writers get secrets
kubectl --kubeconfig=<cloud-node.yaml> get secret sfcc-kubeconfig-bivm-reader -n prism-system
```

## CRD di PRISM

```yaml
apiVersion: prism.local/v1alpha1
kind: PrismFunctionDeployment
metadata:
  name: workflow-0
  namespace: prism-system
spec:
  function: workflow-0
  image: ghcr.io/knative/autoscale-go:latest
  sites:
    - cloud-node
    - edge-node-1
    - edge-node-2
```

- `spec.function` / `spec.image`: nome della funzione (= nome della Knative Service creata su ogni sito) e immagine container.
- `spec.sites`: pool di siti su cui la funzione deve essere installata. Oggi è dichiarato **a mano**. Nella visione completa del paper PRISM questa è invece una decisione **dinamica**, presa dal Cloud Controller/job DRL (non ancora implementato in questo progetto):

  > "the PRISM overlay spans a set of edge nodes organized into logical partitions... workflow partition, dynamically organized by the PRISM controller"

  > "developers define functions and associated SLAs, and upload them on the PRISM endpoint that will masquerade the complexity and dynamicity of distributing these functions across cloud continuum resources"

  `spec.sites` è quindi un proxy temporaneo di quella decisione: in futuro sarà il Cloud Controller/DRL (o un suo equivalente) a scriverlo, senza che `function-installer` debba cambiare — il controller reagisce alla CR indipendentemente da chi la scrive. `PrismRoutingPolicy.spec.destinations` (in `workflow-master`) dovrebbe sempre essere un sottoinsieme di `spec.sites` — vincolo concettuale, non verificato dal controller.
- `status.sites[]`: stato di installazione per sito (`installed`/`error` + messaggio) — campo già previsto nel CRD, non ancora scritto dal controller (Step 5, vedi sotto).

## Funzionamento del controller

`function-installer` osserva (`ListWatch`) le `PrismFunctionDeployment` nel proprio namespace. Ad ogni evento `add`/`update`, per ciascun sito in `spec.sites`:

1. Risolve i client scoped per quel sito (`getClientsForSite`) leggendo il `Secret remote-writer-<sito>` da `sfcc` — stesso canale di credenziali di `workflow-master`, nessuna duplicazione. **Nessun ramo "locale"**: a differenza di `workflow-master`, `cloud-node` non è mai uno dei siti nominati in `spec.sites` per questo controller, quindi ogni sito è sempre remoto, senza eccezioni.
2. Crea/aggiorna (create-or-patch, idempotente) la Knative Service `<function>` nel namespace `FUNCTION_NAMESPACE` (default `default` — stesso valore usato da `workflow-master`, per costruire lo stesso `Host` `<function>.<namespace>.svc.cluster.local`), con label `networking.knative.dev/visibility: cluster-local`: la funzione non è mai raggiungibile dall'esterno del cluster del sito.
3. Crea/aggiorna le due IngressRoute di baseline, portate dentro il controller dalla logica originariamente in `tools/install-function-baseline.sh` (ancora utilizzabile a mano per un intervento una tantum, ma non più l'unico posto dove questa logica vive):
   - **`<function>-local`** (entryPoint `web`): baseline "servi localmente". Se il sito diventa attivo per un workflow su questa funzione, `workflow-master` la **sovrascrive** (stesso nome) con la versione pesata — nessun conflitto, è voluto.
   - **`<function>-internal`** (entryPoint `internal`, `passHostHeader: true`): sempre "servi localmente", **mai** toccata da `workflow-master` — è il target dei puntatori mesh, rompe la ricorsione dello split.

   Entrambe puntano sempre al 100% a `kourier-internal`, stesso comportamento esatto dello script originale.

Nessun master-gating qui (a differenza di `workflow-master`, che agisce solo se il proprio sito è quello assegnato dalla `PrismMasterAssignment` attiva): `function-installer` riconcilia ogni `PrismFunctionDeployment` che vede, sempre, indipendentemente da chi è master in quel momento.

L'installazione per-sito è **best-effort**: un fallimento su un sito (es. `Secret remote-writer-<sito>` non ancora pronto) viene loggato ma non blocca gli altri siti in `spec.sites` — stesso pattern usato da `workflow-master` per `PrismRoutingPolicy`.

Non ancora implementato (deliberatamente fuori scope di questo step):

- **Cleanup sui siti rimossi** da `spec.sites` (confrontando con l'ultimo `status.sites[]` noto) — l'helper `deleteCustomObject` esiste già in `customObjects.js`, pronto per essere richiamato.
- **Scrittura di `status.sites[]`** sulla CR con l'esito per sito.

## Validazione sul testbed reale

Il flusso completo (provisioning → bootstrap accessi → `PrismFunctionDeployment` → Knative Service + IngressRoute → risposta HTTP reale) è stato validato end-to-end sul testbed a 10 nodi (`cloud-node` + `edge-node-1..9`). Durante il primo giro di test sono emersi alcuni problemi reali, tutti di infrastruttura/configurazione (nessuno nella logica del controller):

- **`nodePort` in collisione**: il `ServiceLB` di k3s assegna un nodePort casuale al Service `kourier` (tipo `LoadBalancer`, mai usato in questo design), che può scontrarsi con i nodePort fissi di Traefik — vedi `--disable servicelb` sopra.
- **RBAC scoped al namespace sbagliato**: la regola `serving.knative.dev` va in un `Role`/`RoleBinding` dedicato nel namespace `default` (`FUNCTION_NAMESPACE`), non in quello di `prism-system` — vedi sopra. Il sintomo era fuorviante: il client `@kubernetes/client-node` appiattisce sia gli errori di rete sia le risposte HTTP non-2xx (es. un 403) nello stesso generico `"HTTP request failed"`, senza dettagli in `err.message`. Il dettaglio vero va cercato in `err.statusCode`/`err.response.statusCode`/`err.body`.
- **Tag immagine sample obsoleto**: `gcr.io/knative-samples/autoscale-go:0.1` non esiste più (404) — Knative ha spostato le immagini di esempio su `ghcr.io/knative/...`.

## Struttura dei moduli

| File | Responsabilità |
|---|---|
| `src/config.js` | Variabili d'ambiente e costanti condivise (namespace, group/version di Knative/Traefik/PRISM, path del kubeconfig verso `sfcc`). |
| `src/k8sClients.js` | Client `@kubernetes/client-node`: in-cluster (solo per osservare le `PrismFunctionDeployment`), verso `sfcc` (sola lettura, lazy), e scoped verso i siti remoti (`getClientsForSite`, senza ramo "locale"). |
| `src/customObjects.js` | Helper generici create-or-patch (`applyCustomObject`) e delete idempotente (`deleteCustomObject`) per qualunque CustomResource. |
| `src/knativeService.js` | Costruisce e applica la Knative Service `cluster-local` per una funzione su un sito. |
| `src/ingressBaseline.js` | Costruisce e applica le due IngressRoute di baseline (`-local`, `-internal`) per una funzione su un sito. |
| `src/functionDeployment.js` | Riconciliazione di una `PrismFunctionDeployment`: per ogni sito in `spec.sites`, Knative Service + IngressRoute di baseline, best-effort. |
| `src/index.js` | Entry point: avvia il `ListWatch` sulle `PrismFunctionDeployment` e collega gli eventi alla riconciliazione. |