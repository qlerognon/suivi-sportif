// ============================================================
// CONFIGURATION FIREBASE — À REMPLIR AVEC TES PROPRES VALEURS
// ============================================================
//
// Ce fichier est volontairement séparé de script.js : c'est le SEUL fichier
// à modifier pour connecter l'app à TON projet Firebase (les valeurs
// changent d'un déploiement à l'autre, contrairement au reste du code).
//
// ⚠️ Ces valeurs ne sont PAS des secrets à cacher : Firebase le confirme
// explicitement dans sa documentation (firebase.google.com/docs/projects/api-keys) —
// il est normal et sans risque qu'elles apparaissent dans le code source
// public (y compris sur un dépôt GitHub public). La sécurité réelle de tes
// données est assurée par les RÈGLES DE SÉCURITÉ FIRESTORE (voir plus bas),
// pas par le secret de ces valeurs.
//
// COMMENT OBTENIR CES VALEURS (à faire une seule fois) :
//
// 1) Va sur https://console.firebase.google.com et crée un nouveau projet
//    (gratuit). Donne-lui le nom que tu veux, ex. "suivi-sportif".
//
// 2) Dans ce projet, clique sur l'icône "</>" (Web) pour ajouter une
//    application web. Donne-lui un nom (ex. "suivi-sportif-web"), PAS
//    besoin de cocher "Firebase Hosting" (on utilise GitHub Pages).
//    Firebase t'affiche alors un objet `firebaseConfig` : copie-colle ses
//    valeurs ci-dessous, à la place des "À_REMPLIR".
//
// 3) Dans le menu de gauche, va dans "Build" > "Firestore Database" >
//    "Créer une base de données". Choisis une région proche de toi, et
//    démarre en "mode production" (les règles ci-dessous s'en chargeront).
//
// 4) Toujours dans "Build", va dans "Authentication" > "Get started" >
//    onglet "Sign-in method" > active le fournisseur "E-mail/Mot de passe".
//
// 5) Toujours dans "Authentication", onglet "Users" > "Add user" : crée TON
//    propre compte (ton email + un mot de passe). C'est le seul compte qui
//    doit exister — l'app n'a volontairement PAS d'écran d'inscription.
//
// 6) Note le "User UID" de ce compte (affiché dans la liste des
//    utilisateurs) : il te servira dans les règles de sécurité ci-dessous.
//
// 7) Dans Firestore Database > onglet "Règles", colle EXACTEMENT ceci (en
//    remplaçant TON_UID_ICI par l'UID noté à l'étape 6), puis "Publier" :
//
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /users/{userId}/{document=**} {
//         allow read, write: if request.auth != null
//                             && request.auth.uid == userId
//                             && request.auth.uid == "TON_UID_ICI";
//       }
//     }
//   }
//
//   Cette règle est volontairement stricte : même si quelqu'un d'autre
//   créait un compte sur ton projet (l'app n'a pas d'écran d'inscription,
//   mais Firebase Auth reste techniquement joignable), il ne pourrait ni
//   lire ni écrire quoi que ce soit — seul TON UID précis y est autorisé.
//
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyCitCGgspd75AGFMNda6XtxH0piOQ-jBNw",
  authDomain: "suivi-sportif-e3c10.firebaseapp.com",
  projectId: "suivi-sportif-e3c10",
  storageBucket: "suivi-sportif-e3c10.firebasestorage.app",
  messagingSenderId: "1065828141418",
  appId: "1:1065828141418:web:d5bd1cf548a006266ebd13"
};

firebase.initializeApp(firebaseConfig);