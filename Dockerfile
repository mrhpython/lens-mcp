FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY mcp-server.cjs LICENSE README.md ./

# Hosted Lens API by default; override for a self-hosted deployment.
ENV SOULFIELD_API_BASE=https://api.soulfield.one

CMD ["node", "mcp-server.cjs"]
