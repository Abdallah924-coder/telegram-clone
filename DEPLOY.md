# Deploiement

## Variables utiles

L'application accepte ces variables pour stocker les donnees et medias sur un volume persistant :

- `DATA_FILE`
- `UPLOADS_DIR`
- `AVATARS_DIR`
- `PORT`
- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `MONGODB_COLLECTION`
- `ADMIN_PSEUDO`
- `ADMIN_PASSWORD`
- `ADMIN_PHONE` ou `ADMIN_COUNTRY_CODE` + `ADMIN_PHONE_LOCAL`

## Render

Le fichier `render.yaml` est pret.

Points importants :

- Avec `MONGODB_URI`, les comptes, messages, groupes et statuts sont conserves dans MongoDB.
- Sans `MONGODB_URI`, l'application a besoin d'un disque persistant pour conserver `data.json`, les avatars et les uploads.
- Le blueprint monte ce disque dans `/opt/render/project/src/storage`.
- Le service doit etre de type web Node avec `npm ci` puis `npm start`.
- Renseignez `ADMIN_PASSWORD` pour eviter la generation d'un mot de passe admin temporaire dans les logs.

## Railway

Railway detecte deja `npm start`.

Configuration recommandee :

- Creer un volume.
- Monter le volume sur `/app/storage`.
- Definir les variables :
  - `DATA_FILE=/app/storage/data.json`
  - `UPLOADS_DIR=/app/storage/uploads`
  - `AVATARS_DIR=/app/storage/avatars`

## Important

- Avec MongoDB, seuls les medias restent sur le stockage disque si vous gardez les uploads locaux.
- Sans MongoDB ni stockage persistant, les messages, statuts, avatars et fichiers uploades seront perdus au redeploiement ou au redemarrage.
