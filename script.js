// ============================================================
// SCRIPT PRINCIPAL - Outil de suivi sportif
// Étape 1 : Import d'un fichier .tcx, extraction des stats,
// affichage et sauvegarde locale (IndexedDB)
// ============================================================

// --- 1. On récupère les éléments HTML dont on aura besoin ---
const inputFichier = document.getElementById('fichier-tcx');
const sectionResultat = document.getElementById('resultat');
const listeActivitesUl = document.getElementById('liste-activites-ul');
let activitesEnMemoire = []; // toutes les activités actuellement connues (tenues à jour par l'écouteur Firestore, voir plus bas)
let activiteEnCoursAffichage = null;
let derniereActiviteImporteeId = null; // id de l'activité qu'on vient d'importer (pour savoir où enregistrer le RPE saisi juste après)

// ============================================================
// AUTHENTIFICATION (Firebase Auth)
// L'app entière (#app-principal) est cachée tant que personne n'est
// connecté : toutes les données vivent maintenant dans Firestore, propres à
// un compte (voir firebase-config.js pour la mise en place). Pas d'écran
// d'inscription volontairement — un seul compte, créé une fois depuis la
// console Firebase — la sécurité réelle vient des règles Firestore, pas de
// l'absence d'un formulaire d'inscription dans l'app.
// ============================================================

const auth = firebase.auth();
const db = firebase.firestore();
let uidActuel = null; // UID Firebase de la personne connectée (null tant que non connecté)

// Persistance hors-ligne : Firestore garde une copie locale des données
// (dans IndexedDB, en coulisses — on n'a plus besoin de gérer ça nous-mêmes)
// et met les écritures en attente si le réseau est coupé, pour les envoyer
// dès qu'il revient. Ça ne bloque rien si le navigateur ne supporte pas
// cette fonctionnalité ou si plusieurs onglets sont ouverts en même temps
// (cas déjà géré par Firestore : juste désactivée dans ce cas, pas d'erreur
// bloquante), d'où le .catch() silencieux (juste un avertissement en console).
db.enablePersistence().catch(erreur => {
  console.warn('Persistance hors-ligne non activée :', erreur.code);
});

// Fonctions "annulation" des écouteurs Firestore (activités/réglages/VO2max/
// records/segments) : utiles pour tout arrêter proprement à la déconnexion,
// avant qu'un nouveau compte (ou une reconnexion) ne redémarre des
// écouteurs par-dessus.
let arreterEcouteActivites = null;
let arreterEcouteReglages = null;
let arreterEcouteVO2max = null;
let arreterEcouteRecords = null;
let arreterEcouteSegments = null;

auth.onAuthStateChanged(function (user) {
  if (user) {
    uidActuel = user.uid;
    document.getElementById('ecran-connexion').style.display = 'none';
    document.getElementById('app-principal').style.display = 'block';
    document.getElementById('compte-email').textContent = user.email || uidActuel;

    arreterEcouteActivites = demarrerEcouteActivites(uidActuel);
    arreterEcouteReglages = demarrerEcouteReglages(uidActuel);
    arreterEcouteVO2max = demarrerEcouteVO2max(uidActuel);
    arreterEcouteRecords = demarrerEcouteRecords(uidActuel);
    arreterEcouteSegments = demarrerEcouteSegments(uidActuel);
  } else {
    // Déconnecté (ou pas encore connecté) : on coupe les écouteurs en cours
    // s'il y en avait, on vide l'état local, et on affiche l'écran de connexion.
    if (arreterEcouteActivites) arreterEcouteActivites();
    if (arreterEcouteReglages) arreterEcouteReglages();
    if (arreterEcouteVO2max) arreterEcouteVO2max();
    if (arreterEcouteRecords) arreterEcouteRecords();
    if (arreterEcouteSegments) arreterEcouteSegments();
    uidActuel = null;
    activitesEnMemoire = [];
    recordsManuelsEnMemoire = [];
    segmentsEnMemoire = [];

    document.getElementById('app-principal').style.display = 'none';
    document.getElementById('ecran-connexion').style.display = 'block';
  }
});

document.getElementById('btn-connexion').addEventListener('click', function () {
  const email = document.getElementById('connexion-email').value.trim();
  const motDePasse = document.getElementById('connexion-mdp').value;
  const zoneErreur = document.getElementById('connexion-erreur');
  zoneErreur.style.display = 'none';

  if (!email || !motDePasse) return;

  auth.signInWithEmailAndPassword(email, motDePasse).catch(function (erreur) {
    // Message volontairement générique (ne pas confirmer/infirmer si l'email
    // existe, bonne pratique de sécurité de base) plutôt que de renvoyer le
    // message brut de Firebase.
    zoneErreur.textContent = '❌ Connexion impossible : vérifie ton email et ton mot de passe.';
    zoneErreur.style.display = 'block';
    console.error('Erreur de connexion :', erreur.code, erreur.message);
  });
});

// Pour pouvoir se connecter avec la touche Entrée, pas seulement en cliquant
document.getElementById('connexion-mdp').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('btn-connexion').click();
});

document.getElementById('btn-deconnexion').addEventListener('click', function () {
  auth.signOut();
});

// ============================================================
// NAVIGATION PAR ONGLETS (Accueil / Activité / Paramètres)
// Pas de vrai routeur : les 3 pages sont 3 <section class="page">
// déjà présentes dans le HTML, on affiche l'une et on cache les
// deux autres avec `style.display`.
// ============================================================

function afficherPage(nomPage) {
  document.querySelectorAll('.page').forEach(page => {
    page.style.display = (page.id === 'page-' + nomPage) ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-onglet').forEach(bouton => {
    bouton.classList.toggle('actif', bouton.dataset.page === nomPage);
  });

  // Les graphiques Chart.js de la page Accueil ont besoin que leur <canvas>
  // soit VISIBLE au moment où ils sont créés pour se dimensionner
  // correctement. On les (re)dessine donc à chaque fois que l'onglet
  // Accueil redevient actif, plutôt que de compter sur un seul affichage au
  // chargement de la page.
  if (nomPage === 'accueil') {
    afficherApercu();
    afficherRecapSemaines();
    afficherGraphiqueACWR();
  }

  // Les efforts sur segments sont plus coûteux à calculer que le reste de
  // cette page (comparaison point par point avec le tracé de référence de
  // chaque segment, voir la section SEGMENTS plus bas) : on ne les
  // recalcule PAS à chaque changement d'activité comme le reste (voir
  // rafraichirAffichageActivites), seulement en arrivant sur cet onglet.
  if (nomPage === 'records') {
    afficherSegments();
  }
}

document.querySelectorAll('.nav-onglet').forEach(bouton => {
  bouton.addEventListener('click', () => afficherPage(bouton.dataset.page));
});

// --- 2. On écoute l'événement "changement" sur l'input file ---
// Ça se déclenche dès que l'utilisateur choisit un ou plusieurs fichiers
// (l'input a l'attribut "multiple", donc event.target.files peut contenir
// plusieurs entrées).
inputFichier.addEventListener('change', function (event) {
  const fichiers = Array.from(event.target.files || []);
  if (fichiers.length === 0) return;

  importerFichiersEnSequence(fichiers, 0);

  // Sans ça, choisir à nouveau EXACTEMENT le(s) même(s) fichier(s) une autre
  // fois ne redéclencherait pas l'événement "change" (le navigateur ne voit
  // pas de changement de sélection) : on vide la sélection après lecture.
  event.target.value = '';
});

// Traite les fichiers UN PAR UN, dans l'ordre, plutôt qu'en parallèle : les
// FileReader sont asynchrones, donc les lire tous en même temps ne garantit
// pas l'ordre de traitement (le dernier fichier importé ne serait pas
// forcément celui qui reste affiché dans "Dernière activité importée").
// En chaînant via onload -> appel récursif, chaque fichier est complètement
// traité (parsé, affiché, sauvegardé) avant de passer au suivant.
function importerFichiersEnSequence(fichiers, index, promessesSauvegarde) {
  promessesSauvegarde = promessesSauvegarde || []; // accumulée au fil de la récursion

  if (index >= fichiers.length) {
    // Tous les fichiers ont été LUS (parsing + affichage), mais leurs
    // écritures Firestore peuvent encore être en cours : on attend qu'elles
    // se terminent (Promise.allSettled, pour ne pas s'arrêter au premier
    // échec) avant d'afficher un message, pour que ce message reflète ce
    // qui a VRAIMENT été enregistré plutôt qu'un succès supposé.
    Promise.allSettled(promessesSauvegarde).then(resultats => {
      const echecs = resultats.filter(r => r.status === 'rejected');
      const message = document.getElementById('import-message');

      if (echecs.length > 0) {
        console.error('Échecs de sauvegarde lors de l\'import :', echecs.map(r => r.reason));
        const premiereErreur = echecs[0].reason;
        const codeErreur = (premiereErreur && (premiereErreur.code || premiereErreur.message)) || 'erreur inconnue';
        message.textContent = `⚠️ ${echecs.length} activité(s) sur ${fichiers.length} n'ont PAS pu être enregistrée(s) (${codeErreur}). Vérifie ta connexion et les règles de sécurité Firestore (voir firebase-config.js), puis réimporte les fichiers concernés.`;
        message.style.display = 'block';
      } else if (fichiers.length > 1) {
        // Petit message récap, uniquement utile s'il y en avait plus d'un
        // (pour un import simple, le bloc "Dernière activité importée" qui
        // apparaît suffit comme confirmation).
        message.textContent = `✅ ${fichiers.length} activités importées.`;
        message.style.display = 'block';
        setTimeout(() => { message.style.display = 'none'; }, 4000);
      }
    });
    return;
  }

  const lecteur = new FileReader();
  lecteur.onload = function (e) {
    const contenuTexte = e.target.result; // le XML brut en texte
    const activite = parserTCX(contenuTexte); // notre fonction de parsing (voir plus bas)
    afficherActivite(activite); // affichage à l'écran (le dernier fichier traité reste affiché)
    promessesSauvegarde.push(sauvegarderActivite(activite)); // sauvegarde dans Firestore (asynchrone, voir ci-dessus)
    importerFichiersEnSequence(fichiers, index + 1, promessesSauvegarde); // on enchaîne sur le fichier suivant
  };
  lecteur.readAsText(fichiers[index]);
}


// ============================================================
// FONCTION : lisserAltitudes
// Rôle : calculer une version "lissée" (moyenne mobile) de l'altitude de
// chaque point, UNIQUEMENT pour servir au calcul du D+ (voir plus bas).
//
// Pourquoi lisser ? Sur les activités longues (plusieurs heures), l'altimètre
// de la montre (baromètre + GPS) dérive avec le temps indépendamment du
// relief réel : variations de pression atmosphérique au fil de la journée,
// imprécision GPS sous couvert forestier, etc. Ce bruit, même petit d'un
// point à l'autre, finit par gonfler artificiellement le D+, car celui-ci ne
// compte QUE les montées : une oscillation qui monte puis redescend ajoute
// du D+ à l'aller sans jamais en retirer au retour. Plus on a de points (ex.
// un enregistrement toutes les secondes) et plus l'activité est longue, plus
// cet effet s'accumule. (Vérifié sur une vraie sortie de 8h46 : les phases
// où le coureur était immobile à l'arrivée d'un tour montraient à elles
// seules ~215m de D+ "fantôme".)
//
// La moyenne mobile utilise une fenêtre basée sur le TEMPS (pas un nombre de
// points), pour donner un résultat cohérent quel que soit l'intervalle
// d'enregistrement de la montre (1 point/seconde ou 1 point/5 secondes...).
//
// Important : cette fonction ne modifie PAS points[i].altitude (l'altitude
// brute reste utilisée telle quelle pour le graphique d'altitude et le
// calcul des pentes par segment) — elle renvoie un tableau à part, utilisé
// seulement par le calcul du D+.
function lisserAltitudes(points, demiFenetreSecondes) {
  // On ne garde que les points qui ont à la fois une altitude ET une heure
  // valides, dans l'ordre chronologique du fichier.
  const valides = [];
  points.forEach((p, idx) => {
    if (p.altitude !== null && p.time) {
      const t = new Date(p.time).getTime();
      if (!isNaN(t)) valides.push({ idx: idx, t: t, alt: p.altitude });
    }
  });

  const altitudesLissees = new Array(points.length).fill(null);
  if (valides.length === 0) return altitudesLissees;

  const demiFenetreMs = demiFenetreSecondes * 1000;

  // Technique "fenêtre glissante" à deux pointeurs (debut/fin) : comme les
  // points sont triés par temps croissant, les bornes de la fenêtre
  // [t - demiFenetre, t + demiFenetre] ne font qu'avancer au fil des points,
  // jamais reculer. On peut donc calculer la moyenne mobile de tous les
  // points en une seule passe (au lieu de recalculer une moyenne complète à
  // chaque point).
  let debut = 0;
  let fin = 0;
  let sommeAlt = 0;
  let compte = 0;

  for (let i = 0; i < valides.length; i++) {
    const tCentre = valides[i].t;

    // Étend la fenêtre vers l'avant : inclut les points jusqu'à tCentre + demiFenetre.
    while (fin < valides.length && valides[fin].t - tCentre <= demiFenetreMs) {
      sommeAlt += valides[fin].alt;
      compte++;
      fin++;
    }
    // Réduit la fenêtre par l'arrière : exclut les points trop anciens (avant tCentre - demiFenetre).
    while (tCentre - valides[debut].t > demiFenetreMs) {
      sommeAlt -= valides[debut].alt;
      compte--;
      debut++;
    }

    altitudesLissees[valides[i].idx] = compte > 0 ? sommeAlt / compte : valides[i].alt;
  }

  return altitudesLissees;
}

