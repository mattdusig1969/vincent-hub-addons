ARG BUILD_FROM
FROM $BUILD_FROM
RUN apk add --no-cache nodejs
# Laid out exactly as in the product repository, so the service's relative paths hold.
COPY vincent /opt/vincent
WORKDIR /opt/vincent/apps/hub
CMD [ "node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/index.ts" ]
