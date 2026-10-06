FROM game-portal:0.1.1
WORKDIR /entry
COPY server.mjs ./server.mjs
USER 1000:1000
EXPOSE 3011
ENTRYPOINT ["node", "/entry/server.mjs"]
CMD []