// ============================================================
// FONCTION : parserTCX
// Rôle : transformer le texte XML du fichier .tcx en un objet
// JS structuré et facile à utiliser (durée, distance, etc.)
// ============================================================
function parserTCX(xmlTexte) {
  // Le navigateur sait nativement "parser" du XML grâce à DOMParser
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlTexte, "application/xml");

  // --- a) Infos globales de l'activité, AGRÉGÉES sur tous les "Lap" ---
  // Un .tcx contient un élément <Lap> par "tour" (chaque pression du bouton
  // "tour"/lap sur la montre démarre un nouveau <Lap>) : une activité sans
  // tour manuel n'en a qu'un seul, mais rien ne le garantit. AVANT cette
  // correction, `xmlDoc.querySelector('Lap')` ne récupérait QUE LE PREMIER
  // <Lap> du fichier (querySelector renvoie le premier élément trouvé, pas
  // tous) : une activité où l'utilisateur avait pressé "tour" en cours de
  // route se retrouvait tronquée à la durée/distance/calories du premier
  // tour seulement, alors que le reste de l'activité était bien enregistré
  // dans les tours suivants.
  const lapsXML = xmlDoc.querySelectorAll('Lap');
  const sport = xmlDoc.querySelector('Activity').getAttribute('Sport'); // Running, Biking, etc.
  const dateActivite = xmlDoc.querySelector('Activity > Id').textContent;

  // Stats de CHAQUE tour, gardées à part (pour le tableau "Tours" affiché
  // dans le détail d'activité) en plus de servir à calculer les totaux
  // ci-dessous.
  const laps = [...lapsXML].map(lapXML => {
    const dureeLap = parseFloat(lapXML.querySelector('TotalTimeSeconds')?.textContent) || 0;
    const distanceLap = parseFloat(lapXML.querySelector('DistanceMeters')?.textContent) || 0;
    const caloriesLap = parseInt(lapXML.querySelector('Calories')?.textContent || 0);
    const fcLap = lapXML.querySelector('AverageHeartRateBpm Value')?.textContent;
    return {
      dureeSecondes: dureeLap,
      distanceMetres: distanceLap,
      calories: caloriesLap,
      fcMoyenne: fcLap ? parseInt(fcLap) : null,
      allureMinParKm: distanceLap > 0 ? (dureeLap / 60) / (distanceLap / 1000) : null
    };
  });

  // Durée, distance et calories de l'activité = somme sur tous les tours.
  // La FC moyenne, elle, n'est PAS une simple moyenne des FC moyennes de
  // chaque tour (ça biaiserait vers les tours les plus courts) : chaque
  // <Lap> ne fournit qu'une moyenne locale à SA durée, donc on recalcule la
  // moyenne globale pondérée par la durée de chaque tour.
  const dureeSecondes = laps.reduce((total, l) => total + l.dureeSecondes, 0);
  const distanceMetresLap = laps.reduce((total, l) => total + l.distanceMetres, 0);
  const calories = laps.reduce((total, l) => total + l.calories, 0);
  const sommeFCPonderee = laps.reduce((total, l) => total + (l.fcMoyenne !== null ? l.fcMoyenne * l.dureeSecondes : 0), 0);
  const dureeAvecFC = laps.reduce((total, l) => total + (l.fcMoyenne !== null ? l.dureeSecondes : 0), 0);
  const fcMoyenneActivite = dureeAvecFC > 0 ? Math.round(sommeFCPonderee / dureeAvecFC) : null;

  // --- b) On récupère TOUS les points de la trace (Trackpoints) ---
  const trackpointsXML = xmlDoc.querySelectorAll('Trackpoint');

  // On va construire un tableau JS de points simplifiés,
  // en ignorant les points sans position/altitude (parfois incomplets)
  const points = [];
  trackpointsXML.forEach(tp => {
    const altitude = tp.querySelector('AltitudeMeters');
    const distance = tp.querySelector('DistanceMeters');
    const lat = tp.querySelector('Position > LatitudeDegrees');
    const lon = tp.querySelector('Position > LongitudeDegrees');
    const fc = tp.querySelector('HeartRateBpm Value');
    const time = tp.querySelector('Time');

    points.push({
      time: time ? time.textContent : null,
      lat: lat ? parseFloat(lat.textContent) : null,
      lon: lon ? parseFloat(lon.textContent) : null,
      altitude: altitude ? parseFloat(altitude.textContent) : null,
      distance: distance ? parseFloat(distance.textContent) : null,
      fc: fc ? parseInt(fc.textContent) : null
    });
  });

  // --- b bis) Reconstruction de la distance manquante à partir du GPS ---
  // Certains fichiers .tcx ne fournissent pas <DistanceMeters> sur chaque
  // Trackpoint. Dans ce cas on reconstruit une distance cumulée (en mètres)
  // à partir des coordonnées GPS successives (formule de Haversine), pour
  // que les graphiques d'allure (qui ont besoin de "distance") fonctionnent.
  let distanceCumuleeGPS = 0; // en mètres
  let pointGPSPrecedent = null;

  points.forEach(p => {
    if (p.lat !== null && p.lon !== null) {
      if (pointGPSPrecedent !== null) {
        distanceCumuleeGPS += distanceHaversine(pointGPSPrecedent.lat, pointGPSPrecedent.lon, p.lat, p.lon) * 1000;
      }
      pointGPSPrecedent = p;
    }
    if (p.distance === null && p.lat !== null && p.lon !== null) {
      p.distance = distanceCumuleeGPS;
    }
  });

  // --- c) Calcul du dénivelé positif (D+) ---
  // Principe : on suit une "altitude de référence" qui avance au fil du
  // parcours, et on additionne l'écart chaque fois qu'il DÉPASSE le seuil
  // de bruit — que cet écart se soit construit d'un coup ou petit à petit
  // sur plusieurs points.
  //
  // Pourquoi pas comparer juste 2 points consécutifs (ancienne méthode) ?
  // Parce que sur une montée douce et régulière (ex. une côte de ville),
  // l'écart D'UN POINT À L'AUTRE peut rester en dessous du seuil à chaque
  // fois, alors que l'écart cumulé sur toute la montée est important. En
  // comparant toujours au dernier point "confirmé" plutôt qu'au point
  // juste précédent, on capture bien ces montées progressives tout en
  // continuant à filtrer le bruit du capteur (petites oscillations qui ne
  // dépassent jamais le seuil).
  //
  // On applique ce calcul sur l'altitude LISSÉE (voir lisserAltitudes
  // ci-dessus), pas sur l'altitude brute : sur les sorties longues, la
  // dérive lente de l'altimètre (pression atmosphérique, imprécision GPS)
  // finissait par gonfler le D+ même avec un seuil de bruit, car un seuil
  // seul ne filtre que le bruit point-à-point, pas une dérive progressive
  // sur plusieurs minutes. Le lissage (moyenne mobile sur 90 secondes)
  // atténue cette dérive avant même d'appliquer le seuil.
  const altitudesLissees = lisserAltitudes(points, 45); // fenêtre de 90s (45s de chaque côté)

  let deniveleDPlus = 0;
  const SEUIL_BRUIT = 2; // en mètres (relevé de 0.5 à 2 en même temps que l'ajout du lissage ci-dessus)

  let altitudeReference = null; // dernière altitude "confirmée" (référence courante)

  for (let i = 0; i < points.length; i++) {
    const altitudeActuelle = altitudesLissees[i];
    if (altitudeActuelle === null) continue; // point sans altitude : on l'ignore

    if (altitudeReference === null) {
      // Premier point avec une altitude connue : il amorce la référence.
      altitudeReference = altitudeActuelle;
      continue;
    }

    const difference = altitudeActuelle - altitudeReference;

    if (difference > SEUIL_BRUIT) {
      // Montée confirmée (dépasse le seuil) : on l'ajoute au total, puis on
      // avance la référence jusqu'ici pour pouvoir capter la suite de la
      // montée, même si elle continue par petits pas < 0.5 m.
      deniveleDPlus += difference;
      altitudeReference = altitudeActuelle;
    } else if (difference < -SEUIL_BRUIT) {
      // Vraie descente (dépasse le seuil dans l'autre sens) : on redémarre
      // la référence ici, pour ne pas fausser le calcul de la prochaine
      // montée avec une redescente qu'on aurait ignorée.
      altitudeReference = altitudeActuelle;
    }
    // Sinon (écart entre -0.5 m et +0.5 m) : c'est probablement du bruit de
    // capteur, on ne touche pas à la référence et on continue d'accumuler
    // l'écart au fil des points suivants.
  }

  // --- d) Calcul de l'allure moyenne (min/km) ---
  // Formule : (durée en minutes) / (distance en km)
  const distanceKm = distanceMetresLap / 1000;
  const dureeMinutes = dureeSecondes / 60;
  const allureMinParKm = dureeMinutes / distanceKm;

  // --- e) On renvoie un objet "activité" propre et structuré ---
  return {
    id: dateActivite,             // on utilise la date/heure comme identifiant unique
    sport: sport,
    date: dateActivite,
    dureeSecondes: dureeSecondes,
    distanceMetres: distanceMetresLap,
    allureMinParKm: allureMinParKm,
    fcMoyenne: fcMoyenneActivite,
    calories: calories,
    deniveleDPlus: Math.round(deniveleDPlus),
    rpe: null, // ressenti (1-10) : pas encore renseigné à l'import, on le demande juste après
    nom: null, // nom donné par l'utilisateur (ex. "Sortie longue"), jamais dans le .tcx : saisi après coup, comme le RPE
    laps: laps, // détail par tour ("lap"), pour le tableau affiché dans le détail d'activité
    points: points // on garde le détail, utile pour la carte/graphiques plus tard
  };
}


// ============================================================
// FONCTION : afficherActivite
// Rôle : afficher les stats calculées dans les cases HTML
// ============================================================
function afficherActivite(activite) {
  sectionResultat.style.display = 'block';

  document.getElementById('stat-duree').textContent = formatDuree(activite.dureeSecondes);
  document.getElementById('stat-distance').textContent = (activite.distanceMetres / 1000).toFixed(2) + ' km';
  document.getElementById('stat-allure').textContent = formatAllure(activite.allureMinParKm) + ' /km';
  const vapMoyenne = calculerVAPMoyenneActivite(activite.points);
  document.getElementById('stat-vap').textContent = vapMoyenne !== null ? formatAllure(vapMoyenne) + ' /km' : 'N/A';
  document.getElementById('stat-fc').textContent = activite.fcMoyenne ? activite.fcMoyenne + ' bpm' : 'N/A';
  document.getElementById('stat-denivele').textContent = activite.deniveleDPlus + ' m';
  document.getElementById('stat-calories').textContent = activite.calories + ' kcal';
  document.getElementById('stat-charge').textContent = formaterCharge(calculerCharge(activite));
  document.getElementById('stat-zone').textContent = formaterZone(calculerZone(activite.fcMoyenne));

  // On retient l'id de cette activité, pour que le bouton "Enregistrer le
  // ressenti" juste en dessous sache où sauvegarder. Le sélecteur reprend
  // le RPE déjà enregistré s'il y en a un (utile quand cette fonction est
  // appelée juste pour RÉAFFICHER la dernière activité, pas pour un import
  // tout frais), sinon il reste vide.
  derniereActiviteImporteeId = activite.id;
  document.getElementById('rpe-select').value = activite.rpe ? String(activite.rpe) : '';
  document.getElementById('nom-input').value = activite.nom || '';
}

// --- Petites fonctions utilitaires de formatage ---

// Transforme des secondes en format "1h 23min 45s"
function formatDuree(secondes) {
  const h = Math.floor(secondes / 3600);
  const m = Math.floor((secondes % 3600) / 60);
  const s = Math.floor(secondes % 60);
  let texte = '';
  if (h > 0) texte += h + 'h ';
  texte += m + 'min ' + s + 's';
  return texte;
}

// Transforme une allure décimale (ex: 5.75 min/km) en "5:45"
function formatAllure(minParKm) {
  const minutes = Math.floor(minParKm);
  const secondes = Math.round((minParKm - minutes) * 60);
  return minutes + ':' + secondes.toString().padStart(2, '0');
}

// ============================================================
// RÉGLAGES (FC repos / FC max / courbe TRIMP)
// Stockés dans Firestore (document users/{uid}/reglages/config), pour être
// disponibles depuis n'importe quel appareil connecté au même compte —
// avant le passage au cloud, c'était dans le localStorage du navigateur
// (propre à un seul ordinateur).
//
// `reglagesCache` est une copie EN MÉMOIRE tenue à jour automatiquement par
// l'écouteur Firestore (demarrerEcouteReglages, plus bas). Tout le reste du
// code (calculerCharge, calculerZone, etc.) continue d'appeler
// lireReglages() de façon SYNCHRONE exactement comme avant : c'est ce cache
// qui permet de garder ces fonctions inchangées malgré le passage à une
// base de données en ligne (par nature asynchrone).
// ============================================================

let reglagesCache = { fcRepos: null, fcMax: null, courbeTrimp: 'homme' };

// Lit les réglages actuels (depuis le cache local, mis à jour en tâche de
// fond par Firestore). Renvoie null pour fcRepos/fcMax s'ils n'ont pas
// encore été renseignés (plutôt que 0, qui fausserait les calculs).
function lireReglages() {
  return reglagesCache;
}

function enregistrerReglages(reglages) {
  // On RENVOIE la promesse (au lieu de l'ignorer) : ça permet à l'appelant
  // (le bouton "Enregistrer" plus bas) de savoir si l'écriture a vraiment
  // réussi, au lieu d'afficher un message de succès inconditionnel qui
  // mentirait en cas d'échec (ex. règles de sécurité Firestore mal
  // configurées). Pas besoin de mettre à jour reglagesCache ici : l'écouteur
  // Firestore (demarrerEcouteReglages) le fera dès que l'écriture sera
  // confirmée, quasi instantanément grâce au cache local de Firestore.
  return db.collection('users').doc(uidActuel).collection('reglages').doc('config').set(reglages);
}

// Remplit les champs du formulaire "Réglages" avec les valeurs actuelles du
// cache (appelé à chaque mise à jour du cache, pas seulement au chargement,
// pour rester synchronisé si les réglages changent depuis un AUTRE appareil).
function initialiserFormulaireReglages() {
  const reglages = lireReglages();
  document.getElementById('reglage-fc-repos').value = reglages.fcRepos !== null ? reglages.fcRepos : '';
  document.getElementById('reglage-fc-max').value = reglages.fcMax !== null ? reglages.fcMax : '';
  document.getElementById('reglage-courbe-trimp').value = reglages.courbeTrimp;
}

// Écoute Firestore en continu : se déclenche une première fois avec les
// valeurs actuelles, puis à chaque changement (fait depuis CET appareil ou
// un autre). Renvoie une fonction pour arrêter l'écoute (à la déconnexion).
function demarrerEcouteReglages(uid) {
  return db.collection('users').doc(uid).collection('reglages').doc('config')
    .onSnapshot(function (doc) {
      const data = doc.data() || {};
      reglagesCache = {
        fcRepos: Number.isFinite(data.fcRepos) ? data.fcRepos : null,
        fcMax: Number.isFinite(data.fcMax) ? data.fcMax : null,
        courbeTrimp: data.courbeTrimp === 'femme' ? 'femme' : 'homme'
      };
      initialiserFormulaireReglages();
      // La charge (TRIMP) dépend des réglages : on rafraîchit tout ce qui
      // en affiche (tableau, aperçu, récap, ACWR) dès qu'ils changent.
      rafraichirAffichageActivites();
      if (activiteEnCoursAffichage !== null) {
        const act = activitesEnMemoire[activiteEnCoursAffichage];
        if (act) document.getElementById('detail-charge').textContent = formaterCharge(calculerCharge(act));
      }
    }, function (erreur) {
      console.error('Erreur d\'écoute des réglages :', erreur);
    });
}

document.getElementById('btn-enregistrer-reglages').addEventListener('click', function () {
  const fcRepos = parseInt(document.getElementById('reglage-fc-repos').value);
  const fcMax = parseInt(document.getElementById('reglage-fc-max').value);
  const courbeTrimp = document.getElementById('reglage-courbe-trimp').value;
  const message = document.getElementById('reglages-message');

  // On attend la confirmation de Firestore avant d'afficher quoi que ce
  // soit : ✅ seulement si l'écriture a vraiment réussi, ❌ avec le code
  // d'erreur exact sinon (ex. "permission-denied" = règles de sécurité
  // Firestore à vérifier dans la console).
  enregistrerReglages({
    fcRepos: Number.isFinite(fcRepos) ? fcRepos : null,
    fcMax: Number.isFinite(fcMax) ? fcMax : null,
    courbeTrimp: courbeTrimp
  }).then(() => {
    message.textContent = '✅ Réglages enregistrés.';
    message.style.display = 'block';
    setTimeout(() => { message.style.display = 'none'; }, 3000);
  }).catch(erreur => {
    console.error('Erreur d\'enregistrement des réglages :', erreur);
    message.textContent = `❌ Échec de l'enregistrement (${erreur.code || erreur.message || 'erreur inconnue'}). Vérifie ta connexion et les règles de sécurité Firestore (voir firebase-config.js).`;
    message.style.display = 'block';
  });
});

// ============================================================
// TEST VO2MAX ET ZONES D'ENTRAÎNEMENT
// Le VO2max lui-même est juste gardé pour référence (pas encore utilisé
// dans un calcul). Ce qui est directement exploitable, ce sont les ZONES
// D'ENTRAÎNEMENT en FC issues du test labo : bien plus précises que des
// zones génériques (% de FC max), puisqu'elles viennent de TES seuils
// ventilatoires mesurés. On ne stocke que 4 limites (le haut des zones
// 1 à 4) ; le haut de la zone 5 est ta FC max, déjà réglée juste au-dessus
// — pas besoin de la redemander deux fois.
// ============================================================

// Ancienne clé localStorage, utilisée AVANT le passage à Firestore (encore
// référencée par migrerDonneesLocales(), plus bas, pour récupérer les
// données d'un appareil pas encore migré).
const CLE_LOCALSTORAGE_VO2MAX = 'suiviSportifVO2max';
const NOMS_ZONES = ['Z1 - Récupération', 'Z2 - Endurance', 'Z3 - Tempo', 'Z4 - Seuil', 'Z5 - Max'];

// Même principe que reglagesCache (voir section RÉGLAGES juste au-dessus) :
// copie en mémoire tenue à jour par l'écouteur Firestore (demarrerEcouteVO2max),
// pour que lireDonneesVO2max() reste une fonction SYNCHRONE comme avant.
let vo2maxCache = { vo2max: null, dateTest: null, limites: [null, null, null, null] };

function lireDonneesVO2max() {
  return vo2maxCache;
}

function enregistrerDonneesVO2max(data) {
  // On RENVOIE la promesse, pour la même raison que enregistrerReglages()
  // ci-dessus : détecter un échec d'écriture (ex. règles de sécurité) au
  // lieu d'afficher un succès qui n'aurait pas eu lieu. Pas besoin de
  // mettre à jour vo2maxCache ici : l'écouteur Firestore
  // (demarrerEcouteVO2max) le fera dès que l'écriture sera confirmée.
  return db.collection('users').doc(uidActuel).collection('vo2max').doc('config').set(data);
}

// Détermine la zone d'entraînement d'une FC moyenne donnée, à partir des
// 4 limites + de la FC max (réglages). Renvoie null si tout n'est pas
// configuré, ou si l'activité n'a pas de FC moyenne enregistrée.
function calculerZone(fcMoyenne) {
  if (!fcMoyenne) return null;

  const { fcMax } = lireReglages();
  const { limites } = lireDonneesVO2max();
  if (fcMax === null || limites.some(l => l === null)) return null;

  const bornesHautes = [...limites, fcMax]; // sommet de Z1..Z5
  for (let i = 0; i < bornesHautes.length; i++) {
    if (fcMoyenne <= bornesHautes[i]) return NOMS_ZONES[i];
  }
  return NOMS_ZONES[NOMS_ZONES.length - 1]; // au-dessus de la FC max réglée (capteur qui dérive) -> on reste en Z5
}

function formaterZone(zone) {
  return zone !== null ? zone : 'N/A (renseigne tes zones dans les réglages)';
}

// Construit le petit tableau récapitulatif des 5 zones (FC min/max),
// affiché sous le formulaire une fois que tout est configuré.
function afficherRecapZones() {
  const tableau = document.getElementById('tableau-zones-recap');
  const corps = document.getElementById('corps-tableau-zones-recap');
  const { fcMax } = lireReglages();
  const { limites } = lireDonneesVO2max();

  if (fcMax === null || limites.some(l => l === null)) {
    tableau.style.display = 'none';
    return;
  }

  const bornesBasses = [0, ...limites];
  const bornesHautes = [...limites, fcMax];
  corps.innerHTML = '';
  NOMS_ZONES.forEach((nom, i) => {
    const ligne = document.createElement('tr');
    ligne.innerHTML = `<td>${nom}</td><td>${i === 0 ? '—' : bornesBasses[i]}</td><td>${bornesHautes[i]}</td>`;
    corps.appendChild(ligne);
  });
  tableau.style.display = 'table';
}

