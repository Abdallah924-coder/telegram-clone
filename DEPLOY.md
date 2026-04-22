# Deploiement

## Variables utiles

L'application accepte ces variables pour stocker les donnees et medias sur un volume persistant :

- `DATA_FILE`
- `UPLOADS_DIR`
- `AVATARS_DIR`
- `PORT`

## Render

Le fichier `render.yaml` est pret.

Points importants :

- L'application a besoin d'un disque persistant pour conserver `data.json`, les avatars et les uploads.
- Le blueprint monte ce disque dans `/opt/render/project/src/storage`.
- Le service doit etre de type web Node avec `npm ci` puis `npm start`.

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

Sans stockage persistant, les messages, statuts, avatars et fichiers uploades seront perdus au redeploiement ou au redemarrage.
