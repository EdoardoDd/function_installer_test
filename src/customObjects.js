"use strict";

/**
 * customObjects.js — helper generici per lavorare con le CustomResource di
 * Kubernetes, indipendenti dal tipo specifico di risorsa (Knative Service,
 * TraefikService, IngressRoute...). Identico a customObjects.js di
 * workflow-master: stessa semantica create-or-patch, nessuna duplicazione
 * di logica.
 *
 * ATTENZIONE: le firme dei metodi di @kubernetes/client-node cambiano tra
 * major version (parametri posizionali vs oggetto opzioni). Se una
 * chiamata *Api fallisce con un errore relativo agli argomenti, verificare
 * la versione installata (`npm ls @kubernetes/client-node`) e adattare la
 * forma della chiamata di conseguenza — non e' un problema di logica.
 */

const { MERGE_PATCH_OPTS } = require("./config");

function isConflict(err) {
  return err?.response?.statusCode === 409 || err?.statusCode === 409 || err?.code === 409;
}

function isNotFound(err) {
  return err?.response?.statusCode === 404 || err?.statusCode === 404;
}

/** Crea l'oggetto custom, o lo aggiorna (merge patch) se esiste gia'. Idempotente. */
async function applyCustomObject(apiClient, group, version, plural, body) {
  const metadata = body.metadata;
  try {
    await apiClient.createNamespacedCustomObject(group, version, metadata.namespace, plural, body);
    console.log(`Creato ${plural}/${metadata.name} (${metadata.namespace})`);
  } catch (err) {
    if (!isConflict(err)) throw err;
    await apiClient.patchNamespacedCustomObject(
      group,
      version,
      metadata.namespace,
      plural,
      metadata.name,
      body,
      undefined,
      undefined,
      undefined,
      MERGE_PATCH_OPTS
    );
    console.log(`Aggiornato ${plural}/${metadata.name} (${metadata.namespace})`);
  }
}

/**
 * Elimina l'oggetto custom se esiste. Un 404 e' considerato successo
 * (idempotente anche in cancellazione) — usato per il cleanup quando un
 * sito viene tolto da spec.sites.
 */
async function deleteCustomObject(apiClient, group, version, namespace, plural, name) {
  try {
    await apiClient.deleteNamespacedCustomObject(group, version, namespace, plural, name);
    console.log(`Eliminato ${plural}/${name} (${namespace})`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

module.exports = { isConflict, isNotFound, applyCustomObject, deleteCustomObject };
