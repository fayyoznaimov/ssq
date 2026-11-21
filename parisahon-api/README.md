# Amo-clone

CRM platform with tracking capabilities.

# Features

- Telegram integration
- Whatsapp integration
- Voip integration

# Dev setup

```
git clone https://github.com/NagaiMatsuge/parisahon-api.git
```

```
cd parisahon-api
cp .env.example .env
```

```
docker network create -d bridge my-network
```

```
docker compose up -d
```

```
docker exec -it main-app sh
npm run migration:run
```