// Remplit le formulaire "Test VO2max" avec les valeurs sauvegardées
// (appelé une fois au chargement de la page)
function initialiserFormulaireVO2max() {
  const data = lireDonneesVO2max();
  if (data.vo2max !== null) document.getElementById('vo2max-valeur').value = data.vo2max;
  if (data.dateTest !== null) document.getElementById('vo2max-date').value = data.dateTest;
  data.limites.forEach((limite, i) => {
    if (limite !== null) document.getElementById('zone-limite-' + (i + 1)).value = limite;
  });
  afficherRecapZones();
}

// Écoute Firestore en continu (voir demarrerEcouteReglages ci-dessus pour le
// même principe en détail) : met à jour vo2maxCache, réaffiche le formulaire
// et la zone/le tableau des zones, puis rafraîchit tout ce qui dépend d'une
// ZONE (elle-même calculée à partir des limites VO2max), càd le tableau
// d'activités et le détail ouvert le cas échéant.
function demarrerEcouteVO2max(uid) {
  return db.collection('users').doc(uid).collection('vo2max').doc('config')
    .onSnapshot(function (doc) {
      const data = doc.data() || {};
      vo2maxCache = {
        vo2max: Number.isFinite(data.vo2max) ? data.vo2max : null,
        dateTest: data.dateTest || null,
        limites: Array.isArray(data.limites) && data.limites.length === 4
          ? data.limites.map(l => (Number.isFinite(l) ? l : null))
          : [null, null, null, null]
      };
      initialiserFormulaireVO2max(); // remplit le formulaire + appelle afficherRecapZones()
      rafraichirAffichageActivites();
      if (activiteEnCoursAffichage !== null) {
        const act = activitesEnMemoire[activiteEnCoursAffichage];
        if (act) document.getElementById('detail-zone').textContent = formaterZone(calculerZone(act.fcMoyenne));
      }
    }, function (erreur) {
      console.error('Erreur d\'écoute VO2max :', erreur);
    });
}

document.getElementById('btn-enregistrer-vo2max').addEventListener('click', function () {
  const vo2max = parseFloat(document.getElementById('vo2max-valeur').value);
  const dateTest = document.getElementById('vo2max-date').value || null;
  const limites = [1, 2, 3, 4].map(i => {
    const valeur = parseInt(document.getElementById('zone-limite-' + i).value);
    return Number.isFinite(valeur) ? valeur : null;
  });
  const message = document.getElementById('vo2max-message');

  enregistrerDonneesVO2max({
    vo2max: Number.isFinite(vo2max) ? vo2max : null,
    dateTest,
    limites
  }).then(() => {
    message.textContent = '✅ Données enregistrées.';
    message.style.display = 'block';
    setTimeout(() => { message.style.display = 'none'; }, 3000);
  }).catch(erreur => {
    console.error('Erreur d\'enregistrement VO2max :', erreur);
    message.textContent = `❌ Échec de l'enregistrement (${erreur.code || erreur.message || 'erreur inconnue'}). Vérifie ta connexion et les règles de sécurité Firestore (voir firebase-config.js).`;
    message.style.display = 'block';
  });
});

// ============================================================
// CHARGE D'ENTRAÎNEMENT (méthode TRIMP de Banister)
// Le TRIMP ("TRaining IMPulse") est une estimation objective de la charge
// d'un entraînement, basée sur la durée et l'intensité cardiaque (par
// rapport à ta réserve de FC = FC max - FC repos). C'est l'équivalent
// "maison" (et transparent) de l'indice de charge propriétaire de Garmin,
// qui lui se base sur l'EPOC (excès de consommation d'oxygène post-effort) —
// une donnée qu'on n'a pas accès depuis un simple fichier .tcx.
//
// Formule (Banister, 1991) :
//   ΔHR = (FCmoyenne - FCrepos) / (FCmax - FCrepos)   -> intensité relative, entre 0 et 1
//   TRIMP = durée (min) × ΔHR × a × e^(b × ΔHR)
// avec (a, b) = (0.64, 1.92) pour la courbe "homme", (0.86, 1.67) pour "femme"
// (ces coefficients ajustent juste la façon dont l'effort "s'envole" aux
// hautes intensités ; à choisir dans les Réglages).
//
// Volontairement calculé à la volée (jamais stocké avec l'activité) : si tu
// corriges tes FC repos/max dans les réglages, toutes les charges déjà
// affichées se recalculent avec les nouvelles valeurs, au lieu de rester
// figées sur une estimation obsolète.
// ============================================================

function calculerCharge(activite) {
  if (!activite.fcMoyenne) return null; // pas de FC enregistrée sur cette activité

  const { fcRepos, fcMax, courbeTrimp } = lireReglages();
  if (fcRepos === null || fcMax === null || fcMax <= fcRepos) return null; // réglages manquants/incohérents

  // On "clampe" entre 0 et 1 : une FC moyenne aberrante (en dessous du repos
  // ou au-dessus du max, à cause d'un capteur défaillant) ne doit pas faire
  // planter le calcul ni produire un résultat absurde.
  const deltaHR = Math.min(1, Math.max(0, (activite.fcMoyenne - fcRepos) / (fcMax - fcRepos)));

  const [a, b] = courbeTrimp === 'femme' ? [0.86, 1.67] : [0.64, 1.92];
  const dureeMinutes = activite.dureeSecondes / 60;
  const trimp = dureeMinutes * deltaHR * a * Math.exp(b * deltaHR);

  return Math.round(trimp);
}

// Formate le résultat de calculerCharge() pour l'affichage, avec un message
// explicite quand le calcul n'a pas pu se faire (plutôt qu'un simple "--").
function formaterCharge(charge) {
  if (charge !== null) return String(charge);
  return 'N/A (renseigne tes FC dans les réglages)';
}

// ============================================================
// RESSENTI (RPE) — saisi manuellement par l'utilisateur après la séance,
// entre 1 (tranquille) et 10 (maximal). Contrairement à la charge TRIMP
// (calculée), c'est une donnée SUBJECTIVE : l'intérêt est justement de les
// comparer (est-ce qu'une séance qui "paraissait" dure l'était vraiment ?).
// ============================================================

// Met à jour le champ "rpe" d'une activité déjà enregistrée dans Firestore.
// callback(succes) est appelé une fois l'opération terminée. Pas besoin de
// rafraîchir le tableau ici : l'écouteur Firestore (demarrerEcouteActivites)
// s'en charge dès que l'écriture est confirmée.
function enregistrerRPE(idActivite, valeurRPE, callback) {
  db.collection('users').doc(uidActuel).collection('activites').doc(idActivite)
    .update({ rpe: valeurRPE })
    .then(() => { if (callback) callback(true); })
    .catch(erreur => {
      console.error('Erreur d\'enregistrement du RPE :', erreur);
      if (callback) callback(false);
    });
}

document.getElementById('btn-valider-rpe').addEventListener('click', function () {
  const valeur = document.getElementById('rpe-select').value;
  if (!valeur || derniereActiviteImporteeId === null) return;
  enregistrerRPE(derniereActiviteImporteeId, parseInt(valeur));
});

document.getElementById('btn-valider-detail-rpe').addEventListener('click', function () {
  const valeur = document.getElementById('detail-rpe-select').value;
  if (!valeur || activiteEnCoursAffichage === null) return;
  const act = activitesEnMemoire[activiteEnCoursAffichage];
  if (!act) return;
  enregistrerRPE(act.id, parseInt(valeur), function (succes) {
    if (succes) act.rpe = parseInt(valeur); // on garde l'objet en mémoire synchronisé
  });
});

// ============================================================
// NOM DE L'ACTIVITÉ — saisi librement par l'utilisateur (ex. "Sortie
// longue", "Fractionné au parc"), pour se repérer plus facilement dans le
// tableau historique qu'avec la seule date. Un `.tcx` ne contient aucun
// titre : ce champ est donc toujours vide à l'import, et se saisit après
// coup — même principe que le RPE juste au-dessus.
// ============================================================

// Met à jour le champ "nom" d'une activité déjà enregistrée dans Firestore.
// Une valeur vide (une fois les espaces superflus enlevés) est enregistrée
// comme `null`, pour permettre de retirer un nom déjà donné. On RENVOIE la
// promesse (même principe que sauvegarderActivite/enregistrerReglages) pour
// que l'appelant sache attendre la confirmation avant d'afficher "✅".
function enregistrerNom(idActivite, valeurNom) {
  const nomNettoye = valeurNom.trim() === '' ? null : valeurNom.trim();
  return db.collection('users').doc(uidActuel).collection('activites').doc(idActivite)
    .update({ nom: nomNettoye })
    .then(() => nomNettoye)
    .catch(erreur => {
      console.error('Erreur d\'enregistrement du nom :', erreur);
      throw erreur;
    });
}

document.getElementById('btn-valider-nom').addEventListener('click', function () {
  if (derniereActiviteImporteeId === null) return;
  const valeur = document.getElementById('nom-input').value;
  const message = document.getElementById('nom-message');
  enregistrerNom(derniereActiviteImporteeId, valeur)
    .then(nomNettoye => {
      // Si l'activité tout juste importée est toujours affichée, on garde
      // le champ synchronisé avec la valeur réellement enregistrée (ex. si
      // l'utilisateur n'avait tapé que des espaces, le champ se vide).
      const idx = activitesEnMemoire.findIndex(a => a.id === derniereActiviteImporteeId);
      if (idx !== -1) activitesEnMemoire[idx].nom = nomNettoye;
      document.getElementById('nom-input').value = nomNettoye || '';
      message.textContent = '✅ Nom enregistré.';
      message.style.display = 'block';
      setTimeout(() => { message.style.display = 'none'; }, 3000);
    })
    .catch(erreur => {
      message.textContent = `❌ Échec de l'enregistrement (${erreur.code || erreur.message || 'erreur inconnue'}). Vérifie ta connexion et les règles de sécurité Firestore (voir firebase-config.js).`;
      message.style.display = 'block';
    });
});

document.getElementById('btn-valider-detail-nom').addEventListener('click', function () {
  if (activiteEnCoursAffichage === null) return;
  const act = activitesEnMemoire[activiteEnCoursAffichage];
  if (!act) return;
  const valeur = document.getElementById('detail-nom-input').value;
  const message = document.getElementById('detail-nom-message');
  enregistrerNom(act.id, valeur)
    .then(nomNettoye => {
      act.nom = nomNettoye; // on garde l'objet en mémoire synchronisé
      document.getElementById('detail-nom-input').value = nomNettoye || '';
      document.getElementById('detail-titre').textContent = act.nom
        ? `${act.nom} — ${formatDate(act.date)}`
        : `Détail de l'activité du ${formatDate(act.date)}`;
      message.textContent = '✅ Nom enregistré.';
      message.style.display = 'block';
      setTimeout(() => { message.style.display = 'none'; }, 3000);
    })
    .catch(erreur => {
      message.textContent = `❌ Échec de l'enregistrement (${erreur.code || erreur.message || 'erreur inconnue'}). Vérifie ta connexion et les règles de sécurité Firestore (voir firebase-config.js).`;
      message.style.display = 'block';
    });
});

// ============================================================
// APERÇU SEMAINE / MOIS (page Accueil)
// Affiche, jour par jour sur la semaine ou le mois en cours, des courbes
// CUMULATIVES (somme depuis le début de la période) des métriques que
// l'utilisateur choisit d'afficher : distance, charge (TRIMP), RPE, D+.
// Chaque métrique a sa propre échelle (axe Y), vu que "5 km" et "300 de
// charge" n'ont rien à voir — Chart.js permet plusieurs axes Y sur un
// même graphique, activés/désactivés en même temps que leur case à cocher.
// ============================================================

let chartApercuInstance = null;
let periodeApercuActuelle = 'semaine'; // 'semaine' ou 'mois'

// Décalage (en nombre de semaines ou de mois, selon periodeApercuActuelle)
// par rapport à la période EN COURS : 0 = période en cours, -1 = précédente,
// -2 = encore avant, etc. On ne va jamais au-dessus de 0 (pas de données
// futures à afficher) — voir le bouton "suivant" désactivé dans afficherApercu().
let offsetPeriodeApercu = 0;

// Renvoie les bornes {debut, fin} (objets Date) de la période demandée :
// la semaine ISO (lundi -> dimanche) ou le mois calendaire, décalé de
// "offset" semaines/mois par rapport à celui contenant aujourd'hui.
function obtenirBornesPeriode(periode, offset = 0) {
  const aujourdHui = new Date();
  const debut = new Date(aujourdHui.getFullYear(), aujourdHui.getMonth(), aujourdHui.getDate());
  const fin = new Date(debut);

  if (periode === 'mois') {
    debut.setMonth(debut.getMonth() + offset, 1); // 1er jour du mois ciblé
    fin.setTime(debut.getTime());
    fin.setMonth(fin.getMonth() + 1, 0); // dernier jour de ce même mois (jour 0 du mois suivant)
  } else {
    // Semaine du lundi au dimanche. getDay() renvoie 0 pour dimanche,
    // 1 pour lundi, etc. — on calcule le décalage jusqu'au lundi précédent,
    // puis on décale de "offset" semaines entières.
    const jourSemaine = debut.getDay();
    const decalageLundi = (jourSemaine === 0) ? 6 : jourSemaine - 1;
    debut.setDate(debut.getDate() - decalageLundi + offset * 7);
    fin.setTime(debut.getTime());
    fin.setDate(fin.getDate() + 6);
  }
  fin.setHours(23, 59, 59, 999);
  return { debut, fin };
}

// Formate le libellé de la période affichée au-dessus du graphique
// (ex: "Semaine du 08/09 au 14/09" ou "Septembre 2026").
function formaterLabelPeriode(periode, debut, fin) {
  if (periode === 'mois') {
    const texte = debut.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    return texte.charAt(0).toUpperCase() + texte.slice(1); // "septembre 2026" -> "Septembre 2026"
  }
  const opts = { day: '2-digit', month: '2-digit' };
  return `Semaine du ${debut.toLocaleDateString('fr-FR', opts)} au ${fin.toLocaleDateString('fr-FR', opts)}`;
}

