FROM node:18-alpine

WORKDIR /app

# Install build dependencies for sqlite3 native compilation on Alpine
RUN apk add --no-cache python3 make g++

COPY package*.json ./

RUN npm install --only=production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
