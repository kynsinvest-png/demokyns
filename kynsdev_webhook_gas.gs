// ══════════════════════════════════════════════════════════════════
// KYNSDEV — GAS Webhook Paiement & Activation Automatique
// ══════════════════════════════════════════════════════════════════
// INSTALLATION :
// 1. Créez un Google Sheets dédié "KynsDev CRM Paiements"
// 2. Extensions → Apps Script → coller ce code
// 3. Remplir les CONFIG ci-dessous
// 4. Déployer → Application Web → Tout le monde
// 5. Copier l'URL → mettre dans kynsdev_paiement.html (GAS_CRM_URL)
//    ET dans GeniusPay Dashboard → Webhooks → URL
// ══════════════════════════════════════════════════════════════════

// ── CONFIGURATION ────────────────────────────────────────────────
const CFG = {
  // Clé secrète GeniusPay (sk_live_...) — ne jamais exposer côté client
  GENIUSPAY_SECRET: 'pk_sandbox_O6i405PbFTgXkhpDRdxMadS4iM1Kv2a0',
  GENIUSPAY_KEY:    'sk_sandbox_9a2715708c9850269807d02c49dc842dc8b5dda3e8bde06681e81a90a741769c',

  // Clé maître pour générer les licences (doit être identique au CRM)
  MKEY: 'MUTUELLECI_VENDOR_2026',

  // Clé API SMS (depuis votre fournisseur SMS)
  SMS_API_KEY:    'SMS-MUTUELLE20260525094200.669456lTgfcUBvweK2MZHOJoOp',
  SMS_API_URL:    'https://hsms-proxy.stevekonan28.workers.dev/', // ou votre provider
  SMS_EXPEDITEUR: 'KynsDev',

  // Votre numéro pour recevoir une copie des notifications
  ADMIN_TEL: '+2250713435873',

  // Feuilles du Sheets
  SHEET_LICENCES:    'LICENCES',
  SHEET_PAIEMENTS:   'PAIEMENTS_AUTO',
  SHEET_BRANDING:    'CONFIG',
};

