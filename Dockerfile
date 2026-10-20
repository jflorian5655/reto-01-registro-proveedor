FROM oven/bun:1.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "src/server.ts"]
