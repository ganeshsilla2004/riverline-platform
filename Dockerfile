FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY seed-data ./seed-data

RUN npx tsc

EXPOSE 3000

CMD ["node", "dist/index.js"]