// ── POINT D'ENTRÉE GET (vérification & activation depuis page confirmation) ──
function doGet(e) {
  const action   = e.parameter.action || '';
  const callback = e.parameter.cb     || '';
  let result     = {};

  try {
    if (action === 'ping') {
      result = {ok: true, ts: new Date().toISOString()};

    } else if (action === 'activerLicence') {
      result = activerLicenceDepuisGet(e.parameter);

    } else {
      result = {error: 'Action inconnue: ' + action};
    }
  } catch(err) {
    result = {error: err.message};
    Logger.log('doGet ERROR: ' + err.message);
  }

  const json = JSON.stringify(result);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── POINT D'ENTRÉE POST (webhook GeniusPay) ──
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    Logger.log('[Webhook] Reçu: ' + JSON.stringify(body).substring(0, 300));

    // GeniusPay webhook — vérifier l'événement
    if (body.event === 'payment.success' || body.event === 'payment.completed') {
      const data = body.data || body;
      traiterPaiementReussi(data);
    }

    return ContentService.createTextOutput(JSON.stringify({received: true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    Logger.log('[Webhook] ERREUR: ' + err.message);
    return ContentService.createTextOutput(JSON.stringify({error: err.message}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── TRAITEMENT PAIEMENT RÉUSSI (depuis webhook GeniusPay) ──────────
function traiterPaiementReussi(data) {
  const reference = data.reference || data.id || '';
  const montant   = Number(data.amount || data.net_amount || 0);
  const metadata  = data.metadata || {};

  const nom        = String(metadata.nom_mutuelle || data.customer?.name || '').toUpperCase().trim();
  const tel        = String(metadata.tel || data.customer?.phone || '');
  const contact    = String(metadata.contact || '');
  const offre      = String(metadata.offre_nom || metadata.offre || '');
  const nbMois     = Number(metadata.nb_mois || 1);
  const expiration = String(metadata.expiration || calculerExpiration(nbMois));

  if (!nom || !tel) {
    Logger.log('[traiterPaiement] Données manquantes — nom: ' + nom + ' tel: ' + tel);
    return;
  }

  // Vérifier si déjà traité (idempotence)
  if (dejaTraite(reference)) {
    Logger.log('[traiterPaiement] Paiement déjà traité: ' + reference);
    return;
  }

  // Générer la clé de licence
  const cle = genererCle(nom, expiration);
  Logger.log('[traiterPaiement] Clé générée: ' + cle + ' pour ' + nom);

  // Enregistrer dans Sheets
  enregistrerLicence({reference, nom, tel, contact, offre, nbMois, expiration, montant, cle});

  // Envoyer SMS au client
  const smsSent = envoyerSmsLicence({tel, nom, offre, nbMois, expiration, cle});

  // Envoyer notification SMS à l'admin KynsDev
  envoyerSmsAdmin({nom, offre, nbMois, montant, reference, smsSent});

  Logger.log('[traiterPaiement] ✅ Traitement terminé pour ' + nom);
}

// ── ACTIVATION DEPUIS PAGE CONFIRMATION (doGet) ────────────────────
function activerLicenceDepuisGet(params) {
  const reference  = params.reference || '';
  const nom        = String(params.nom || '').toUpperCase().trim();
  const tel        = String(params.tel || '');
  const offre      = String(params.offre || '');
  const mois       = Number(params.mois || 1);
  const expiration = String(params.expiration || calculerExpiration(mois));
  const total      = Number(params.total || 0);

  if (!nom && !reference) return {error: 'Données manquantes'};

  // Vérifier si la licence existe déjà (générée par webhook)
  const existante = trouverLicence(reference, nom);
  if (existante) {
    return {ok: true, cle: existante.cle, message: 'Licence déjà activée'};
  }

  // Si le webhook n'a pas encore été reçu → vérifier le paiement via API GeniusPay
  if (reference) {
    const paiementOk = verifierPaiementGeniusPay(reference);
    if (!paiementOk) return {ok: false, message: 'Paiement non confirmé'};
  }

  // Générer et enregistrer
  const cle = genererCle(nom, expiration);
  enregistrerLicence({reference, nom, tel, offre, nbMois:mois, expiration, montant:total, cle});
  envoyerSmsLicence({tel, nom, offre, nbMois:mois, expiration, cle});
  envoyerSmsAdmin({nom, offre, nbMois:mois, montant:total, reference});

  return {ok: true, cle, expiration, message: 'Licence activée avec succès'};
}

// ── GÉNÉRATION CLÉ DE LICENCE ──────────────────────────────────────
function genererCle(nom, expiration) {
  // Même algorithme que le CRM HTML (sha256)
  const input  = nom + '|' + expiration + '|' + CFG.MKEY;
  const bytes  = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
                   input, Utilities.Charset.UTF_8);
  const hex    = bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  return hex.substring(0, 32).toUpperCase();
}

// ── VÉRIFICATION PAIEMENT VIA API GENIUSPAY ────────────────────────
function verifierPaiementGeniusPay(reference) {
  try {
    const url  = 'https://pay.genius.ci/api/v1/merchant/payments/' + reference;
    const resp = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: {
        'X-API-Key':    CFG.GENIUSPAY_KEY,
        'X-API-Secret': CFG.GENIUSPAY_SECRET,
      },
      muteHttpExceptions: true
    });
    const data = JSON.parse(resp.getContentText());
    const statut = data?.data?.status || '';
    Logger.log('[verifierPaiement] ' + reference + ' → ' + statut);
    return statut === 'success' || statut === 'completed' || statut === 'paid';
  } catch(e) {
    Logger.log('[verifierPaiement] Erreur: ' + e.message);
    return false;
  }
}

// ── ENVOI SMS LICENCE AU CLIENT ────────────────────────────────────
function envoyerSmsLicence(d) {
  const msg = [
    'KynsDev - Licence activee !',
    'Mutuelle : ' + d.nom,
    'Offre : ' + d.offre + ' (' + d.nbMois + ' mois)',
    'Cle : ' + d.cle,
    'Expire : ' + new Date(d.expiration).toLocaleDateString('fr-FR'),
    'Support : wa.me/2250713435873'
  ].join('\n');

  return envoyerSms(d.tel, msg);
}

// ── ENVOI SMS NOTIFICATION ADMIN ───────────────────────────────────
function envoyerSmsAdmin(d) {
  const msg = [
    'KynsDev PAIEMENT RECU',
    'Mutuelle : ' + d.nom,
    'Offre : ' + d.offre + ' ' + d.nbMois + 'mois',
    'Montant : ' + Number(d.montant||0).toLocaleString('fr-FR') + ' FCFA',
    'Ref : ' + (d.reference||'—'),
    d.smsSent ? 'SMS client envoye' : 'SMS client ECHEC'
  ].join(' | ');

  return envoyerSms(CFG.ADMIN_TEL, msg);
}

// ── ENVOI SMS GÉNÉRIQUE ────────────────────────────────────────────
function envoyerSms(tel, message) {
  try {
    const telClean = tel.replace(/\D/g, '');
    const telFmt   = telClean.startsWith('225') ? telClean : '225' + telClean.replace(/^0/, '');

    const payload = {
      apiKey:    CFG.SMS_API_KEY,
      to:        telFmt,
      from:      CFG.SMS_EXPEDITEUR,
      message:   message,
    };

    const resp = UrlFetchApp.fetch(CFG.SMS_API_URL, {
      method:  'POST',
      payload: JSON.stringify(payload),
      contentType: 'application/json',
      muteHttpExceptions: true,
    });

    const result = resp.getResponseCode();
    Logger.log('[SMS] Envoyé à ' + telFmt + ' → HTTP ' + result);
    return result === 200 || result === 201;
  } catch(e) {
    Logger.log('[SMS] Erreur: ' + e.message);
    return false;
  }
}

// ── ENREGISTREMENT LICENCE DANS SHEETS ────────────────────────────
function enregistrerLicence(d) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh   = ss.getSheetByName(CFG.SHEET_LICENCES);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET_LICENCES);
    sh.appendRow(['id','date','reference','nom','tel','offre','nb_mois','expiration','montant','cle','statut']);
  }
  const id = 'LIC_' + new Date().getTime();
  sh.appendRow([
    id,
    new Date().toISOString().split('T')[0],
    d.reference || '',
    d.nom,
    d.tel,
    d.offre,
    d.nbMois,
    d.expiration,
    d.montant,
    d.cle,
    'active'
  ]);
  SpreadsheetApp.flush();
  Logger.log('[enregistrerLicence] ✅ ' + d.nom + ' → ' + d.cle);
}