// Construit, jour par jour sur la période, les séries CUMULATIVES des 4
// métriques sélectionnables.
function calculerSeriesApercu(periode, offset = 0) {
  const { debut, fin } = obtenirBornesPeriode(periode, offset);

  const labels = [];
  // `fin` a son heure calée à 23:59:59.999 (pour que le filtre "activité
  // dans la période" inclue bien toute la dernière journée) : on retombe
  // sur son minuit pour le calcul du nombre de jours, sinon la présence de
  // ces 999ms fait arrondir Math.round(...) un jour de trop.
  const finMinuit = new Date(fin.getFullYear(), fin.getMonth(), fin.getDate());
  const nbJours = Math.round((finMinuit - debut) / (24 * 3600 * 1000)) + 1;
  for (let i = 0; i < nbJours; i++) {
    const jour = new Date(debut);
    jour.setDate(jour.getDate() + i);
    labels.push(jour.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
  }

  const distanceParJour = new Array(nbJours).fill(0);
  const chargeParJour = new Array(nbJours).fill(0);
  const rpeParJour = new Array(nbJours).fill(0);
  const deniveleParJour = new Array(nbJours).fill(0);

  activitesEnMemoire.forEach(act => {
    const dateActivite = new Date(act.date);
    if (dateActivite < debut || dateActivite > fin) return;

    const indexJour = Math.floor((dateActivite - debut) / (24 * 3600 * 1000));
    if (indexJour < 0 || indexJour >= nbJours) return;

    distanceParJour[indexJour] += act.distanceMetres / 1000;
    const charge = calculerCharge(act);
    if (charge !== null) chargeParJour[indexJour] += charge;
    if (act.rpe) rpeParJour[indexJour] += act.rpe;
    deniveleParJour[indexJour] += act.deniveleDPlus;
  });

  // Transforme des totaux JOURNALIERS en courbe CUMULATIVE (somme progressive)
  const cumuler = (tableau) => {
    let somme = 0;
    return tableau.map(v => (somme += v));
  };

  return {
    labels,
    distance: cumuler(distanceParJour),
    charge: cumuler(chargeParJour),
    rpe: cumuler(rpeParJour),
    denivele: cumuler(deniveleParJour)
  };
}

// Description de chaque métrique sélectionnable : la case à cocher qui la
// contrôle, sa couleur, et son propre axe Y (id unique pour Chart.js).
const METRIQUES_APERCU = [
  { cle: 'distance', idCase: 'metrique-distance', libelle: 'Distance cumulée (km)', couleur: 'rgb(75, 192, 192)', axe: 'yDistance' },
  { cle: 'charge', idCase: 'metrique-charge', libelle: 'Charge cumulée (TRIMP)', couleur: 'rgb(255, 99, 132)', axe: 'yCharge' },
  { cle: 'rpe', idCase: 'metrique-rpe', libelle: 'RPE cumulé', couleur: 'rgb(255, 159, 64)', axe: 'yRpe' },
  { cle: 'denivele', idCase: 'metrique-denivele', libelle: 'D+ cumulé (m)', couleur: 'rgb(153, 102, 255)', axe: 'yDenivele' }
];

function afficherApercu() {
  const canvas = document.getElementById('chartApercu');
  if (!canvas) return; // sécurité si jamais la page Accueil n'est pas encore dans le DOM
  const ctx = canvas.getContext('2d');
  if (chartApercuInstance) chartApercuInstance.destroy();

  const { debut, fin } = obtenirBornesPeriode(periodeApercuActuelle, offsetPeriodeApercu);
  const series = calculerSeriesApercu(periodeApercuActuelle, offsetPeriodeApercu);

  // Libellé de la période affichée + état des boutons de navigation
  const labelPeriode = document.getElementById('apercu-periode-label');
  if (labelPeriode) labelPeriode.textContent = formaterLabelPeriode(periodeApercuActuelle, debut, fin);

  const btnSuivante = document.getElementById('btn-periode-suivante');
  if (btnSuivante) btnSuivante.disabled = (offsetPeriodeApercu >= 0); // jamais de période future

  const btnAujourdhui = document.getElementById('btn-periode-aujourdhui');
  if (btnAujourdhui) btnAujourdhui.style.display = (offsetPeriodeApercu === 0) ? 'none' : 'inline-block';

  const datasets = [];
  const scales = {
    x: { title: { display: true, text: periodeApercuActuelle === 'mois' ? 'Jour du mois' : 'Jour de la semaine' } }
  };

  METRIQUES_APERCU.forEach((metrique, i) => {
    const caseACocher = document.getElementById(metrique.idCase);
    const active = caseACocher ? caseACocher.checked : false;

    datasets.push({
      label: metrique.libelle,
      data: series[metrique.cle],
      borderColor: metrique.couleur,
      backgroundColor: metrique.couleur,
      borderWidth: 2,
      pointRadius: 3,
      tension: 0.15,
      hidden: !active,
      yAxisID: metrique.axe
    });

    // On n'affiche l'axe Y correspondant que si la métrique est cochée,
    // sinon le graphique se retrouve avec 4 échelles vides et illisibles.
    // Alternance gauche/droite pour ne pas tout empiler du même côté.
    scales[metrique.axe] = {
      type: 'linear',
      display: active,
      position: i % 2 === 0 ? 'left' : 'right',
      title: { display: true, text: metrique.libelle },
      grid: { drawOnChartArea: i === 0 } // une seule grille de fond, sinon ça se superpose
    };
  });

  chartApercuInstance = new Chart(ctx, {
    type: 'line',
    data: { labels: series.labels, datasets },
    options: {
      responsive: true,
      plugins: { legend: { display: true, position: 'top' } },
      scales
    }
  });
}

document.getElementById('btn-periode-semaine').addEventListener('click', () => changerPeriodeApercu('semaine'));
document.getElementById('btn-periode-mois').addEventListener('click', () => changerPeriodeApercu('mois'));

function changerPeriodeApercu(periode) {
  periodeApercuActuelle = periode;
  offsetPeriodeApercu = 0; // on repart de la période en cours à chaque changement semaine/mois
  document.getElementById('btn-periode-semaine').classList.toggle('actif', periode === 'semaine');
  document.getElementById('btn-periode-mois').classList.toggle('actif', periode === 'mois');
  afficherApercu();
}

// --- Navigation entre périodes (précédente / suivante / retour à aujourd'hui) ---
document.getElementById('btn-periode-precedente').addEventListener('click', () => {
  offsetPeriodeApercu -= 1;
  afficherApercu();
});

document.getElementById('btn-periode-suivante').addEventListener('click', () => {
  if (offsetPeriodeApercu >= 0) return; // sécurité (le bouton est de toute façon désactivé dans ce cas)
  offsetPeriodeApercu += 1;
  afficherApercu();
});

document.getElementById('btn-periode-aujourdhui').addEventListener('click', () => {
  offsetPeriodeApercu = 0;
  afficherApercu();
});

METRIQUES_APERCU.forEach(metrique => {
  document.getElementById(metrique.idCase).addEventListener('change', afficherApercu);
});

// ============================================================
// RÉCAP SEMAINE PRÉCÉDENTE VS SEMAINE EN COURS (page Accueil)
// Contrairement au graphique d'aperçu ci-dessus (cumulatif, navigable), ce
// petit tableau compare toujours LA semaine en cours à LA précédente, avec
// des TOTAUX (pas une courbe jour par jour) : un coup d'œil rapide, sans
// interaction.
// ============================================================

// Calcule les totaux d'une semaine donnée (offset 0 = en cours, -1 = précédente).
function calculerRecapSemaine(offset) {
  const { debut, fin } = obtenirBornesPeriode('semaine', offset);
  let distance = 0, charge = 0, denivele = 0, sommeRPE = 0, nbRPE = 0, nbSeances = 0;

  activitesEnMemoire.forEach(act => {
    const dateActivite = new Date(act.date);
    if (dateActivite < debut || dateActivite > fin) return;

    nbSeances++;
    distance += act.distanceMetres / 1000;
    const c = calculerCharge(act);
    if (c !== null) charge += c;
    denivele += act.deniveleDPlus;
    if (act.rpe) { sommeRPE += act.rpe; nbRPE++; }
  });

  return {
    nbSeances,
    distance,
    charge,
    denivele,
    rpeMoyen: nbRPE > 0 ? sommeRPE / nbRPE : null
  };
}

function afficherRecapSemaines() {
  const corps = document.getElementById('corps-tableau-recap-semaines');
  if (!corps) return; // sécurité si jamais la page Accueil n'est pas encore dans le DOM

  const precedente = calculerRecapSemaine(-1);
  const actuelle = calculerRecapSemaine(0);

  const ligne = (libelle, val1, val2) => `<tr><td>${libelle}</td><td>${val1}</td><td>${val2}</td></tr>`;

  corps.innerHTML =
    ligne('Séances', precedente.nbSeances, actuelle.nbSeances) +
    ligne('Distance', precedente.distance.toFixed(1) + ' km', actuelle.distance.toFixed(1) + ' km') +
    ligne('Charge (TRIMP)', Math.round(precedente.charge), Math.round(actuelle.charge)) +
    ligne('D+', Math.round(precedente.denivele) + ' m', Math.round(actuelle.denivele) + ' m') +
    ligne(
      'RPE moyen',
      precedente.rpeMoyen !== null ? precedente.rpeMoyen.toFixed(1) + '/10' : '--',
      actuelle.rpeMoyen !== null ? actuelle.rpeMoyen.toFixed(1) + '/10' : '--'
    );
}

// ============================================================
// ACWR (Acute:Chronic Workload Ratio) — page Accueil
// Indicateur emprunté aux sciences du sport pour repérer un risque de
// blessure par SURCHARGE : compare la charge d'entraînement "aiguë" (somme
// des 7 derniers jours) à la charge "chronique" habituelle (moyenne
// hebdomadaire sur les 4 dernières semaines, donc somme des 28 derniers
// jours / 4). Un ratio qui grimpe trop vite (> 1.5) signale une hausse de
// charge trop rapide par rapport à ce à quoi le corps est habitué ; une
// zone "sweet spot" ~0.8-1.3 est généralement citée comme raisonnable
// (Gabbett, 2016) — un repère indicatif, pas une règle absolue.
//
// Utilise la charge TRIMP déjà calculée par calculerCharge() (donc dépend
// des réglages FC repos/FC max) comme mesure de charge quotidienne.
// ============================================================

let chartACWRInstance = null;

// Construit les séries (labels + valeurs ACWR) sur une fenêtre glissante.
// Renvoie { statut: 'ok', labels, acwr } ou { statut: <raison> } si le
// calcul n'est pas possible/fiable pour l'instant (voir MESSAGES_ACWR).
function calculerSeriesACWR() {
  const { fcRepos, fcMax } = lireReglages();
  if (fcRepos === null || fcMax === null) return { statut: 'reglages-manquants' };
  if (activitesEnMemoire.length === 0) return { statut: 'aucune-activite' };

  // Table "jour -> charge totale de ce jour" (une journée peut avoir
  // plusieurs séances). Les activités sans charge calculable (FC manquante)
  // n'y contribuent pas.
  const chargeParJour = new Map();
  activitesEnMemoire.forEach(act => {
    const charge = calculerCharge(act);
    if (charge === null) return;
    const jourActivite = new Date(act.date);
    const cle = new Date(jourActivite.getFullYear(), jourActivite.getMonth(), jourActivite.getDate()).getTime();
    chargeParJour.set(cle, (chargeParJour.get(cle) || 0) + charge);
  });
  const chargeDuJour = (dateJour) => chargeParJour.get(dateJour.getTime()) || 0;

  // Première activité connue = la plus ancienne (activitesEnMemoire n'est
  // pas forcément triée par date après un tri manuel du tableau, donc on la
  // retrouve explicitement plutôt que de supposer une position).
  const premiereDate = activitesEnMemoire.reduce(
    (plusAncienne, act) => (new Date(act.date) < new Date(plusAncienne.date) ? act : plusAncienne),
    activitesEnMemoire[0]
  ).date;

  const aujourdHui = new Date();
  const aujourdHuiMinuit = new Date(aujourdHui.getFullYear(), aujourdHui.getMonth(), aujourdHui.getDate());

  // Il faut au moins 28 jours d'historique pour que la charge "chronique"
  // (moyenne sur 4 semaines) ait un sens ; avant ça, la diviser par 4 sous-
  // estimerait artificiellement le dénominateur et gonflerait l'ACWR.
  const premiereDateObj = new Date(premiereDate);
  const premierJourValide = new Date(premiereDateObj.getFullYear(), premiereDateObj.getMonth(), premiereDateObj.getDate());
  premierJourValide.setDate(premierJourValide.getDate() + 27);
  if (premierJourValide > aujourdHuiMinuit) return { statut: 'historique-insuffisant' };

  // On limite l'affichage aux ~90 derniers jours pour garder un graphique
  // lisible, même si l'historique réel est plus long (le calcul de chaque
  // point utilise quand même TOUT l'historique disponible en amont).
  const debutAffichage = new Date(aujourdHuiMinuit);
  debutAffichage.setDate(debutAffichage.getDate() - 89);
  const debutCourbe = premierJourValide > debutAffichage ? premierJourValide : debutAffichage;

  const labels = [];
  const acwr = [];
  const jour = new Date(debutCourbe);
  while (jour <= aujourdHuiMinuit) {
    let acute = 0;
    let chronic = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(jour);
      d.setDate(d.getDate() - i);
      acute += chargeDuJour(d);
    }
    for (let i = 0; i < 28; i++) {
      const d = new Date(jour);
      d.setDate(d.getDate() - i);
      chronic += chargeDuJour(d);
    }
    const chargeChroniqueHebdo = chronic / 4;

    labels.push(jour.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
    acwr.push(chargeChroniqueHebdo > 0 ? Math.round((acute / chargeChroniqueHebdo) * 100) / 100 : null);

    jour.setDate(jour.getDate() + 1);
  }

  return { statut: 'ok', labels, acwr };
}

const MESSAGES_ACWR = {
  'reglages-manquants': "Renseigne ta FC repos et ta FC max dans les Réglages : l'ACWR se base sur la charge TRIMP, qui en a besoin.",
  'aucune-activite': 'Importe des activités pour voir apparaître ce graphique.',
  'historique-insuffisant': "Historique insuffisant (il faut au moins 28 jours d'activités enregistrées) pour calculer un ACWR fiable."
};

function afficherGraphiqueACWR() {
  const canvas = document.getElementById('chartACWR');
  const zoneMessage = document.getElementById('acwr-message');
  if (!canvas) return; // sécurité si jamais la page Accueil n'est pas encore dans le DOM

  const series = calculerSeriesACWR();

  if (series.statut !== 'ok') {
    canvas.style.display = 'none';
    if (zoneMessage) {
      zoneMessage.textContent = MESSAGES_ACWR[series.statut] || '';
      zoneMessage.style.display = 'block';
    }
    if (chartACWRInstance) { chartACWRInstance.destroy(); chartACWRInstance = null; }
    return;
  }

  canvas.style.display = 'block';
  if (zoneMessage) zoneMessage.style.display = 'none';

  const ctx = canvas.getContext('2d');
  if (chartACWRInstance) chartACWRInstance.destroy();

  chartACWRInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: series.labels,
      datasets: [
        {
          // Ligne pointillée basse de la zone recommandée
          label: 'Limite basse (0,8)',
          data: series.labels.map(() => 0.8),
          borderColor: 'rgba(150, 150, 150, 0.7)',
          borderDash: [5, 5],
          pointRadius: 0,
          fill: false
        },
        {
          // Ligne pointillée haute : le "fill: '-1'" remplit l'espace
          // jusqu'au dataset précédent (la limite basse), ce qui dessine la
          // bande grisée de la zone recommandée sans plugin supplémentaire.
          label: 'Limite haute (1,3)',
          data: series.labels.map(() => 1.3),
          borderColor: 'rgba(150, 150, 150, 0.7)',
          borderDash: [5, 5],
          pointRadius: 0,
          fill: '-1',
          backgroundColor: 'rgba(46, 139, 87, 0.12)'
        },
        {
          label: 'ACWR (charge 7 derniers jours / charge chronique 4 sem.)',
          data: series.acwr,
          borderColor: 'rgb(46, 139, 87)',
          backgroundColor: 'rgba(46, 139, 87, 0.15)',
          borderWidth: 2,
          pointRadius: 1,
          tension: 0.15,
          spanGaps: false
        }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, position: 'top' } },
      scales: {
        x: { title: { display: true, text: 'Date' }, ticks: { maxTicksLimit: 12 } },
        y: { title: { display: true, text: 'ACWR' }, suggestedMin: 0.3, suggestedMax: 2 }
      }
    }
  });
}

// ============================================================
// GRAPHIQUES D'ACTIVITÉ (Allure et FC) - VERSION AMÉLIORÉE V2
// ============================================================

let chartAllureInstance = null;
let chartFCInstance = null;
let modeAllureActuel = 'instantanee'; // 'instantanee', 'parKm' ou 'barreParKm'

// Calcule l'intervalle optimal pour les labels en fonction de la durée
function calculerIntervalleLabels(dureeSecondes) {
  const dureeMins = dureeSecondes / 60;
  
  if (dureeMins <= 30) return 5;      // < 30 min : tous les 5 min
  if (dureeMins <= 60) return 10;     // 30-60 min : tous les 10 min
  if (dureeMins <= 120) return 15;    // 1-2h : tous les 15 min
  if (dureeMins <= 180) return 20;    // 2-3h : tous les 20 min
  return 30;                           // > 3h : tous les 30 min
}

// ============================================================
// UTILITAIRES POUR LE CALCUL DE LA VAP
// ============================================================

// Distance Haversine : calcule la distance en 2D entre deux points GPS (en km)
function distanceHaversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // rayon terrestre en km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Calcule la pente (%) entre deux points
function calculerPente(alt1, alt2, distKm) {
  if (distKm <= 0) return 0;
  return ((alt2 - alt1) / (distKm * 1000)) * 100;
}

// Formule de Strava pour la VAP (Grade-Adjusted Pace)
// "facteur" représente le ratio (vitesse équivalente à plat) / (vitesse réelle) :
// en montée (g > 0), courir à une vitesse donnée coûte plus cher en énergie qu'à
// plat, donc l'équivalent "effort à plat" correspond à une vitesse PLUS ÉLEVÉE
// (facteur > 1) ; en descente modérée, c'est l'inverse (facteur < 1).
// Comme l'allure (min/km) est l'INVERSE d'une vitesse, on applique le facteur en
// DIVISANT l'allure (et non en la multipliant) : la VAP doit être plus rapide
// (valeur plus petite) en montée, plus lente (valeur plus grande) en descente.
function calculerVAP(allureMinParKm, pente) {
  // Formule quadratique de Strava
  const g = pente / 100; // pente en décimal
  const facteur = 1 + 2.896 * g + 15.14 * g * g;
  return allureMinParKm / facteur;
}

// Calcule la VAP MOYENNE sur l'ENSEMBLE de l'activité (par opposition à la
// VAP par km affichée dans le graphique en barres) : on parcourt les mêmes
// segments consécutifs que pour le graphique par km (mêmes filtres contre
// les segments aberrants — arrêt, saut GPS...), on calcule la VAP de chaque
// segment, et on en fait la moyenne pondérée par la distance de chaque
// segment (un segment de 200 m compte plus qu'un de 20 m). Renvoie null si
// l'activité n'a pas assez de données GPS/temps pour être calculée.
function calculerVAPMoyenneActivite(points) {
  const pointsAvecTemps = ajouterTempsEcoule(points);
  if (pointsAvecTemps.length < 2) return null;

  let distTotaleKm = 0;
  let vapPondereTotal = 0;

  for (let i = 1; i < pointsAvecTemps.length; i++) {
    const p1 = pointsAvecTemps[i - 1];
    const p2 = pointsAvecTemps[i];
    if (p1.distance === null || p2.distance === null) continue;

    const distM = p2.distance - p1.distance;
    const dureeMins = (p2.tempsEcouleSecondes - p1.tempsEcouleSecondes) / 60;
    if (distM <= 0 || dureeMins <= 0 || distM > 500) continue;

    const distKm = distM / 1000;
    const allureSegment = dureeMins / distKm;
    if (allureSegment < 2 || allureSegment > 20) continue;

    let pente = 0;
    if (p1.altitude !== null && p2.altitude !== null) {
      pente = calculerPente(p1.altitude, p2.altitude, distKm);
    }

    const vapSegment = calculerVAP(allureSegment, pente);
    distTotaleKm += distKm;
    vapPondereTotal += vapSegment * distKm;
  }

  return distTotaleKm > 0 ? vapPondereTotal / distTotaleKm : null;
}

