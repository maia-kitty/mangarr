FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY src src
COPY public public
ENV MANGARR_CONFIG=/config NODE_NO_WARNINGS=1
RUN mkdir /config && chown node:node /config
USER node
EXPOSE 8206
VOLUME /config
CMD ["node", "src/server.ts"]