// ── VÉRIFIER SI DÉJÀ TRAITÉ ────────────────────────────────────────
function dejaTraite(reference) {
  if (!reference) return false;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CFG.SHEET_LICENCES);
  if (!sh) return false;
  const vals = sh.getDataRange().getValues();
  const refCol = vals[0].indexOf('reference');
  if (refCol < 0) return false;
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][refCol]) === String(reference)) return true;
  }
  return false;
}

// ── TROUVER UNE LICENCE EXISTANTE ─────────────────────────────────
function trouverLicence(reference, nom) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CFG.SHEET_LICENCES);
  if (!sh) return null;
  const vals   = sh.getDataRange().getValues();
  const hdrs   = vals[0];
  const refCol = hdrs.indexOf('reference');
  const nomCol = hdrs.indexOf('nom');
  const cleCol = hdrs.indexOf('cle');
  for (let i = 1; i < vals.length; i++) {
    const rowRef = String(vals[i][refCol] || '');
    const rowNom = String(vals[i][nomCol] || '');
    if ((reference && rowRef === reference) || (nom && rowNom === nom.toUpperCase())) {
      return {cle: vals[i][cleCol], nom: rowNom};
    }
  }
  return null;
}

// ── UTILITAIRES ────────────────────────────────────────────────────
function calculerExpiration(nbMois) {
  const d = new Date();
  d.setMonth(d.getMonth() + Number(nbMois));
  return d.toISOString().split('T')[0];
}