// Affiche la courbe d'allure (instantanée, moyenne par km ou barre par km)
function afficherGraphiqueAllure(points, dureeSecondes) {
  const ctx = document.getElementById('chartAllure').getContext('2d');
  if (chartAllureInstance) chartAllureInstance.destroy();

  const pointsAvecTemps = ajouterTempsEcoule(points);
  if (pointsAvecTemps.length === 0) return;

  const intervalleMinutes = calculerIntervalleLabels(dureeSecondes);
  const dernierTemps = Math.max(dureeSecondes || 0, pointsAvecTemps[pointsAvecTemps.length - 1].tempsEcouleSecondes);
  const callbackTicksTemps = creerCallbackTicksTemps(intervalleMinutes);

  const optionsAxeTemps = {
    type: 'linear',
    min: 0,
    max: dernierTemps,
    afterBuildTicks: scale => {
      scale.ticks = creerTicksTemps(dernierTemps, intervalleMinutes);
    },
    ticks: { autoSkip: false, callback: callbackTicksTemps },
    title: { display: true, text: 'Temps écoulé' }
  };

  if (modeAllureActuel === 'barreParKm') {
    // --- Allure par km + VAP, en barres superposées ---
    // On accumule distance/durée par km (au lieu de filtrer les segments par
    // taille) : ça fonctionne quel que soit l'intervalle d'enregistrement du
    // GPS (1 point/seconde, "smart recording", etc.), au lieu d'exiger que
    // CHAQUE segment brut fasse entre 20 et 100 m.
    const segmentsParKm = new Map();

    for (let i = 1; i < pointsAvecTemps.length; i++) {
      const p1 = pointsAvecTemps[i - 1];
      const p2 = pointsAvecTemps[i];

      if (p2.distance === null || p1.distance === null) continue;

      const distM = p2.distance - p1.distance;
      const dureeMins = (p2.tempsEcouleSecondes - p1.tempsEcouleSecondes) / 60;

      // On ignore uniquement les segments clairement invalides : immobile /
      // recul (capteur qui "rembobine"), durée nulle, ou saut GPS aberrant
      // (> 500 m d'un point au suivant = erreur de mesure, pas une vraie foulée)
      if (distM <= 0 || dureeMins <= 0 || distM > 500) continue;

      const distKm = distM / 1000;
      const allureSegment = dureeMins / distKm;

      // Filtre les allures de segment aberrantes (arrêt, saut GPS...)
      if (allureSegment < 2 || allureSegment > 20) continue;

      // Calcul de la pente pour la VAP
      let pente = 0;
      if (p1.altitude !== null && p2.altitude !== null) {
        pente = calculerPente(p1.altitude, p2.altitude, distKm);
      }

      // Calcul de la VAP du segment
      const vapSegment = calculerVAP(allureSegment, pente);

      // Associe au kilomètre entier et accumule (pondéré par la distance)
      const numeroKm = Math.floor(p2.distance / 1000);

      if (!segmentsParKm.has(numeroKm)) {
        segmentsParKm.set(numeroKm, { distTotaleKm: 0, dureeTotaleMin: 0, vapPondereTotal: 0 });
      }
      const bin = segmentsParKm.get(numeroKm);
      bin.distTotaleKm += distKm;
      bin.dureeTotaleMin += dureeMins;
      bin.vapPondereTotal += vapSegment * distKm;
    }

    // Allure réelle du km = temps total / distance totale (plus juste qu'une
    // simple moyenne d'allures de segments) ; VAP = moyenne pondérée par la distance
    const donneesParKm = [...segmentsParKm.entries()]
      .sort(([a], [b]) => a - b)
      .map(([km, data]) => ({
        km,
        allure: data.dureeTotaleMin / data.distTotaleKm,
        vap: data.vapPondereTotal / data.distTotaleKm
      }));

    const maxAllure = Math.max(...donneesParKm.map(d => d.allure), 0);
    const maxVap = Math.max(...donneesParKm.map(d => d.vap), 0);
    const yMax = Math.max(maxAllure, maxVap) * 1.15;

    chartAllureInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: donneesParKm.map(d => `Km ${d.km}`),
        datasets: [
          {
            label: 'Allure (min/km)',
            data: donneesParKm.map(d => d.allure),
            backgroundColor: 'rgba(75, 192, 192, 0.6)',
            borderColor: 'rgb(75, 192, 192)',
            borderWidth: 1
          },
          {
            label: 'VAP (min/km)',
            data: donneesParKm.map(d => d.vap),
            backgroundColor: 'rgba(255, 99, 132, 0.5)',
            borderColor: 'rgb(255, 99, 132)',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: true, position: 'top' },
          tooltip: {
            callbacks: {
              label: ctx => {
                const label = ctx.dataset.label || '';
                return label + ' : ' + formaterAllureMinutes(ctx.raw) + ' min/km';
              }
            }
          }
        },
        scales: {
          y: {
            min: 0,
            max: yMax > 0 ? yMax : 1,
            ticks: { callback: v => formaterAllureMinutes(Number(v)) },
            title: { display: true, text: 'Allure (min/km)' }
          }
        }
      }
    });
    return;
  }

  // --- Allure instantanée, en courbe ---
  // On utilise une fenêtre glissante qui s'étend jusqu'à couvrir au moins
  // DIST_MIN_FENETRE_M mètres avant de calculer une allure. Avec un GPS qui
  // enregistre chaque seconde, la distance entre 2 points bruts consécutifs
  // (quelques mètres) était presque toujours sous l'ancien seuil de 10 m,
  // donc AUCUN point n'était jamais tracé. La fenêtre glissante résout ça
  // quel que soit l'intervalle d'enregistrement.
  const DIST_MIN_FENETRE_M = 15;
  const donneesInstantanees = [];
  let debutFenetre = 0;

  for (let i = 1; i < pointsAvecTemps.length; i++) {
    const p1 = pointsAvecTemps[debutFenetre];
    const p2 = pointsAvecTemps[i];
    if (p1.distance === null || p2.distance === null) continue;

    const distM = p2.distance - p1.distance;
    const dureeMins = (p2.tempsEcouleSecondes - p1.tempsEcouleSecondes) / 60;

    // Tant que la fenêtre n'a pas parcouru assez de distance, on continue
    // à l'étendre (en avançant i) avant de calculer une allure.
    if (distM < DIST_MIN_FENETRE_M || dureeMins <= 0) continue;

    const allure = dureeMins / (distM / 1000);

    if (allure >= 2 && allure < 20) {
      donneesInstantanees.push({ x: p2.tempsEcouleSecondes, y: allure });
    }

    debutFenetre = i; // on repart d'ici pour la fenêtre suivante
  }

  chartAllureInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Allure instantanée (min/km)',
        data: donneesInstantanees,
        parsing: false,
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.1)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        fill: true
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, position: 'top' } },
      scales: {
        x: optionsAxeTemps,
        y: { beginAtZero: false, title: { display: true, text: 'Allure (min/km)' } }
      }
    }
  });
}

// Affiche la courbe de FC au fil du parcours
function afficherGraphiqueFC(points, dureeSecondes) {
  const ctx = document.getElementById('chartFC').getContext('2d');
  if (chartFCInstance) chartFCInstance.destroy();

  const pointsAvecTemps = ajouterTempsEcoule(points);
  if (pointsAvecTemps.length === 0) return;

  const intervalleMinutes = calculerIntervalleLabels(dureeSecondes);
  const dernierTemps = Math.max(dureeSecondes || 0, pointsAvecTemps[pointsAvecTemps.length - 1].tempsEcouleSecondes);
  const callbackTicksTemps = creerCallbackTicksTemps(intervalleMinutes);

  const donneesFC = pointsAvecTemps
    .filter(p => p.fc !== null)
    .map(p => ({ x: p.tempsEcouleSecondes, y: p.fc }));

  chartFCInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'FC (bpm)',
        data: donneesFC,
        parsing: false,
        borderColor: 'rgb(255, 99, 132)',
        backgroundColor: 'rgba(255, 99, 132, 0.1)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        fill: true
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, position: 'top' } },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: dernierTemps,
          afterBuildTicks: scale => {
            scale.ticks = creerTicksTemps(dernierTemps, intervalleMinutes);
          },
          ticks: { autoSkip: false, callback: callbackTicksTemps },
          title: { display: true, text: 'Temps écoulé' }
        },
        y: {
          beginAtZero: false,
          min: 60,
          max: 200,
          title: { display: true, text: 'FC (bpm)' }
        }
      }
    }
  });
}

// Affiche l'altitude du parcours en fonction de la DISTANCE parcourue
// (contrairement aux graphiques d'allure/FC ci-dessus, qui sont en
// fonction du TEMPS). Utile pour repérer où se trouvent les montées et
// descentes sur le parcours, indépendamment du rythme auquel elles ont
// été parcourues (une pause en montée n'étire pas la bosse sur ce graphique).
let chartDeniveleInstance = null;

function afficherGraphiqueDenivele(points) {
  const ctx = document.getElementById('chartDenivele').getContext('2d');
  if (chartDeniveleInstance) chartDeniveleInstance.destroy();

  const donnees = points
    .filter(p => p.altitude !== null && p.distance !== null)
    .map(p => ({ x: p.distance / 1000, y: p.altitude }));

  chartDeniveleInstance = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: 'Altitude (m)',
        data: donnees,
        parsing: false,
        borderColor: 'rgb(46, 139, 87)',
        backgroundColor: 'rgba(46, 139, 87, 0.15)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        fill: true
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true, position: 'top' } },
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Distance (km)' } },
        y: { beginAtZero: false, title: { display: true, text: 'Altitude (m)' } }
      }
    }
  });
}

// Transforme une date ISO (ex: "2026-09-09T20:33:36.000Z")
// en format français lisible (ex: "09/09/2026 22:33")
function formatDate(dateISO) {
  const dateObj = new Date(dateISO);
  const jour = dateObj.getDate().toString().padStart(2, '0');
  const mois = (dateObj.getMonth() + 1).toString().padStart(2, '0'); // +1 car les mois commencent à 0
  const annee = dateObj.getFullYear();
  const heures = dateObj.getHours().toString().padStart(2, '0');
  const minutes = dateObj.getMinutes().toString().padStart(2, '0');
  return `${jour}/${mois}/${annee} ${heures}:${minutes}`;
}

// Même chose que formatDate() ci-dessus, mais SANS l'heure (ex: "10/09/2026"
// au lieu de "10/09/2026 00:00") : utilisé pour la date d'un record manuel,
// qui vient d'un simple <input type="date"> et n'a donc pas d'heure
// signifiante (contrairement à la date/heure d'une activité importée).
function formatDateSeule(dateISO) {
  const dateObj = new Date(dateISO);
  const jour = dateObj.getDate().toString().padStart(2, '0');
  const mois = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  const annee = dateObj.getFullYear();
  return `${jour}/${mois}/${annee}`;
}

// ============================================================
// ACTIVITÉS (Firestore)
// Chaque activité est un document séparé dans users/{uid}/activites/{id}
// (avant le passage au cloud, c'était dans IndexedDB, propre à un seul
// navigateur). Comme pour les réglages/VO2max plus haut, un écouteur
// onSnapshot tient `activitesEnMemoire` à jour en continu (chargement
// initial + tout changement, fait depuis CET appareil ou un autre) :
// sauvegarder/supprimer une activité se contente d'écrire dans Firestore,
// le tableau et les graphiques se redessinent tout seuls dès que l'écouteur
// reçoit la confirmation (quasi instantané, même pour une écriture faite
// depuis cet appareil, grâce au cache local de Firestore).
// ============================================================

// Écoute Firestore en continu sur la collection d'activités de l'utilisateur.
// Renvoie une fonction pour arrêter l'écoute (à la déconnexion).
function demarrerEcouteActivites(uid) {
  return db.collection('users').doc(uid).collection('activites')
    .onSnapshot(function (snapshot) {
      activitesEnMemoire = snapshot.docs.map(doc => doc.data());
      rafraichirAffichageActivites();
    }, function (erreur) {
      console.error('Erreur d\'écoute des activités :', erreur);
    });
}

// Pur affichage (aucune lecture de données ici) : reconstruit tout ce qui
// dépend de `activitesEnMemoire` — tableau trié, "dernière activité
// importée", aperçu semaine/mois, récap semaines et ACWR. Appelée par
// l'écouteur ci-dessus à chaque changement des activités, mais aussi par
// les écouteurs réglages/VO2max (plus haut) puisque ces réglages changent
// des valeurs AFFICHÉES (charge, zone) sans que la liste elle-même change.
function rafraichirAffichageActivites() {
  trierActivitesEnMemoire();
  dessinerTableauActivites();

  // Le bloc "Dernière activité importée" (onglet Activité) doit toujours
  // présenter la DERNIÈRE activité (par date), quel que soit le tri choisi
  // pour le tableau.
  if (activitesEnMemoire.length > 0) {
    const laPlusRecente = activitesEnMemoire.reduce((a, b) => (new Date(a.date) > new Date(b.date) ? a : b));
    afficherActivite(laPlusRecente);
  }

  afficherApercu();
  afficherRecapSemaines();
  afficherGraphiqueACWR();
  afficherRecordsAutomatiques();
  remplirSelectActiviteLiee();
  remplirSelectActiviteSourceSegment();
  // Les segments eux-mêmes (voir plus bas) ne sont PAS recalculés ici : trop
  // coûteux pour un rafraîchissement aussi fréquent (déclenché par le
  // moindre changement de réglages/VO2max, pas seulement les activités).
  // Recalculés seulement en arrivant sur l'onglet Records (afficherPage) ou
  // si on y est déjà au moment où les activités changent.
  if (document.getElementById('page-records') && document.getElementById('page-records').style.display === 'block') {
    afficherSegments();
  }
}

// --- Sauvegarde d'une activité dans Firestore ---
// Limite Firestore : 1 Mio par document. Le tableau `points` (souvent
// ~1 point/seconde) peut s'en approcher sur de très longues activités : on
// le sous-échantillonne avant écriture si besoin (en gardant un point sur N,
// répartis uniformément, plus systématiquement le tout dernier), pour rester
// large sous la limite sans perdre en pratique de précision visible sur les
// graphiques.
const NB_POINTS_MAX_FIRESTORE = 6000;

function allegerPourFirestore(activite) {
  const points = activite.points || [];
  if (points.length <= NB_POINTS_MAX_FIRESTORE) return activite;

  const pas = points.length / NB_POINTS_MAX_FIRESTORE;
  const pointsAllege = [];
  for (let i = 0; i < NB_POINTS_MAX_FIRESTORE; i++) {
    pointsAllege.push(points[Math.floor(i * pas)]);
  }
  const dernierPoint = points[points.length - 1];
  if (pointsAllege[pointsAllege.length - 1] !== dernierPoint) {
    pointsAllege.push(dernierPoint);
  }

  return { ...activite, points: pointsAllege };
}

function sauvegarderActivite(activite) {
  const activiteAEcrire = allegerPourFirestore(activite);
  // On RENVOIE la promesse (et on RE-LANCE l'erreur après l'avoir logguée,
  // avec `throw`) : ça permet à importerFichiersEnSequence() de détecter un
  // échec d'écriture (ex. règles de sécurité Firestore) et de prévenir
  // l'utilisateur au lieu d'afficher un message de succès trompeur alors
  // que l'activité n'a en réalité pas été enregistrée.
  return db.collection('users').doc(uidActuel).collection('activites').doc(activite.id).set(activiteAEcrire)
    .then(() => console.log('Activité sauvegardée avec succès :', activite.id))
    .catch(erreur => {
      console.error('Erreur de sauvegarde de l\'activité :', erreur);
      throw erreur;
    });
}

// ============================================================
// TRI DU TABLEAU D'ACTIVITÉS
// Chaque en-tête de colonne (voir index.html, attribut data-colonne) est
// cliquable : un premier clic trie par cette colonne (ordre décroissant par
// défaut), un second clic sur la MÊME colonne inverse l'ordre. Le tri
// s'applique directement sur `activitesEnMemoire` (pas besoin de relire
// IndexedDB juste pour changer l'ordre d'affichage).
// ============================================================

let triColonne = 'date';
let triOrdre = 'desc'; // 'asc' ou 'desc'

// Une fonction par colonne, qui extrait de l'activité la valeur à comparer.
// Les valeurs manquantes (FC, charge ou RPE non disponibles) sont ramenées à
// -Infinity : elles se retrouvent ainsi systématiquement en bas du classement
// en ordre décroissant (et en haut en ordre croissant), plutôt que de casser
// le tri ou d'apparaître à un endroit arbitraire.
const COMPARATEURS_TRI = {
  date: act => new Date(act.date).getTime(),
  nom: act => (act.nom || '').toLowerCase(),
  sport: act => (act.sport || '').toLowerCase(),
  distance: act => act.distanceMetres,
  duree: act => act.dureeSecondes,
  allure: act => act.allureMinParKm,
  fc: act => act.fcMoyenne ?? -Infinity,
  charge: act => { const c = calculerCharge(act); return c === null ? -Infinity : c; },
  rpe: act => act.rpe || -Infinity
};

