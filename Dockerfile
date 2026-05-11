FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY index.js ./
RUN mkdir -p data
ENV NODE_ENV=production
ENV PORT=3847
EXPOSE 3847
CMD ["node", "index.js"]
