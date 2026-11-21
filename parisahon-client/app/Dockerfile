FROM node:16-alpine as build-stage

WORKDIR /app
RUN npm install -g pnpm@7.22.0
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm i
COPY . .

FROM build-stage as prod
CMD ["tail", "-f", "/dev/null"]