// Trie `activitesEnMemoire` EN PLACE selon triColonne/triOrdre actuels.
function trierActivitesEnMemoire() {
  const extraire = COMPARATEURS_TRI[triColonne] || COMPARATEURS_TRI.date;
  activitesEnMemoire.sort((a, b) => {
    const va = extraire(a);
    const vb = extraire(b);
    if (va < vb) return triOrdre === 'asc' ? -1 : 1;
    if (va > vb) return triOrdre === 'asc' ? 1 : -1;
    return 0;
  });
}

// Met à jour les petites flèches ▲/▼ dans les en-têtes pour indiquer la
// colonne triée et le sens actuel.
function mettreAJourIndicateursTri() {
  document.querySelectorAll('#tableau-activites th[data-colonne]').forEach(th => {
    const fleche = th.querySelector('.fleche-tri');
    if (!fleche) return;
    fleche.textContent = (th.dataset.colonne === triColonne) ? (triOrdre === 'asc' ? '▲' : '▼') : '';
  });
}

// Reconstruit uniquement le <tbody> du tableau à partir de l'état ACTUEL de
// `activitesEnMemoire` (aucune requête IndexedDB ici) — utilisé après un
// tri, et après le chargement initial des données.
function dessinerTableauActivites() {
  const corpsTableauActivites = document.getElementById('corps-tableau-activites');
  corpsTableauActivites.innerHTML = '';

  activitesEnMemoire.forEach((act, index) => {
    const ligne = document.createElement('tr');
    ligne.style.cursor = 'pointer'; // curseur "main" au survol, pour indiquer que c'est cliquable
    const charge = calculerCharge(act);
    ligne.innerHTML = `
      <td>${formatDate(act.date)}</td>
      <td>${act.nom ? act.nom : '<span class="texte-attenue">Sans nom</span>'}</td>
      <td>${act.sport}</td>
      <td>${(act.distanceMetres / 1000).toFixed(2)} km</td>
      <td>${formatDuree(act.dureeSecondes)}</td>
      <td>${formatAllure(act.allureMinParKm)} /km</td>
      <td>${act.fcMoyenne ? act.fcMoyenne + ' bpm' : 'N/A'}</td>
      <td>${charge !== null ? charge : 'N/A'}</td>
      <td>${act.rpe ? act.rpe + '/10' : '--'}</td>
    `;
    // Au clic sur la ligne, on affiche le détail de CETTE activité (grâce à "index")
    ligne.addEventListener('click', () => afficherDetailActivite(index));
    corpsTableauActivites.appendChild(ligne);
  });

  mettreAJourIndicateursTri();
}

// Appelée au clic sur un en-tête de colonne.
function trierActivites(colonne) {
  if (triColonne === colonne) {
    triOrdre = triOrdre === 'asc' ? 'desc' : 'asc';
  } else {
    triColonne = colonne;
    triOrdre = 'desc';
  }

  // Les index utilisés par le panneau de détail (activiteEnCoursAffichage)
  // correspondent à l'ordre d'AVANT le tri : on ferme le détail éventuellement
  // ouvert plutôt que de risquer d'afficher la mauvaise activité après coup.
  document.getElementById('detail-activite').style.display = 'none';
  activiteEnCoursAffichage = null;

  trierActivitesEnMemoire();
  dessinerTableauActivites();
}

document.querySelectorAll('#tableau-activites th[data-colonne]').forEach(th => {
  th.addEventListener('click', () => trierActivites(th.dataset.colonne));
});

// Convertit une chaîne de temps ISO en millisecondes
function convertirTempsEnMillisecondes(temps) {
  const date = new Date(temps);
  return Number.isNaN(date.getTime()) ? NaN : date.getTime();
}

// Ajoute à chaque point le temps écoulé (en secondes) depuis le premier point
function ajouterTempsEcoule(points) {
  const tempsMs = points.map(p => convertirTempsEnMillisecondes(p.time));
  const premierTemps = tempsMs.find(Number.isFinite);
  if (!Number.isFinite(premierTemps)) return [];

  return points
    .map((p, i) => {
      const t = tempsMs[i];
      if (!Number.isFinite(t)) return null;
      return { ...p, tempsEcouleSecondes: Math.max(0, (t - premierTemps) / 1000) };
    })
    .filter(Boolean);
}

// Formate une allure décimale (ex: 6.51) en "6:31"
function formaterAllureMinutes(allureMinutes) {
  if (!Number.isFinite(allureMinutes) || allureMinutes < 0) return '';
  const minutes = Math.floor(allureMinutes);
  let secondes = Math.round((allureMinutes - minutes) * 60);
  if (secondes === 60) return `${minutes + 1}:00`;
  return `${minutes}:${String(secondes).padStart(2, '0')}`;
}

// Génère le callback des ticks de l'axe X (n'affiche que les multiples de l'intervalle)
function creerCallbackTicksTemps(intervalleMinutes) {
  const intervalleSecondes = intervalleMinutes * 60;
  return function (valeur) {
    const secondes = Math.round(Number(valeur));
    if (!Number.isFinite(secondes) || secondes < 0) return '';
    if (Math.abs(secondes % intervalleSecondes) > 0.5) return '';
    return `${Math.round(secondes / 60)} min`;
  };
}

// Force la présence des ticks aux multiples de l'intervalle
function creerTicksTemps(maxSecondes, intervalleMinutes) {
  const intervalleSecondes = intervalleMinutes * 60;
  const ticks = [];
  for (let s = 0; s <= maxSecondes; s += intervalleSecondes) {
    ticks.push({ value: s });
  }
  return ticks;
}

// ============================================================
// FONCTION : afficherTableauLaps
// Rôle : afficher, dans le détail d'une activité, le tableau des "tours"
// (un tour = un appui sur le bouton "tour" de la montre en cours de
// séance). Voir aussi parserTCX() : les stats globales de l'activité
// (durée, distance, calories, FC moyenne) sont désormais la SOMME/moyenne
// pondérée de tous les tours, pas seulement le premier.
// ============================================================
function afficherTableauLaps(activite) {
  const zone = document.getElementById('detail-laps-zone');
  const corps = document.getElementById('corps-tableau-laps');
  const laps = activite.laps || []; // tableau vide pour une activité sauvegardée avant cette fonctionnalité

  // On n'affiche le tableau que s'il y a VRAIMENT plusieurs tours : avec un
  // seul tour (aucun appui sur "tour" pendant la séance), il ne dirait rien
  // de plus que les stats globales déjà affichées juste au-dessus.
  if (laps.length <= 1) {
    zone.style.display = 'none';
    return;
  }

  corps.innerHTML = '';
  laps.forEach((lap, i) => {
    const ligne = document.createElement('tr');
    ligne.innerHTML = `
      <td>${i + 1}</td>
      <td>${(lap.distanceMetres / 1000).toFixed(2)} km</td>
      <td>${formatDuree(lap.dureeSecondes)}</td>
      <td>${lap.allureMinParKm !== null ? formatAllure(lap.allureMinParKm) + ' /km' : 'N/A'}</td>
      <td>${lap.fcMoyenne ? lap.fcMoyenne + ' bpm' : 'N/A'}</td>
    `;
    corps.appendChild(ligne);
  });
  zone.style.display = 'block';
}

// ============================================================
// FONCTION : afficherDetailActivite
// Rôle : afficher le détail complet d'une activité au clic
// ============================================================
function afficherDetailActivite(index) {
  const panneauDetail = document.getElementById('detail-activite');
  
  // Si le panneau est déjà affiché ET c'est la même activité, on le ferme
  if (panneauDetail.style.display === 'block' && activiteEnCoursAffichage === index) {
    panneauDetail.style.display = 'none';
    activiteEnCoursAffichage = null;
    return;
  }

  // Sinon, on affiche l'activité cliquée
  activiteEnCoursAffichage = index;
  const act = activitesEnMemoire[index];
  if (!act) return;

  panneauDetail.style.display = 'block';

  document.getElementById('detail-titre').textContent = act.nom
    ? `${act.nom} — ${formatDate(act.date)}`
    : `Détail de l'activité du ${formatDate(act.date)}`;
  document.getElementById('detail-nom-input').value = act.nom || '';
  document.getElementById('detail-date').textContent = formatDate(act.date);
  document.getElementById('detail-sport').textContent = act.sport;
  document.getElementById('detail-distance').textContent = (act.distanceMetres / 1000).toFixed(2) + ' km';
  document.getElementById('detail-duree').textContent = formatDuree(act.dureeSecondes);
  document.getElementById('detail-allure').textContent = formatAllure(act.allureMinParKm) + ' /km';
  const vapMoyenneDetail = calculerVAPMoyenneActivite(act.points);
  document.getElementById('detail-vap').textContent = vapMoyenneDetail !== null ? formatAllure(vapMoyenneDetail) + ' /km' : 'N/A';
  document.getElementById('detail-fc').textContent = act.fcMoyenne ? act.fcMoyenne + ' bpm' : 'N/A';
  document.getElementById('detail-denivele').textContent = act.deniveleDPlus + ' m';
  document.getElementById('detail-calories').textContent = act.calories + ' kcal';
  document.getElementById('detail-charge').textContent = formaterCharge(calculerCharge(act));
  document.getElementById('detail-zone').textContent = formaterZone(calculerZone(act.fcMoyenne));
  document.getElementById('detail-rpe-select').value = act.rpe ? String(act.rpe) : '';

  afficherTableauLaps(act);
  afficherCarte(act);
  afficherGraphiqueDenivele(act.points);
  afficherGraphiqueAllure(act.points, act.dureeSecondes);
  afficherGraphiqueFC(act.points, act.dureeSecondes);

  panneauDetail.scrollIntoView({ behavior: 'smooth' });
}

// ============================================================
// SUPPRESSION D'UNE ACTIVITÉ
// Action destructive et irréversible (pas de corbeille) : on demande
// confirmation avant d'agir. Le bouton vit dans le panneau de détail, donc
// on supprime toujours l'activité ACTUELLEMENT affichée (activiteEnCoursAffichage).
// ============================================================
function supprimerActivite(id) {
  document.getElementById('detail-activite').style.display = 'none';
  activiteEnCoursAffichage = null;
  db.collection('users').doc(uidActuel).collection('activites').doc(id).delete()
    .catch(erreur => console.error('Erreur de suppression de l\'activité :', erreur));
  // Pas besoin de rafraîchir explicitement ici : l'écouteur Firestore
  // (demarrerEcouteActivites) s'en charge dès que la suppression est confirmée.
}

document.getElementById('btn-supprimer-activite').addEventListener('click', function () {
  if (activiteEnCoursAffichage === null) return;
  const act = activitesEnMemoire[activiteEnCoursAffichage];
  if (!act) return;

  const confirmation = confirm(`Supprimer définitivement l'activité du ${formatDate(act.date)} ? Cette action est irréversible.`);
  if (!confirmation) return;

  supprimerActivite(act.id);
});

// ============================================================
// FONCTION : afficherCarte
// Rôle : dessiner le tracé GPS de l'activité sur une carte Leaflet
// ============================================================
let carteLeaflet = null; // on garde une référence pour pouvoir la détruire/recréer

function afficherCarte(activite) {
  // On filtre les points qui ont bien une position GPS valide
  const pointsGPS = activite.points.filter(p => p.lat != null && p.lon != null);

  if (pointsGPS.length === 0) {
    document.getElementById('carte').innerHTML = "Pas de données GPS pour cette activité.";
    return;
  }

  // Si une carte existait déjà (activité précédente affichée), on la détruit proprement
  if (carteLeaflet !== null) {
    carteLeaflet.remove();
  }

  // On crée la carte, centrée pour l'instant sur le premier point
  carteLeaflet = L.map('carte').setView([pointsGPS[0].lat, pointsGPS[0].lon], 14);

  // Fond de carte OpenStreetMap (gratuit)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(carteLeaflet);

  // On construit la liste des coordonnées [lat, lon] pour tracer la ligne
  const coordonnees = pointsGPS.map(p => [p.lat, p.lon]);

  // On dessine le tracé (une ligne reliant tous les points)
  const trace = L.polyline(coordonnees, { color: 'blue', weight: 4 }).addTo(carteLeaflet);

  // On ajoute un marqueur au départ (vert) et à l'arrivée (rouge)
  L.marker(coordonnees[0]).addTo(carteLeaflet).bindPopup("Départ");
  L.marker(coordonnees[coordonnees.length - 1]).addTo(carteLeaflet).bindPopup("Arrivée");

  // On ajuste automatiquement le zoom pour voir tout le tracé
  carteLeaflet.fitBounds(trace.getBounds());
}

// Écouter les changements du sélecteur d'allure
document.getElementById('selectAllure').addEventListener('change', function(e) {
  modeAllureActuel = e.target.value;
  // Récupérer l'activité actuellement affichée et redessiner le graphique
  if (activiteEnCoursAffichage !== null && activitesEnMemoire.length > activiteEnCoursAffichage) {
    const act = activitesEnMemoire[activiteEnCoursAffichage];
    if (act) {
      afficherGraphiqueAllure(act.points, act.dureeSecondes); // ✅ Passer aussi dureeSecondes
      afficherGraphiqueFC(act.points, act.dureeSecondes);
    }
  }
});

// ============================================================
// MIGRATION DES ANCIENNES DONNÉES LOCALES (IndexedDB / localStorage)
// Avant le passage à Firestore, toutes les données vivaient DANS CE
// NAVIGATEUR (IndexedDB pour les activités, localStorage pour
// réglages/VO2max) : le passage au compte en ligne ne les recopie pas tout
// seul. Ce bouton (page Paramètres > Migration) ouvre l'ancienne base
// locale et recopie tout ce qu'il y trouve vers Firestore, SANS RIEN
// SUPPRIMER ni modifier localement. Basé sur .set()/l'id de chaque
// activité (qui écrase plutôt que dupliquer), le relancer plusieurs fois
// par erreur ne pose pas de problème.
// ============================================================

function migrerDonneesLocales() {
  const zoneMessage = document.getElementById('migration-message');
  zoneMessage.style.display = 'block';
  zoneMessage.textContent = '⏳ Migration en cours...';

  // On rouvre l'ancienne base EXACTEMENT comme avant (même nom/version) :
  // si elle existe déjà sur cet appareil, on la retrouve telle quelle ; si
  // ce navigateur ne l'a jamais eue, elle est créée vide et il n'y aura
  // simplement rien à migrer.
  const ouverture = indexedDB.open('SuiviSportifDB', 1);

  ouverture.onupgradeneeded = function (event) {
    const ancienneBDD = event.target.result;
    if (!ancienneBDD.objectStoreNames.contains('activites')) {
      ancienneBDD.createObjectStore('activites', { keyPath: 'id' });
    }
  };

  ouverture.onerror = function () {
    zoneMessage.textContent = "❌ Impossible d'ouvrir l'ancienne base locale (voir la console).";
  };

  ouverture.onsuccess = function (event) {
    const ancienneBDD = event.target.result;

    if (!ancienneBDD.objectStoreNames.contains('activites')) {
      terminerMigrationLocale([], zoneMessage);
      return;
    }

    const transaction = ancienneBDD.transaction(['activites'], 'readonly');
    const requete = transaction.objectStore('activites').getAll();

    requete.onsuccess = function () {
      terminerMigrationLocale(requete.result || [], zoneMessage);
    };
    requete.onerror = function () {
      zoneMessage.textContent = '❌ Erreur de lecture des anciennes activités (voir la console).';
    };
  };
}

// Deuxième moitié de la migration : réglages/VO2max (localStorage) puis
// activités (IndexedDB, déjà lues à ce stade) vers Firestore.
function terminerMigrationLocale(anciennesActivites, zoneMessage) {
  // --- Réglages et VO2max, s'ils existent dans l'ancien localStorage ---
  // Note : la clé localStorage utilisée ci-dessous pour les réglages
  // ('suiviSportifReglages') suit la même convention que celle du VO2max
  // (CLE_LOCALSTORAGE_VO2MAX = 'suiviSportifVO2max', toujours utilisée plus
  // bas) et le nom de l'ancienne base ('SuiviSportifDB') : si jamais elle ne
  // correspond pas exactement à celle utilisée sur TON appareil avant la
  // migration vers Firestore, ce n'est pas grave — les ACTIVITÉS (le plus
  // important) migrent quand même, il suffira juste de ressaisir une fois
  // tes réglages FC/VO2max à la main dans l'onglet Paramètres.
  let reglagesMigres = false;
  let vo2maxMigres = false;

  try {
    const brutReglages = localStorage.getItem('suiviSportifReglages');
    if (brutReglages) {
      const anciensReglages = JSON.parse(brutReglages);
      enregistrerReglages({
        fcRepos: Number.isFinite(anciensReglages.fcRepos) ? anciensReglages.fcRepos : null,
        fcMax: Number.isFinite(anciensReglages.fcMax) ? anciensReglages.fcMax : null,
        courbeTrimp: anciensReglages.courbeTrimp === 'femme' ? 'femme' : 'homme'
      });
      reglagesMigres = true;
    }
  } catch (e) {
    console.error('Erreur de migration des réglages :', e);
  }

  try {
    const brutVO2max = localStorage.getItem(CLE_LOCALSTORAGE_VO2MAX);
    if (brutVO2max) {
      const anciennesDonneesVO2max = JSON.parse(brutVO2max);
      enregistrerDonneesVO2max({
        vo2max: Number.isFinite(anciennesDonneesVO2max.vo2max) ? anciennesDonneesVO2max.vo2max : null,
        dateTest: anciennesDonneesVO2max.dateTest || null,
        limites: Array.isArray(anciennesDonneesVO2max.limites) && anciennesDonneesVO2max.limites.length === 4
          ? anciennesDonneesVO2max.limites.map(l => (Number.isFinite(l) ? l : null))
          : [null, null, null, null]
      });
      vo2maxMigres = true;
    }
  } catch (e) {
    console.error('Erreur de migration du VO2max :', e);
  }

  // --- Activités : un .set() par activité, en parallèle ---
  const ecritures = anciennesActivites.map(act =>
    db.collection('users').doc(uidActuel).collection('activites').doc(act.id).set(allegerPourFirestore(act))
  );

  Promise.all(ecritures)
    .then(() => {
      if (anciennesActivites.length === 0 && !reglagesMigres && !vo2maxMigres) {
        zoneMessage.textContent = 'ℹ️ Aucune ancienne donnée locale trouvée sur cet appareil.';
        return;
      }
      const details = [`${anciennesActivites.length} activité(s)`];
      if (reglagesMigres) details.push('réglages FC');
      if (vo2maxMigres) details.push('données VO2max/zones');
      zoneMessage.textContent = `✅ Migration terminée : ${details.join(', ')} recopié(s) vers ton compte.`;
    })
    .catch(erreur => {
      console.error('Erreur de migration des activités :', erreur);
      zoneMessage.textContent = '❌ Erreur pendant la migration des activités (voir la console).';
    });
}

