FROM node:26-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Dependencies first, so this layer is cached until package.json changes.
# .npmrc and package-lock.json are generated here instead of being copied from the host.
COPY diffcheck/package.json ./
RUN printf 'ignore-scripts=true\nfund=false\naudit-level=moderate\n' > .npmrc \
    && npm install --omit=dev \
    && npm cache clean --force

# Explicit copies, so a host-side node_modules can never leak into the image.
COPY diffcheck/server.js ./
COPY diffcheck/public ./public

EXPOSE 3000

USER nobody:nogroup

# Run node directly (not `npm start`) so nothing needs a writable HOME or npm cache.
CMD ["node", "server.js"]
