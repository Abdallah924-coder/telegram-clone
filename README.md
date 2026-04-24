# DevChat

Messagerie temps reel style Telegram construite avec `Express`, `Socket.IO` et un frontend statique.

## Fonctions principales

- inscription/connexion avec numero de telephone
- messages prives, groupes, reactions et fichiers
- statuts visibles uniquement entre contacts mutuels
- canal discret de mises a jour gere par l'administrateur
- compte administrateur avec statistiques privees
- persistance MongoDB via `MONGODB_URI` avec fallback JSON local

## Lancement local

```bash
npm install
npm start
```

Variables recommandees :

- `MONGODB_URI`
- `ADMIN_PSEUDO`
- `ADMIN_PASSWORD`