// ============================================================
// RECORDS PERSONNELS
// Deux volets, dans l'onglet "🏆 Records" :
//
// 1) Records AUTOMATIQUES : calculés à partir des activités déjà
//    importées, pour un jeu de distances standards (1 km, 5 km, 10 km,
//    semi, marathon), regroupés PAR SPORT (comparer un temps de course à
//    pied à un temps de vélo n'aurait pas de sens). Pour chaque distance,
//    on cherche la MEILLEURE portion (pas forcément l'activité entière) à
//    l'intérieur de chaque activité, via une fenêtre glissante sur la
//    distance cumulée des points GPS/capteur (voir meilleurTempsPourDistance
//    ci-dessous) — comme le fait Strava pour ses "records personnels".
//
// 2) Records MANUELS : saisis à la main, pour tout ce que le calcul
//    automatique ne peut pas trouver (record antérieur à cet outil,
//    distance non standard, etc.), avec un lien optionnel vers une
//    activité déjà importée. Stockés dans Firestore
//    (users/{uid}/records/{id}), exactement selon le même principe
//    cache-en-mémoire + écouteur Firestore que réglages/VO2max/activités
//    plus haut dans ce fichier.
// ============================================================

const DISTANCES_RECORDS = [
  { cle: '1km', metres: 1000, libelle: '1 km' },
  { cle: '5km', metres: 5000, libelle: '5 km' },
  { cle: '10km', metres: 10000, libelle: '10 km' },
  { cle: 'semi', metres: 21097, libelle: 'Semi-marathon (21,1 km)' },
  { cle: 'marathon', metres: 42195, libelle: 'Marathon (42,2 km)' }
];

// Formate une durée en secondes façon "temps de course" (ex: "42:18" ou
// "1:32:05"), plus adapté à un record que formatDuree() (qui écrit "1h
// 23min 45s" en toutes lettres, pensé pour la durée totale d'une activité).
function formatDureeRecord(secondes) {
  const total = Math.round(secondes);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Cherche, À L'INTÉRIEUR d'une seule activité, le temps le plus rapide pour
// couvrir EXACTEMENT `distanceCibleMetres`, n'importe où dans la trace (pas
// forcément depuis le tout début). Principe (fenêtre glissante à 2
// pointeurs, en s'appuyant sur le fait que la distance cumulée `p.distance`
// ne peut qu'augmenter au fil des points) :
//   - pour chaque point de départ i, on avance un pointeur j jusqu'à ce que
//     la distance parcourue depuis i atteigne la cible ;
//   - comme les points GPS sont espacés de plusieurs secondes, on interpole
//     LINÉAIREMENT entre les deux points qui encadrent le moment exact où la
//     distance cible est atteinte, pour un temps précis plutôt qu'arrondi au
//     point GPS le plus proche ;
//   - on garde le plus court de ces temps sur toute l'activité.
// Renvoie une durée en secondes (arrondie), ou null si l'activité ne
// contient pas assez de distance mesurée (pas de GPS/capteur de distance,
// ou activité plus courte que la distance cible).
function meilleurTempsPourDistance(activite, distanceCibleMetres) {
  const pointsBruts = (activite.points || []).filter(p => p.distance !== null && p.distance !== undefined && p.time);
  if (pointsBruts.length < 2) return null;

  const points = ajouterTempsEcoule(pointsBruts);
  if (points.length < 2) return null;

  const distanceTotale = points[points.length - 1].distance - points[0].distance;
  if (distanceTotale < distanceCibleMetres) return null;

  let meilleurDuree = null;
  let j = 0;

  for (let i = 0; i < points.length; i++) {
    if (j < i) j = i;
    while (j < points.length - 1 && points[j].distance - points[i].distance < distanceCibleMetres) {
      j++;
    }
    // Plus assez de distance restante depuis ce point de départ (et donc
    // depuis tous les suivants aussi) : inutile de continuer plus loin.
    if (points[j].distance - points[i].distance < distanceCibleMetres) break;

    let tempsFin;
    if (j === i) {
      tempsFin = points[j].tempsEcouleSecondes;
    } else {
      const pointAvant = points[j - 1];
      const pointApres = points[j];
      const distanceManquante = (points[i].distance + distanceCibleMetres) - pointAvant.distance;
      const distanceSegment = pointApres.distance - pointAvant.distance;
      const fraction = distanceSegment > 0 ? distanceManquante / distanceSegment : 0;
      tempsFin = pointAvant.tempsEcouleSecondes + fraction * (pointApres.tempsEcouleSecondes - pointAvant.tempsEcouleSecondes);
    }

    const duree = tempsFin - points[i].tempsEcouleSecondes;
    if (duree > 0 && (meilleurDuree === null || duree < meilleurDuree)) {
      meilleurDuree = duree;
    }
  }

  return meilleurDuree !== null ? Math.round(meilleurDuree) : null;
}

// Parcourt TOUTES les activités connues et calcule, pour chaque sport et
// chaque distance standard, le meilleur temps trouvé (et dans quelle
// activité). Renvoie une Map : sport -> Map(cle distance -> { distanceInfo,
// dureeSecondes, activite }).
function calculerRecordsAutomatiques() {
  const parSport = new Map();

  activitesEnMemoire.forEach(activite => {
    DISTANCES_RECORDS.forEach(distanceInfo => {
      const duree = meilleurTempsPourDistance(activite, distanceInfo.metres);
      if (duree === null) return;

      if (!parSport.has(activite.sport)) parSport.set(activite.sport, new Map());
      const recordsSport = parSport.get(activite.sport);
      const recordActuel = recordsSport.get(distanceInfo.cle);
      if (!recordActuel || duree < recordActuel.dureeSecondes) {
        recordsSport.set(distanceInfo.cle, { distanceInfo, dureeSecondes: duree, activite });
      }
    });
  });

  return parSport;
}

// Ouvre le détail d'une activité à partir de son ID (pas de sa position dans
// le tableau, qui dépend du tri actuel) : utilisé par les records
// (automatiques et manuels liés) pour renvoyer vers l'activité concernée,
// depuis l'onglet Records.
function ouvrirActiviteParId(id) {
  const index = activitesEnMemoire.findIndex(act => act.id === id);
  if (index === -1) return;

  afficherPage('activite');
  // On repart d'un panneau de détail fermé, pour être sûr que
  // afficherDetailActivite() (re)ouvre bien sur CETTE activité plutôt que de
  // le refermer (son comportement si l'activité demandée était déjà celle
  // affichée, voir plus haut).
  document.getElementById('detail-activite').style.display = 'none';
  activiteEnCoursAffichage = null;
  afficherDetailActivite(index);
}

// Reconstruit l'affichage des records automatiques (un petit tableau par
// sport). Appelée par rafraichirAffichageActivites() à chaque changement des
// activités.
function afficherRecordsAutomatiques() {
  const zone = document.getElementById('zone-records-auto');
  const message = document.getElementById('records-auto-message');
  if (!zone || !message) return; // sécurité si la page n'est pas encore chargée

  if (activitesEnMemoire.length === 0) {
    zone.innerHTML = '';
    message.style.display = 'block';
    return;
  }

  const parSport = calculerRecordsAutomatiques();

  if (parSport.size === 0) {
    zone.innerHTML = '';
    message.textContent = "Aucun record détecté pour l'instant : il faut au moins une activité couvrant entièrement une des distances standards (1 km, 5 km, 10 km, semi ou marathon).";
    message.style.display = 'block';
    return;
  }

  message.style.display = 'none';
  zone.innerHTML = '';

  [...parSport.keys()].sort().forEach(sport => {
    const recordsSport = parSport.get(sport);

    const bloc = document.createElement('div');
    bloc.className = 'records-bloc-sport';

    const titre = document.createElement('h3');
    titre.textContent = sport;
    bloc.appendChild(titre);

    const tableau = document.createElement('table');
    tableau.innerHTML = '<thead><tr><th>Distance</th><th>Meilleur temps</th><th>Allure</th><th>Date</th></tr></thead>';
    const corps = document.createElement('tbody');

    DISTANCES_RECORDS.forEach(distanceInfo => {
      const record = recordsSport.get(distanceInfo.cle);
      if (!record) return;

      const allureMinParKm = (record.dureeSecondes / 60) / (distanceInfo.metres / 1000);
      const ligne = document.createElement('tr');
      ligne.style.cursor = 'pointer';
      ligne.title = "Voir l'activité";
      ligne.innerHTML = `
        <td>${distanceInfo.libelle}</td>
        <td>${formatDureeRecord(record.dureeSecondes)}</td>
        <td>${formatAllure(allureMinParKm)} /km</td>
        <td>${formatDate(record.activite.date)}</td>
      `;
      ligne.addEventListener('click', () => ouvrirActiviteParId(record.activite.id));
      corps.appendChild(ligne);
    });

    tableau.appendChild(corps);
    // .tableau-scroll (voir style.css) : permet au tableau de défiler
    // horizontalement sur petit écran plutôt que d'écraser ses colonnes.
    const conteneurScroll = document.createElement('div');
    conteneurScroll.className = 'tableau-scroll';
    conteneurScroll.appendChild(tableau);
    bloc.appendChild(conteneurScroll);
    zone.appendChild(bloc);
  });
}

// --- Records manuels (Firestore : users/{uid}/records/{id}) ---

let recordsManuelsEnMemoire = [];

// Écoute Firestore en continu (voir demarrerEcouteReglages plus haut pour le
// même principe en détail). Renvoie une fonction pour arrêter l'écoute (à la
// déconnexion).
function demarrerEcouteRecords(uid) {
  return db.collection('users').doc(uid).collection('records')
    .onSnapshot(function (snapshot) {
      recordsManuelsEnMemoire = snapshot.docs.map(doc => doc.data());
      afficherRecordsManuels();
    }, function (erreur) {
      console.error('Erreur d\'écoute des records manuels :', erreur);
    });
}

// Remplit le menu déroulant "Activité liée" du formulaire de saisie, la plus
// récente en premier (pratique : le record qu'on vient de saisir correspond
// souvent à l'activité qu'on vient d'importer). Appelée à chaque changement
// des activités, pour rester à jour.
function remplirSelectActiviteLiee() {
  const select = document.getElementById('record-activite-liee');
  if (!select) return;

  const valeurActuelle = select.value;
  const activitesTriees = [...activitesEnMemoire].sort((a, b) => new Date(b.date) - new Date(a.date));

  select.innerHTML = '<option value="">(aucune)</option>' +
    activitesTriees.map(act =>
      `<option value="${act.id}">${formatDate(act.date)} — ${act.sport} (${(act.distanceMetres / 1000).toFixed(2)} km)</option>`
    ).join('');

  // On essaie de garder la sélection précédente si elle existe toujours.
  if ([...select.options].some(o => o.value === valeurActuelle)) {
    select.value = valeurActuelle;
  }
}

// Reconstruit le tableau des records manuels (le plus récent en premier),
// avec un lien vers l'activité liée (si renseignée) et un bouton de
// suppression par ligne.
function afficherRecordsManuels() {
  const corps = document.getElementById('corps-tableau-records-manuels');
  if (!corps) return;

  corps.innerHTML = '';
  const recordsTries = [...recordsManuelsEnMemoire].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  recordsTries.forEach(record => {
    const activiteLiee = record.activiteId ? activitesEnMemoire.find(a => a.id === record.activiteId) : null;

    const ligne = document.createElement('tr');
    ligne.innerHTML = `
      <td>${record.nom}</td>
      <td>${record.valeur}</td>
      <td>${record.date ? formatDateSeule(record.date) : '--'}</td>
      <td>${activiteLiee ? `<a href="#" class="lien-activite-liee">Voir l'activité</a>` : '--'}</td>
      <td><button type="button" class="bouton-supprimer-record" title="Supprimer ce record">🗑️</button></td>
    `;
    if (activiteLiee) {
      ligne.querySelector('.lien-activite-liee').addEventListener('click', function (e) {
        e.preventDefault();
        ouvrirActiviteParId(activiteLiee.id);
      });
    }
    ligne.querySelector('.bouton-supprimer-record').addEventListener('click', () => supprimerRecordManuel(record.id));
    corps.appendChild(ligne);
  });
}

function supprimerRecordManuel(id) {
  db.collection('users').doc(uidActuel).collection('records').doc(id).delete()
    .catch(erreur => console.error('Erreur de suppression du record :', erreur));
  // Pas besoin de rafraîchir explicitement : l'écouteur Firestore
  // (demarrerEcouteRecords) s'en charge dès que la suppression est confirmée.
}

document.getElementById('btn-ajouter-record').addEventListener('click', function () {
  const nom = document.getElementById('record-nom').value.trim();
  const valeur = document.getElementById('record-valeur').value.trim();
  const date = document.getElementById('record-date').value || null;
  const activiteId = document.getElementById('record-activite-liee').value || null;
  const message = document.getElementById('records-manuels-message');

  if (!nom || !valeur) {
    message.textContent = '❌ Le nom et la valeur du record sont obligatoires.';
    message.style.display = 'block';
    return;
  }

  // Id généré côté client (plutôt qu'un id Firestore auto) : cohérent avec
  // le reste de l'app, et pratique pour cibler ce document précis (ex.
  // suppression) sans avoir à le relire d'abord.
  const id = 'record-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  db.collection('users').doc(uidActuel).collection('records').doc(id)
    .set({ id, nom, valeur, date, activiteId })
    .then(() => {
      message.textContent = '✅ Record ajouté.';
      message.style.display = 'block';
      setTimeout(() => { message.style.display = 'none'; }, 3000);
      document.getElementById('record-nom').value = '';
      document.getElementById('record-valeur').value = '';
      document.getElementById('record-date').value = '';
    })
    .catch(erreur => {
      console.error('Erreur d\'enregistrement du record :', erreur);
      message.textContent = `❌ Échec de l'enregistrement (${erreur.code || erreur.message || 'erreur inconnue'}). Vérifie ta connexion et les règles de sécurité Firestore (voir firebase-config.js).`;
      message.style.display = 'block';
    });
});

document.getElementById('btn-migrer-donnees').addEventListener('click', migrerDonneesLocales);

// ============================================================
// SEGMENTS (façon Strava)
// Un segment est une portion de parcours DÉFINIE PAR L'UTILISATEUR (deux
// curseurs sur le tracé GPS d'une activité déjà importée), qu'on cherche
// ensuite à repérer dans TOUTES les activités du même sport — passées
// (recherche rétroactive dans l'historique) et futures (recalculé à chaque
// nouvel import). Stocké dans Firestore (users/{uid}/segments/{id}) :
//   { id, nom, sport, distanceMetres, activiteSourceId, pointsReference }
// `pointsReference` est le tracé de référence du segment (juste {lat, lon}
// par point, ré-échantillonné à ~15 m d'écart — voir sousEchantillonnerRef
// plus bas), extrait de l'activité source au moment de la création.
//
// IMPORTANT — ce que la détection fait et ne fait PAS :
// Ce n'est PAS un vrai algorithme de "map-matching" (sujet de recherche à
// part entière) : c'est une heuristique simple mais raisonnablement fiable
// pour un usage perso, à tolérance fixe (TOLERANCE_SEGMENT_METRES) : pour
// chaque point d'une activité candidate, on cherche le point de RÉFÉRENCE
// le plus proche ; tant que cette distance reste sous la tolérance ET que
// l'indice du point de référence le plus proche ne recule pas (au-delà
// d'une petite marge, pour absorber le bruit GPS) au fil du temps, on
// considère qu'on suit le segment DANS LE BON SENS (exigé par l'utilisateur
// — un passage dans l'autre sens n'est jamais compté). Un passage complet
// (du début à la fin du tracé de référence) donne un "effort" avec sa durée.
// Limites connues : peut rater un passage si le signal GPS dérive plus que
// la tolérance sur une portion (ex. sous couvert forestier dense, tunnel),
// ou détecter à tort un passage sur un tracé très proche géométriquement
// mais différent (ex. deux allers-retours parallèles sur un même chemin
// large). Suffisant pour un usage perso raisonnable ; à ne pas traiter
// comme une mesure de précision sportive officielle.
// ============================================================

