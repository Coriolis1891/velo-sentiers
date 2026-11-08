# Sentiers Vélo 🚴

Application mobile (web installable, « PWA ») pour créer des itinéraires vélo qui **évitent les routes au maximum**.

## Fonctionnalités

- **A → B** : départ + arrivée (recherche d'adresse, coordonnées « 45.76, 4.85 », « ma position » ou toucher la carte).
- **Boucle** : départ + distance souhaitée (5 à 150 km) + direction ; bouton « ↻ Autre » pour en proposer une différente. Les boucles sont de vraies boucles : calculées tronçon par tronçon, chaque tronçon évite les chemins déjà empruntés (zones pondérées BRouter), les culs-de-sac aux points de passage sont coupés, et plusieurs directions sont essayées pour garder celle qui a le moins d'allers-retours et la distance la plus juste. Le pourcentage de parcours emprunté deux fois est affiché sous le résultat.
- **Étapes** : touchez la carte ou un point d'intérêt → « Passer par ici ». L'étape est insérée au meilleur endroit. Départ, arrivée et étapes se déplacent en les faisant glisser.
- **Réglages** : *Éviter les routes* (faible / moyen / fort) et *Optimiser pour* (🌲 balade / ⚡ plus rapide / 📏 plus court), combinables. Dans « Plus d'options » : type de vélo (gravel-VTC, VTT, ville), éviter les côtes, privilégier forêts et rivières.
- **Calcul à la demande** : rien n'est calculé tant que vous n'appuyez pas sur « Calculer l'itinéraire ». Si vous changez un réglage ou déplacez un point, le tracé est grisé et le bouton propose « Recalculer ».
- **Interface mobile** : panneau à faire glisser au doigt (réduit / moitié / plein écran), gros bouton d'action toujours visible en bas, résultat affiché en premier une fois calculé.
- **Feuille de route** : liste de toutes les indications (« Tournez à gauche – km 3,2 »), consultable avant de partir.
- **Résultat** : distance, dénivelé, durée estimée, **% hors route**, tracé coloré (vert = chemins/pistes, orange = petites routes calmes, rouge = routes), profil altimétrique interactif.
- **Mes points d'intérêt** : ajout, modification, note, catégorie ; export/import JSON (pour les partager entre téléphones).
- **Suggestions** (OpenStreetMap) le long du parcours ou dans la zone visible : points de vue, nature, patrimoine, pique-nique, eau potable, réparation vélo, cafés, hébergement.
- **Mes parcours** : enregistrement local, export **GPX** (Garmin, Komoot, OsmAnd…).
- **Guidage virage par virage** (« 🧭 Démarrer le guidage ») : **vue 3D** inclinée qui tourne dans le sens de la marche, avec le relief (bouton 2D/3D), flèche et distance du prochain virage, annonces vocales en français (à ~150 m puis juste avant), vibrations, heure d'arrivée estimée, alerte « hors itinéraire » et recalcul depuis votre position (en repassant par vos étapes). L'écran reste allumé.
- **Cartes hors ligne** (« 📥 Hors ligne ») : télécharge le Plan IGN (licence ouverte) sur un couloir de 300 m autour du parcours, zooms 11 à 16 (environ 0,4 Mo/km). Sans réseau, l'app s'ouvre, affiche la carte téléchargée et la navigation fonctionne (le GPS ne nécessite pas internet). Gestion et suppression dans « Mes parcours ».
- **Partage entre amis** (« 🔗 Partager ») : un lien court qui ouvre le même parcours, avec les mêmes réglages et vos points d'intérêt proches du tracé, chez votre ami. **Import GPX** depuis Komoot, Strava, Garmin…
- **Créer un trajet** (bouton ⏺ sur la carte) : enregistre votre sortie au GPS (pause possible), « ⏹ Terminer » la range dans **✏️ Mes créations**, prête à être refaite en guidage, partagée ou exportée en GPX. Un enregistrement interrompu (application fermée) est proposé à la reprise au lancement suivant.
- **Signalements** (⚠️) : pendant une sortie (guidage ou enregistrement), le bouton ⚠️ en bas à droite signale en un geste un passage difficile, un obstacle, une zone interdite, un mauvais revêtement, de la boue, un danger… à votre position (note facultative). On peut aussi signaler en touchant la carte. Les signalements restent sur la carte (2D et 3D), sont rattachés à la sortie dans l'historique, inclus dans les GPX et les liens partagés, et le guidage vous prévient à la voix à l'approche (« Attention : zone interdite signalée dans 150 mètres »). Quand on passe sur un signalement existant, l'application demande **« Toujours là ? »** : *Non* le retire de la carte, *Oui* (ou pas de réponse en 25 s) le conserve, avec la date de confirmation. Liste et suppression dans l'onglet Lieux.
- **Historique automatique** (🕓) : chaque sortie faite avec le guidage, ou enregistrée, est gardée d'office avec la trace réelle, la distance, la durée et la vitesse moyenne (40 dernières sorties).
- Fonds de carte : CyclOSM (spécial vélo), OpenStreetMap, topographique.

Tout est stocké sur le téléphone (pas de compte, pas de serveur à vous).

**Mémoire :** à chaque lancement, l'application démarre vide. Seuls sont conservés : les parcours enregistrés, vos créations et l'historique des sorties (« Mes parcours »), vos signalements, vos points d'intérêt, les cartes hors ligne et vos réglages. Le trajet en cours est oublié quand on ferme l'application (il survit à un simple rechargement de la page pendant une sortie).

## Mettre l'application en ligne (gratuit, 2 minutes)

L'app doit être servie en **HTTPS** pour la géolocalisation et l'installation. Au choix :

**Netlify Drop (le plus simple)** : allez sur https://app.netlify.com/drop et glissez-déposez le dossier `velo-sentiers`. Vous obtenez une adresse `https://xxx.netlify.app`.

**GitHub Pages** : créez un dépôt, envoyez-y le contenu du dossier, puis *Settings → Pages → Deploy from branch (main, /root)*.

## L'installer sur le téléphone

- **Android (Chrome)** : ouvrez l'adresse → menu ⋮ → « Installer l'application » / « Ajouter à l'écran d'accueil ».
- **iPhone (Safari)** : ouvrez l'adresse → bouton Partager → « Sur l'écran d'accueil ».

## Tester sur l'ordinateur

```
cd velo-sentiers
python3 -m http.server 8000
```
puis ouvrez http://localhost:8000

## Services utilisés (gratuits, sans clé)

| Rôle | Service |
|---|---|
| Calcul d'itinéraire | [BRouter](https://brouter.de) — profil basé sur `gravel.brf` (licence MIT, voir `profiles/`), ajusté pour pénaliser les routes |
| Recherche d'adresse | [Géoplateforme IGN](https://geoservices.ign.fr/documentation/services/services-geoplateforme/geocodage) (France) + [Photon](https://photon.komoot.io) (monde), interrogés en parallèle |
| Points d'intérêt | [Overpass API](https://overpass-api.de) (OpenStreetMap, 4 serveurs essayés en cascade) + [Wikipédia](https://fr.wikipedia.org) (lieux géolocalisés) |
| Vue 3D | [MapLibre GL](https://maplibre.org) (chargé seulement au guidage 3D) + relief [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (données ouvertes) |
| Cartes | CyclOSM, OpenStreetMap, OpenTopoMap, Plan IGN (Géoplateforme, seul fond utilisé pour le hors ligne : les serveurs OpenStreetMap interdisent le téléchargement en masse) |

Chaque requête a un délai maximum et peut être annulée (bouton « Annuler »). Ce sont des services communautaires : merci d'en faire un usage raisonnable. Pour un usage intensif (beaucoup d'utilisateurs), il faudrait héberger son propre serveur BRouter.

## Structure

```
index.html            interface
style.css             styles (mobile d'abord, panneau latéral sur grand écran)
app.js                logique (carte, calcul, boucle, POI, sauvegarde, GPX)
extras.js             navigation guidée, cartes hors ligne, partage, import GPX
rides.js              enregistrement GPS de trajets, Mes créations, Historique
reports.js            signalements (carte, guidage, historique)
sw.js                 service worker (ouverture hors ligne)
manifest.webmanifest  installation sur l'écran d'accueil
profiles/gravel.brf   profil de calcul BRouter de base
icons/                icônes
```

---
Powered by **F.CHAZE**
