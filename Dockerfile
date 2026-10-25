# Runs the GPU Finder MCP server over stdio. Used by Glama to build and inspect the server;
# end users normally run `npx -y gpufinder mcp` instead.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
USER node
# Set GPUFINDER_API_KEY at run time; tools/list works without it.
ENTRYPOINT ["node", "dist/cli.js", "mcp"]