const TOLERANCE_SEGMENT_METRES = 40; // rayon de tolérance GPS pour "être sur" le tracé de référence
const DISTANCE_MIN_SEGMENT_METRES = 50; // en dessous, la marge d'erreur GPS dépasserait la longueur du segment lui-même

// Ré-échantillonne une liste de points {lat, lon, distance} pour ne garder
// qu'un point tous les `espacementCibleMetres` environ (toujours le premier
// et le dernier) : évite de stocker un point de référence par seconde
// (inutile pour la détection, qui tolère 40 m d'écart) tout en gardant les
// points de référence assez rapprochés pour qu'un simple "point de
// référence le plus proche" (voir plus haut) approxime correctement la
// distance au TRACÉ (pas juste à un point isolé).
function sousEchantillonnerRef(points, espacementCibleMetres) {
  if (points.length === 0) return [];
  const resultat = [points[0]];
  let distanceDepuisDernierGarde = points[0].distance;

  for (let i = 1; i < points.length; i++) {
    if (points[i].distance - distanceDepuisDernierGarde >= espacementCibleMetres) {
      resultat.push(points[i]);
      distanceDepuisDernierGarde = points[i].distance;
    }
  }
  const dernier = points[points.length - 1];
  if (resultat[resultat.length - 1] !== dernier) resultat.push(dernier);

  return resultat;
}

// --- Définition d'un nouveau segment (formulaire + carte + curseurs) ---

let segmentActiviteSourceCourante = null; // activité actuellement choisie comme source
let segmentPointsGPSCourants = [];        // ses points GPS valides (lat/lon/distance), triés par temps
let carteLeafletSegment = null;           // référence à la mini-carte de définition (détruite/recréée à chaque activité choisie)
let traceSegmentSurbrillance = null;      // la polyline rouge (portion sélectionnée), redessinée à chaque déplacement des curseurs

// Remplit le menu déroulant "Activité source" avec les activités qui ONT un
// tracé GPS exploitable (au moins 2 points avec lat/lon), la plus récente en
// premier. Une activité sans GPS (ex. tapis de course sans capteur externe)
// ne peut pas servir à définir un segment.
function remplirSelectActiviteSourceSegment() {
  const select = document.getElementById('segment-activite-source');
  if (!select) return;

  const valeurActuelle = select.value;
  const activitesAvecGPS = activitesEnMemoire
    .filter(act => (act.points || []).filter(p => p.lat != null && p.lon != null).length >= 2)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  select.innerHTML = '<option value="">-- choisir une activité --</option>' +
    activitesAvecGPS.map(act =>
      `<option value="${act.id}">${formatDate(act.date)} — ${act.sport} (${(act.distanceMetres / 1000).toFixed(2)} km)</option>`
    ).join('');

  if ([...select.options].some(o => o.value === valeurActuelle)) {
    select.value = valeurActuelle;
  }
}

document.getElementById('segment-activite-source').addEventListener('change', function () {
  const zone = document.getElementById('segment-definition-zone');
  const activite = activitesEnMemoire.find(a => a.id === this.value);

  if (!activite) {
    segmentActiviteSourceCourante = null;
    segmentPointsGPSCourants = [];
    zone.style.display = 'none';
    return;
  }

  segmentActiviteSourceCourante = activite;
  // On ne garde que les points GPS valides ET avec une distance connue
  // (nécessaire pour calculer la distance du segment sélectionné), triés
  // par ordre chronologique (normalement déjà le cas dans `points`).
  segmentPointsGPSCourants = (activite.points || [])
    .filter(p => p.lat != null && p.lon != null && p.distance != null && p.time != null)
    .slice()
    .sort((a, b) => new Date(a.time) - new Date(b.time));

  const sliderDebut = document.getElementById('segment-slider-debut');
  const sliderFin = document.getElementById('segment-slider-fin');
  const dernierIndex = Math.max(1, segmentPointsGPSCourants.length - 1);
  sliderDebut.min = 0;
  sliderDebut.max = dernierIndex;
  sliderDebut.value = 0;
  sliderFin.min = 0;
  sliderFin.max = dernierIndex;
  sliderFin.value = dernierIndex;

  zone.style.display = 'block';
  dessinerApercuSegment();
});

// Redessine la mini-carte (tracé complet en bleu, portion sélectionnée par
// les curseurs en rouge par-dessus) et met à jour la distance affichée.
// Appelée à chaque déplacement d'un des deux curseurs.
function dessinerApercuSegment() {
  if (segmentPointsGPSCourants.length < 2) return;

  const sliderDebut = document.getElementById('segment-slider-debut');
  const sliderFin = document.getElementById('segment-slider-fin');
  let debut = parseInt(sliderDebut.value);
  let fin = parseInt(sliderFin.value);

  // La fin doit toujours être après le début (au moins 1 point d'écart) :
  // si l'utilisateur croise les deux curseurs, on repousse l'autre plutôt
  // que d'accepter un segment de longueur négative ou nulle.
  if (fin <= debut) {
    fin = Math.min(segmentPointsGPSCourants.length - 1, debut + 1);
    sliderFin.value = fin;
  }

  const tousLesPoints = segmentPointsGPSCourants.map(p => [p.lat, p.lon]);
  const pointsSelectionnes = segmentPointsGPSCourants.slice(debut, fin + 1);
  const coordsSelectionnees = pointsSelectionnes.map(p => [p.lat, p.lon]);

  if (carteLeafletSegment !== null) {
    carteLeafletSegment.remove();
  }
  carteLeafletSegment = L.map('carte-segment').setView(tousLesPoints[0], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(carteLeafletSegment);
  L.polyline(tousLesPoints, { color: 'blue', weight: 3, opacity: 0.6 }).addTo(carteLeafletSegment);
  traceSegmentSurbrillance = L.polyline(coordsSelectionnees, { color: 'red', weight: 5 }).addTo(carteLeafletSegment);
  carteLeafletSegment.fitBounds(traceSegmentSurbrillance.getBounds(), { padding: [20, 20] });

  const distanceMetres = pointsSelectionnes[pointsSelectionnes.length - 1].distance - pointsSelectionnes[0].distance;
  document.getElementById('segment-distance-apercu').textContent = (distanceMetres / 1000).toFixed(2) + ' km';
}

document.getElementById('segment-slider-debut').addEventListener('input', dessinerApercuSegment);
document.getElementById('segment-slider-fin').addEventListener('input', dessinerApercuSegment);

document.getElementById('btn-creer-segment').addEventListener('click', function () {
  const nom = document.getElementById('segment-nom').value.trim();
  const message = document.getElementById('segment-definition-message');

  if (!nom) {
    message.textContent = '❌ Le nom du segment est obligatoire.';
    message.style.display = 'block';
    return;
  }
  if (!segmentActiviteSourceCourante || segmentPointsGPSCourants.length < 2) {
    message.textContent = '❌ Choisis une activité source avec un tracé GPS.';
    message.style.display = 'block';
    return;
  }

  const sliderDebut = document.getElementById('segment-slider-debut');
  const sliderFin = document.getElementById('segment-slider-fin');
  const debut = parseInt(sliderDebut.value);
  const fin = parseInt(sliderFin.value);
  if (fin <= debut) {
    message.textContent = '❌ La fin du segment doit être après le début.';
    message.style.display = 'block';
    return;
  }

  const pointsSelectionnes = segmentPointsGPSCourants.slice(debut, fin + 1);
  const distanceMetres = pointsSelectionnes[pointsSelectionnes.length - 1].distance - pointsSelectionnes[0].distance;
  if (distanceMetres < DISTANCE_MIN_SEGMENT_METRES) {
    message.textContent = `❌ Segment trop court (minimum ${DISTANCE_MIN_SEGMENT_METRES} m) : la marge d'erreur GPS le rendrait impossible à détecter fiablement.`;
    message.style.display = 'block';
    return;
  }

  const pointsReference = sousEchantillonnerRef(pointsSelectionnes, 15).map(p => ({ lat: p.lat, lon: p.lon }));
  const id = 'segment-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  db.collection('users').doc(uidActuel).collection('segments').doc(id).set({
    id,
    nom,
    sport: segmentActiviteSourceCourante.sport,
    distanceMetres: Math.round(distanceMetres),
    activiteSourceId: segmentActiviteSourceCourante.id,
    pointsReference
  })
    .then(() => {
      message.textContent = '✅ Segment créé. Recherche des passages en cours...';
      message.style.display = 'block';
      setTimeout(() => { message.style.display = 'none'; }, 4000);
      document.getElementById('segment-nom').value = '';
      document.getElementById('segment-nouveau').open = false;
    })
    .catch(erreur => {
      console.error('Erreur de création du segment :', erreur);
      message.textContent = `❌ Échec de la création (${erreur.code || erreur.message || 'erreur inconnue'}). Vérifie ta connexion et les règles de sécurité Firestore (voir firebase-config.js).`;
      message.style.display = 'block';
    });
});

// --- Détection des passages (efforts) sur un segment ---

// Cherche, dans UNE activité, tous les passages complets sur `segment`, dans
// le MÊME SENS que sa définition (voir l'explication détaillée en tête de
// cette section). Renvoie un tableau d'efforts { dureeSecondes, activite }
// (généralement 0 ou 1, mais peut en contenir plusieurs si l'activité
// repasse plusieurs fois par le même tracé, ex. plusieurs tours).
function detecterEffortsSurSegment(segment, activite) {
  if (activite.sport !== segment.sport) return [];

  const ref = segment.pointsReference;
  if (!ref || ref.length < 2) return [];

  const pointsGPS = (activite.points || []).filter(p => p.lat != null && p.lon != null && p.time != null);
  if (pointsGPS.length < 2) return [];
  const points = ajouterTempsEcoule(pointsGPS);
  if (points.length < 2) return [];

  // Marges (en nombre de points de référence) pour considérer qu'on est
  // "au tout début" / "à la toute fin" du tracé de référence, et pour
  // tolérer un léger recul (dérive GPS, virage serré) sans le traiter comme
  // un vrai rebroussement (mauvais sens).
  const margeExtremites = Math.max(2, Math.round(ref.length * 0.05));
  const margeRecul = Math.max(2, Math.round(ref.length * 0.03));

  const efforts = [];
  let enCours = false;
  let indexEntree = null;
  let meilleurIndexRefAtteint = 0;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];

    // Point de référence le plus proche de ce point de l'activité (simple
    // recherche linéaire : `ref` reste de taille modeste, voir
    // sousEchantillonnerRef).
    let meilleurIndexRef = -1;
    let meilleureDistanceM = Infinity;
    for (let r = 0; r < ref.length; r++) {
      const d = distanceHaversine(point.lat, point.lon, ref[r].lat, ref[r].lon) * 1000;
      if (d < meilleureDistanceM) {
        meilleureDistanceM = d;
        meilleurIndexRef = r;
      }
    }

    const surLeTrace = meilleureDistanceM <= TOLERANCE_SEGMENT_METRES;

    if (!enCours) {
      // On cherche un DÉPART : proche du tracé ET proche du DÉBUT du segment
      // de référence (pas n'importe où dessus).
      if (surLeTrace && meilleurIndexRef <= margeExtremites) {
        enCours = true;
        indexEntree = i;
        meilleurIndexRefAtteint = meilleurIndexRef;
      }
      continue;
    }

    if (!surLeTrace) {
      // Trop loin du tracé de référence : on abandonne cette tentative
      // (pas d'effort partiel comptabilisé).
      enCours = false;
      indexEntree = null;
      continue;
    }

    if (meilleurIndexRef < meilleurIndexRefAtteint - margeRecul) {
      // Recul net le long du tracé de référence : mauvais sens (ou fausse
      // piste croisant le segment) — on abandonne cette tentative.
      enCours = false;
      indexEntree = null;
      continue;
    }
    meilleurIndexRefAtteint = Math.max(meilleurIndexRefAtteint, meilleurIndexRef);

    if (meilleurIndexRef >= ref.length - 1 - margeExtremites) {
      // Arrivé près de la FIN du tracé de référence : passage complet.
      const duree = point.tempsEcouleSecondes - points[indexEntree].tempsEcouleSecondes;
      if (duree > 0) {
        efforts.push({ dureeSecondes: Math.round(duree), activite });
      }
      enCours = false;
      indexEntree = null;
      meilleurIndexRefAtteint = 0;
    }
  }

  return efforts;
}

// Rassemble les efforts détectés sur `segment` à travers TOUTES les
// activités connues (donc y compris celles importées avant la création du
// segment : détection rétroactive demandée par l'utilisateur), triés du
// plus rapide au plus lent.
function calculerEffortsSegment(segment) {
  const tousLesEfforts = [];
  activitesEnMemoire.forEach(activite => {
    detecterEffortsSurSegment(segment, activite).forEach(effort => tousLesEfforts.push(effort));
  });
  tousLesEfforts.sort((a, b) => a.dureeSecondes - b.dureeSecondes);
  return tousLesEfforts;
}

// --- Firestore : liste des segments + affichage ---

let segmentsEnMemoire = [];

// Écoute Firestore en continu (voir demarrerEcouteReglages plus haut pour le
// même principe en détail). Renvoie une fonction pour arrêter l'écoute (à la
// déconnexion).
function demarrerEcouteSegments(uid) {
  return db.collection('users').doc(uid).collection('segments')
    .onSnapshot(function (snapshot) {
      segmentsEnMemoire = snapshot.docs.map(doc => doc.data());
      // Un segment vient peut-être d'être créé/supprimé : on ne recalcule
      // les efforts (coûteux) que si on est effectivement en train de
      // regarder l'onglet Records.
      if (document.getElementById('page-records') && document.getElementById('page-records').style.display === 'block') {
        afficherSegments();
      }
    }, function (erreur) {
      console.error('Erreur d\'écoute des segments :', erreur);
    });
}

function supprimerSegment(id) {
  db.collection('users').doc(uidActuel).collection('segments').doc(id).delete()
    .catch(erreur => console.error('Erreur de suppression du segment :', erreur));
  // Pas besoin de rafraîchir explicitement : l'écouteur Firestore
  // (demarrerEcouteSegments) s'en charge dès que la suppression est confirmée.
}

// Reconstruit l'affichage complet des segments (un bloc par segment, avec
// son tableau d'efforts triés du plus rapide au plus lent, le record mis en
// avant). Volontairement PAS appelée automatiquement à chaque changement
// d'activité (voir rafraichirAffichageActivites) : recalculer les efforts de
// TOUS les segments contre TOUTES les activités est plus coûteux que le
// reste de cette page, donc seulement déclenché en arrivant sur l'onglet
// Records (afficherPage) ou si on y est déjà.
function afficherSegments() {
  const zone = document.getElementById('zone-segments');
  const message = document.getElementById('segments-message');
  if (!zone || !message) return;

  if (segmentsEnMemoire.length === 0) {
    zone.innerHTML = '';
    message.style.display = 'block';
    return;
  }
  message.style.display = 'none';
  zone.innerHTML = '';

  segmentsEnMemoire.forEach(segment => {
    const efforts = calculerEffortsSegment(segment);

    const bloc = document.createElement('div');
    bloc.className = 'segment-bloc';

    const entete = document.createElement('div');
    entete.className = 'segment-entete';
    entete.innerHTML = `
      <div>
        <h3>${segment.nom}</h3>
        <p class="description">${segment.sport} — ${(segment.distanceMetres / 1000).toFixed(2)} km — ${efforts.length > 0 ? efforts.length + ' passage(s) détecté(s)' : 'aucun passage détecté pour l\'instant'}</p>
      </div>
      <button type="button" class="bouton-danger bouton-supprimer-segment" title="Supprimer ce segment">🗑️</button>
    `;
    entete.querySelector('.bouton-supprimer-segment').addEventListener('click', () => supprimerSegment(segment.id));
    bloc.appendChild(entete);

    if (efforts.length > 0) {
      const tableau = document.createElement('table');
      tableau.innerHTML = '<thead><tr><th>Temps</th><th>Allure</th><th>Date</th><th>Sport</th></tr></thead>';
      const corps = document.createElement('tbody');

      efforts.forEach((effort, index) => {
        const allureMinParKm = (effort.dureeSecondes / 60) / (segment.distanceMetres / 1000);
        const ligne = document.createElement('tr');
        if (index === 0) ligne.classList.add('segment-record');
        ligne.style.cursor = 'pointer';
        ligne.title = "Voir l'activité";
        ligne.innerHTML = `
          <td>${index === 0 ? '🏆 ' : ''}${formatDureeRecord(effort.dureeSecondes)}</td>
          <td>${formatAllure(allureMinParKm)} /km</td>
          <td>${formatDate(effort.activite.date)}</td>
          <td>${effort.activite.sport}</td>
        `;
        ligne.addEventListener('click', () => ouvrirActiviteParId(effort.activite.id));
        corps.appendChild(ligne);
      });

      tableau.appendChild(corps);
      // .tableau-scroll (voir style.css) : permet au tableau de défiler
      // horizontalement sur petit écran plutôt que d'écraser ses colonnes.
      const conteneurScroll = document.createElement('div');
      conteneurScroll.className = 'tableau-scroll';
      conteneurScroll.appendChild(tableau);
      bloc.appendChild(conteneurScroll);
    }

    zone.appendChild(bloc);
  });
}
